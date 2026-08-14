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

import { request as httpsRequest } from 'node:https'
import {
  readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, chmodSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann' // Codex CLI's published client id
const FALLBACK_VERSION = '0.130.0'
const AUTH_PATH = join(homedir(), '.codex', 'auth.json')
const VERSION_PATH = join(homedir(), '.codex', 'version.json')
const TOTAL_TIMEOUT_MS = 180_000
const CONNECT_TIMEOUT_MS = 30_000
const STALL_TIMEOUT_MS = 90_000
const MAX_IMAGE_BYTES = 15 * 1024 * 1024

const verbose = process.env.CG_VERBOSE === '1'
const log = (msg) => { if (verbose) console.error(msg) }

function die(message) {
  console.log(JSON.stringify({ ok: false, error: String(message) }))
  process.exit(1)
}

function readAuthJson() {
  try {
    if (!existsSync(AUTH_PATH)) return {}
    const raw = JSON.parse(readFileSync(AUTH_PATH, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function persistAuth(auth) {
  try {
    mkdirSync(dirname(AUTH_PATH), { recursive: true })
    const tmp = AUTH_PATH + '.tmp-' + randomUUID()
    writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, AUTH_PATH)
  } catch (err) {
    log('warning: could not persist refreshed tokens: ' + err)
  }
}

function detectVersion() {
  let floor = FALLBACK_VERSION
  try {
    if (existsSync(VERSION_PATH)) {
      const v = JSON.parse(readFileSync(VERSION_PATH, 'utf8')).latest_version
      if (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)) {
        const a = v.split('.').map(Number)
        const b = floor.split('.').map(Number)
        for (let i = 0; i < 3; i++) {
          if (a[i] > b[i]) { floor = v; break }
          if (a[i] < b[i]) break
        }
      }
    }
  } catch { /* best-effort */ }
  return floor
}

function mimeFor(path) {
  const ext = path.split('.').pop().toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return null
}

function jsonRequest(url, { method = 'POST', headers = {}, body = null, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpsRequest(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolvePromise({ status: res.statusCode, body: Buffer.concat(chunks) }))
      res.on('error', (err) => rejectPromise({ message: 'response error: ' + err.message }))
    })
    req.on('timeout', () => req.destroy(new Error('connect timeout')))
    req.on('error', (err) => rejectPromise({ message: 'network error: ' + err.message }))
    if (body !== null) req.write(body)
    req.end()
  })
}

function refreshAccessToken(refreshToken) {
  const form = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'openid profile email',
  })
  return jsonRequest(OAUTH_TOKEN_URL, {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': `codex_cli_rs/${FALLBACK_VERSION} codex-vision`,
    },
    body: form.toString(),
  })
}

function buildHeaders(accessToken, accountId, version) {
  const sid = randomUUID()
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'Accept': 'text/event-stream',
    'Connection': 'Keep-Alive',
    'version': version,
    'session_id': sid,
    'x-client-request-id': sid,
    'User-Agent': `codex_cli_rs/${version} (Mac OS 26.0.1; arm64) codex-vision`,
    'originator': 'codex_cli_rs',
  }
  if (accountId) headers['chatgpt-account-id'] = accountId
  return headers
}

// Same SSE streaming shape as codex-imagegen.mjs: wall-clock deadline plus a
// stall watchdog via AbortController, queue of parsed JSON events.
async function* streamSSE(url, headers, body) {
  const ac = new AbortController()
  const deadline = Date.now() + TOTAL_TIMEOUT_MS
  const queue = []
  let done = false
  let lastRead = Date.now()

  const timer = setInterval(() => {
    if (Date.now() - lastRead > STALL_TIMEOUT_MS) {
      ac.abort(new Error('stalled: no data for ' + (STALL_TIMEOUT_MS / 1000) + 's'))
    }
  }, 5000)

  const req = httpsRequest(url, {
    method: 'POST',
    headers,
    timeout: Math.min(CONNECT_TIMEOUT_MS, Math.max(1000, deadline - Date.now())),
    signal: ac.signal,
  }, (res) => {
    if (res.statusCode !== 200) {
      res.resume()
      res.on('end', () => {
        queue.push({ error: new Error(`HTTP ${res.statusCode} from ${url}`) })
        done = true
      })
      return
    }
    let buffer = ''
    res.on('data', (chunk) => {
      lastRead = Date.now()
      buffer += chunk.toString('utf8')
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        if (line === '') continue
        if (line.startsWith('data:')) {
          const payload = line.slice(5).replace(/^ /, '')
          if (payload === '[DONE]') { done = true; return }
          try {
            queue.push({ event: JSON.parse(payload) })
          } catch {
            log('warning: skipped malformed SSE payload')
          }
        }
      }
    })
    res.on('end', () => { done = true })
    res.on('error', (err) => { queue.push({ error: err }); done = true })
  })
  req.on('error', (err) => { queue.push({ error: err }); done = true })
  req.write(body)
  req.end()

  try {
    while (!done || queue.length > 0) {
      if (queue.length > 0) {
        const item = queue.shift()
        if (item.error) throw item.error
        yield item.event
        continue
      }
      if (Date.now() > deadline) {
        throw new Error('timed out: no answer within the total budget')
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  } finally {
    clearInterval(timer)
    ac.abort()
  }
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
  const headers = buildHeaders(accessToken, accountId, version)
  const saw = new Set()
  const parts = []
  let failureDetail = null
  for await (const evt of streamSSE(CODEX_RESPONSES_URL, headers, JSON.stringify(payload))) {
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

  const auth = readAuthJson()
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
          const refreshed = await refreshAccessToken(refreshToken)
          if (!refreshed.body || refreshed.status >= 400) {
            const parsed = safeJson(refreshed.body)
            die('token refresh failed: HTTP ' + refreshed.status + (parsed?.error ? ` (${parsed.error})` : ''))
          }
          const data = safeJson(refreshed.body) || {}
          if (typeof data.access_token === 'string') {
            accessToken = data.access_token
            const nextAuth = readAuthJson()
            const nextTokens = nextAuth.tokens && typeof nextAuth.tokens === 'object' ? nextAuth.tokens : {}
            if (typeof data.access_token === 'string') nextTokens.access_token = data.access_token
            if (typeof data.refresh_token === 'string') nextTokens.refresh_token = data.refresh_token
            if (typeof data.id_token === 'string') nextTokens.id_token = data.id_token
            nextAuth.tokens = nextTokens
            nextAuth.last_refresh = new Date().toISOString()
            persistAuth(nextAuth)
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

function safeJson(buf) {
  try { return JSON.parse(buf.toString('utf8')) } catch { return null }
}

main().catch((err) => die(err && err.message ? err.message : String(err)))
