#!/usr/bin/env node
// codex-imagegen.mjs — headless image generation through the ChatGPT Codex
// backend (https://chatgpt.com/backend-api/codex/responses), using the
// ChatGPT OAuth login state (Codex CLI auth) instead of an OpenAI API key.
//
// This is the DeepSeek Harness-owned transport implementation for the
// `image_gen` model tool. It implements the same public wire protocol the
// official Codex CLI uses (OAuth token refresh + Responses API SSE stream),
// with zero npm dependencies (Node built-in https only).
//
// Inputs come from the environment so no shell quoting can corrupt them:
//   CG_PROMPT        the image prompt (required)
//   CG_OUT           output path, absolute or relative to cwd (required)
//   CG_SIZE          "auto" or WIDTHxHEIGHT (optional)
//   CG_FORMAT        png | jpeg | webp (default png)
//   CG_MODEL         model id (default gpt-5.5)
//   CODEX_ACCESS_TOKEN   ChatGPT OAuth access token (optional; falls back to
//                        ~/.codex/auth.json)
//   CODEX_REFRESH_TOKEN  ChatGPT OAuth refresh token (optional; falls back to
//                        ~/.codex/auth.json)
//   CODEX_ACCOUNT_ID     ChatGPT account id (optional)
//
// Auth precedence: env tokens > ~/.codex/auth.json. When the access token is
// rejected (HTTP 401), the script refreshes it once via
// https://auth.openai.com/oauth/token and retries; refreshed tokens are
// persisted back to ~/.codex/auth.json (atomic, 0600) so the Codex CLI and
// every later call share them.
//
// stdout: one JSON line { ok, outputPath, bytes, error?, ... }.
// stderr: progress lines only when CG_VERBOSE=1.
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
const TOTAL_TIMEOUT_MS = 300_000
const CONNECT_TIMEOUT_MS = 30_000
const STALL_TIMEOUT_MS = 120_000

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

// One HTTPS JSON request; resolves { status, body } or rejects with
// { status?, message }. `body` may be a string or Buffer.
function jsonRequest(url, { method = 'POST', headers = {}, body = null, timeoutMs = CONNECT_TIMEOUT_MS, readTimeoutMs = null } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpsRequest(url, {
      method,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        resolvePromise({ status: res.statusCode, body: Buffer.concat(chunks) })
      })
      res.on('error', (err) => rejectPromise({ message: 'response error: ' + err.message }))
      if (readTimeoutMs !== null) {
        // Loosen the per-read idle window; the overall deadline is enforced
        // by the stream loop below.
        res.setTimeout(readTimeoutMs, () => {
          res.destroy(new Error('read timeout'))
        })
      }
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
      'User-Agent': `codex_cli_rs/${FALLBACK_VERSION} codex-imagegen`,
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
    'User-Agent': `codex_cli_rs/${version} (Mac OS 26.0.1; arm64) codex-imagegen`,
    'originator': 'codex_cli_rs',
  }
  if (accountId) headers['chatgpt-account-id'] = accountId
  return headers
}

// Stream the responses endpoint and yield parsed SSE JSON events.
// Node https does not expose a per-read timeout after connect; we enforce the
// wall-clock deadline here and treat any read that stalls past STALL_TIMEOUT
// as dead via an AbortController shared with the socket.
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
        if (line === '') {
          // SSE event boundary; nothing to do for the parser below.
          continue
        }
        if (line.startsWith('data:')) {
          const payload = line.slice(5).replace(/^ /, '')
          if (payload === '[DONE]') {
            done = true
            return
          }
          try {
            queue.push({ event: JSON.parse(payload) })
          } catch {
            log('warning: skipped malformed SSE payload')
          }
        }
        // comment/event:/id: lines are ignored
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
        throw new Error('timed out: no image within the total budget')
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  } finally {
    clearInterval(timer)
    ac.abort()
  }
}

function buildPayload(prompt, size, format, model) {
  const imageTool = { type: 'image_generation', output_format: format }
  if (size && size !== 'auto') imageTool.size = size
  let userText =
    `Use the image_generation tool to render the following. Request: ${prompt}. ` +
    `Output format: ${format}.`
  if (size && size !== 'auto') userText += ` Size: ${size}.`
  userText += ' Do not include explanatory text — produce only the image.'
  return {
    model,
    stream: true,
    instructions: 'You are an image generation assistant.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] }],
    tools: [imageTool],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    reasoning: { effort: 'low', summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    text: { verbosity: 'low' },
  }
}

async function generateOnce(accessToken, accountId, version, payload) {
  const headers = buildHeaders(accessToken, accountId, version)
  const saw = new Set()
  let imageB64 = null
  let failureDetail = null
  let revisedPrompt = null
  for await (const evt of streamSSE(CODEX_RESPONSES_URL, headers, JSON.stringify(payload))) {
    const type = evt.type
    if (typeof type === 'string') saw.add(type)
    if (type === 'error' || type === 'response.failed') {
      const detail =
        evt.response?.error?.message ?? evt.response?.error?.code ??
        evt.message ?? evt.code ?? (typeof evt.error === 'string' ? evt.error : evt.error?.message)
      if (detail) failureDetail = String(detail)
    }
    if (type === 'response.output_item.done' && evt.item && evt.item.type === 'image_generation_call') {
      if (typeof evt.item.result === 'string') {
        imageB64 = evt.item.result
        if (typeof evt.item.revised_prompt === 'string') revisedPrompt = evt.item.revised_prompt
      }
    }
  }
  if (!imageB64) {
    const seen = [...saw].sort().join(', ') || '(none)'
    throw new Error(failureDetail ? `backend failed mid-generation: ${failureDetail} (events: ${seen})` : `no image returned (events: ${seen})`)
  }
  return { bytes: Buffer.from(imageB64, 'base64'), revisedPrompt }
}

async function main() {
  const prompt = process.env.CG_PROMPT
  const out = process.env.CG_OUT
  if (!prompt || !out) die('CG_PROMPT and CG_OUT are required')
  const size = process.env.CG_SIZE || 'auto'
  const format = process.env.CG_FORMAT || 'png'
  const model = process.env.CG_MODEL || 'gpt-5.5'
  if (!/^(png|jpeg|webp)$/.test(format)) die('format must be png, jpeg, or webp')
  if (size !== 'auto' && !/^\d+x\d+$/.test(size)) die('size must be auto or WIDTHxHEIGHT')

  const auth = readAuthJson()
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : {}
  let accessToken = process.env.CODEX_ACCESS_TOKEN || tokens.access_token || null
  const refreshToken = process.env.CODEX_REFRESH_TOKEN || tokens.refresh_token || null
  const accountId = process.env.CODEX_ACCOUNT_ID || tokens.account_id || null
  if (!accessToken) die('no ChatGPT OAuth access token: set CODEX_ACCESS_TOKEN or run `codex login`')

  const version = detectVersion()
  const payload = buildPayload(prompt, size, format, model)

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { bytes, revisedPrompt } = await generateOnce(accessToken, accountId, version, payload)
      const target = resolve(out)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
      console.log(JSON.stringify({
        ok: true,
        outputPath: target,
        bytes: bytes.length,
        revisedPrompt,
        model,
      }))
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
