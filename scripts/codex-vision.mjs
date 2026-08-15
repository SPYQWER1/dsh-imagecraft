#!/usr/bin/env node
// codex-vision.mjs — image understanding through the ChatGPT Codex backend,
// using the ChatGPT OAuth login state (Codex CLI auth). This is the vision
// counterpart of codex-imagegen.mjs: instead of generating an image, it sends
// a local image as a multimodal `input_image` content part and returns the
// model's textual description. It gives text-only models (e.g.
// deepseek-v4-flash) plug-in vision without any external API key.
//
// Inputs come from the environment so no shell quoting can corrupt them:
//   VG_IMAGE      image path relative to the workspace (required; png,
//                 jpeg/jpg, webp, gif)
//   VG_QUESTION   optional focus question (default: describe the image)
//   VG_MODEL      model id (default gpt-5.5)
//   CODEX_ACCESS_TOKEN / CODEX_REFRESH_TOKEN — same auth precedence as
//                 codex-imagegen.mjs (env > CODEX_HOME/auth.json
//                 or ~/.codex/auth.json), with one OAuth refresh + retry on
//                 HTTP 401. Images are capped at 15 MiB and stay in the workspace.
//
// stdout: one JSON line { ok, text, model, error?, ... }.
// Exit code: 0 on success, 1 on failure.

import { readFileSync, openSync, closeSync, constants } from 'node:fs'
import {
  CODEX_RESPONSES_URL,
  resolveWorkspaceFile,
  workspaceRelativePath,
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
const MAX_QUESTION_CHARS = 10_000

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

async function answerOnce(accessToken, version, payload) {
  const headers = buildHeaders(accessToken, version, 'codex-vision')
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
  const imagePath = String(process.env.VG_IMAGE || '').trim()
  if (!imagePath) die('VG_IMAGE is required')
  const question = process.env.VG_QUESTION || ''
  const model = String(process.env.VG_MODEL || 'gpt-5.5').trim()
  if (question.length > MAX_QUESTION_CHARS) die(`VG_QUESTION must be at most ${MAX_QUESTION_CHARS} characters`)
  if (!model || model.length > 200) die('VG_MODEL must be between 1 and 200 characters')

  let target
  try {
    target = resolveWorkspaceFile(imagePath, 'VG_IMAGE')
  } catch (err) {
    die(err.code === 'ENOENT' ? 'image_not_found' : 'invalid_path')
  }
  const mime = mimeFor(target)
  if (!mime) die('invalid_format')
  let fd
  let bytes
  try {
    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    bytes = readFileSync(fd)
  } catch {
    die('invalid_path')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  if (bytes.length > MAX_IMAGE_BYTES) die('image_too_large')
  const imageDataUrl = `data:${mime};base64,${bytes.toString('base64')}`

  const authPath = defaultAuthPath()
  const auth = readAuthJson(authPath)
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : {}
  let accessToken = process.env.CODEX_ACCESS_TOKEN || tokens.access_token || null
  const refreshToken = process.env.CODEX_REFRESH_TOKEN || tokens.refresh_token || null
  if (!accessToken) die('auth_failed')

  const version = detectVersion()
  const payload = buildPayload(imageDataUrl, question, model)

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = await answerOnce(accessToken, version, payload)
      console.log(JSON.stringify({ ok: true, text, model, image: workspaceRelativePath(target) }))
      return
    } catch (err) {
      const isAuthError = /401/.test(String(err && err.message))
      if (isAuthError && refreshToken && attempt === 1) {
        log('access token rejected; refreshing via OAuth')
        try {
          const refreshed = await refreshAccessToken(refreshToken, 'codex-vision')
          if (!refreshed.body || refreshed.status >= 400) {
            die('auth_failed')
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
        } catch {
          die('auth_failed')
        }
      }
      die(isAuthError ? 'auth_failed' : 'backend_unavailable')
    }
  }
}

main().catch(() => die('backend_unavailable'))
