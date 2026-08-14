#!/usr/bin/env node
// codex-vision.mjs — image understanding through the ChatGPT Codex backend,
// using the ChatGPT OAuth login state (Codex CLI auth). This is the vision
// counterpart of codex-imagegen.mjs: instead of generating an image, it sends
// a local image as a multimodal `input_image` content part and returns the
// model's textual description. It gives text-only models (e.g.
// deepseek-v4-flash) plug-in vision without any external API key.
//
// Inputs come from the environment so no shell quoting can corrupt them:
//   VG_IMAGE      image path, absolute or relative to cwd (required; png,
//                 jpeg/jpg, webp, gif)
//   VG_QUESTION   optional focus question (default: describe the image)
//   VG_MODEL      model id (default gpt-5.5)
//   CODEX_ACCESS_TOKEN / CODEX_REFRESH_TOKEN / CODEX_ACCOUNT_ID — same auth
//                 precedence as codex-imagegen.mjs (env > ~/.codex/auth.json),
//                 with one OAuth refresh + retry on HTTP 401.
//
// stdout: one JSON line { ok, text, model, error?, ... }.
// Exit code: 0 on success, 1 on failure.

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CODEX_RESPONSES_URL,
  defaultAuthPath,
  readAuthJson,
  persistAuth,
  detectVersion,
  refreshAccessToken,
  buildHeaders,
  streamSSE,
  safeJson,
} from './codex-common.mjs'

const TOTAL_TIMEOUT_MS = 180_000
const STALL_TIMEOUT_MS = 90_000
const MAX_IMAGE_BYTES = 15 * 1024 * 1024

const verbose = process.env.CG_VERBOSE === '1'
const log = (msg) => { if (verbose) console.error(msg) }

function die(message) {
  console.log(JSON.stringify({ ok: false, error: String(message) }))
  process.exit(1)
}

function mimeFor(path) {
  const ext = path.split('.').pop().toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return null
}

function buildPayload(imageDataUrl, question, model) {
  const text = question
    ? `${question} Describe what you see in the attached image and answer the question.`
    : 'Describe this image in detail: subjects, style, composition, colors, and any visible text (quote text verbatim).'
  return {
    model,
    stream: true,
    instructions: 'You are an image analysis assistant. Answer in the language of the question or request.',
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_image', image_url: imageDataUrl },
        { type: 'input_text', text },
      ],
    }],
    store: false,
    reasoning: { effort: 'low', summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    text: { verbosity: 'low' },
  }
}

async function answerOnce(accessToken, accountId, version, payload) {
  const headers = buildHeaders(accessToken, accountId, version, 'codex-vision')
  const saw = new Set()
  const parts = []
  let failureDetail = null
  for await (const evt of streamSSE(CODEX_RESPONSES_URL, headers, JSON.stringify(payload), {
    totalTimeoutMs: TOTAL_TIMEOUT_MS,
    stallTimeoutMs: STALL_TIMEOUT_MS,
  })) {
    const type = evt.type
    if (typeof type === 'string') saw.add(type)
    if (type === 'error' || type === 'response.failed') {
      const detail =
        evt.response?.error?.message ?? evt.response?.error?.code ??
        evt.message ?? evt.code ?? (typeof evt.error === 'string' ? evt.error : evt.error?.message)
      if (detail) failureDetail = String(detail)
    }
    if (type === 'response.output_text.delta' && typeof evt.delta === 'string') {
      parts.push(evt.delta)
    }
    if (type === 'response.output_text.done' && evt.item && typeof evt.item.text === 'string') {
      parts.push(evt.item.text)
    }
  }
  const text = parts.join('').trim()
  if (!text) {
    const seen = [...saw].sort().join(', ') || '(none)'
    throw new Error(failureDetail ? `backend failed: ${failureDetail} (events: ${seen})` : `no text answer returned (events: ${seen})`)
  }
  return text
}

async function main() {
  const imagePath = process.env.VG_IMAGE
  if (!imagePath) die('VG_IMAGE is required')
  const question = process.env.VG_QUESTION || ''
  const model = process.env.VG_MODEL || 'gpt-5.5'

  const target = resolve(imagePath)
  if (!existsSync(target)) die(`image not found: ${target}`)
  const mime = mimeFor(target)
  if (!mime) die('unsupported image type (need png, jpeg, webp, or gif)')
  const bytes = readFileSync(target)
  if (bytes.length > MAX_IMAGE_BYTES) {
    die(`image is ${(bytes.length / 1024 / 1024).toFixed(1)}MB; the cap is ${MAX_IMAGE_BYTES / 1024 / 1024}MB`)
  }
  const imageDataUrl = `data:${mime};base64,${bytes.toString('base64')}`

  const authPath = defaultAuthPath()
  const auth = readAuthJson(authPath)
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : {}
  let accessToken = process.env.CODEX_ACCESS_TOKEN || tokens.access_token || null
  const refreshToken = process.env.CODEX_REFRESH_TOKEN || tokens.refresh_token || null
  const accountId = process.env.CODEX_ACCOUNT_ID || tokens.account_id || null
  if (!accessToken) die('no ChatGPT OAuth access token: set CODEX_ACCESS_TOKEN or run `codex login`')

  const version = detectVersion()
  const payload = buildPayload(imageDataUrl, question, model)

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = await answerOnce(accessToken, accountId, version, payload)
      console.log(JSON.stringify({ ok: true, text, model, image: target }))
      return
    } catch (err) {
      const isAuthError = /401/.test(String(err && err.message))
      if (isAuthError && refreshToken && attempt === 1) {
        log('access token rejected; refreshing via OAuth')
        try {
          const refreshed = await refreshAccessToken(refreshToken, 'codex-vision')
          if (!refreshed.body || refreshed.status >= 400) {
            const parsed = safeJson(refreshed.body)
            die('token refresh failed: HTTP ' + refreshed.status + (parsed?.error ? ` (${parsed.error})` : ''))
          }
          const data = safeJson(refreshed.body) || {}
          if (typeof data.access_token === 'string') {
            accessToken = data.access_token
            const nextAuth = readAuthJson(authPath)
            const nextTokens = nextAuth.tokens && typeof nextAuth.tokens === 'object' ? nextAuth.tokens : {}
            if (typeof data.access_token === 'string') nextTokens.access_token = data.access_token
            if (typeof data.refresh_token === 'string') nextTokens.refresh_token = data.refresh_token
            if (typeof data.id_token === 'string') nextTokens.id_token = data.id_token
            nextAuth.tokens = nextTokens
            nextAuth.last_refresh = new Date().toISOString()
            persistAuth(nextAuth, authPath)
            continue
          }
          die('token refresh succeeded but returned no access_token')
        } catch (refreshErr) {
          die('token refresh failed: ' + (refreshErr.message || refreshErr))
        }
      }
      die(err && err.message ? err.message : String(err))
    }
  }
}

main().catch((err) => die(err && err.message ? err.message : String(err)))
