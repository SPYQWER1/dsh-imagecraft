// Shared Codex CLI login and Responses transport helpers.
//
// This module only consumes the Codex CLI's existing login state. It does not
// implement login, register a provider, or expose credentials to the browser.

import { request as httpsRequest } from 'node:https'
import {
  readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, chmodSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
export const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const FALLBACK_VERSION = '0.130.0'
export const TOTAL_TIMEOUT_MS = 300_000
export const CONNECT_TIMEOUT_MS = 30_000
export const STALL_TIMEOUT_MS = 120_000

const verbose = process.env.CG_VERBOSE === '1'
const log = (msg) => { if (verbose) console.error(msg) }

export function defaultAuthPath(env = process.env) {
  const home = env.CODEX_HOME
  return home ? join(home, 'auth.json') : join(homedir(), '.codex', 'auth.json')
}

export function defaultVersionPath(env = process.env) {
  const home = env.CODEX_HOME
  return home ? join(home, 'version.json') : join(homedir(), '.codex', 'version.json')
}

export function readAuthJson(authPath = defaultAuthPath()) {
  try {
    if (!existsSync(authPath)) return {}
    const raw = JSON.parse(readFileSync(authPath, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export function persistAuth(auth, authPath = defaultAuthPath()) {
  try {
    mkdirSync(dirname(authPath), { recursive: true })
    const tmp = authPath + '.tmp-' + randomUUID()
    writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, authPath)
  } catch (err) {
    log('warning: could not persist refreshed tokens: ' + err)
  }
}

export function detectVersion(versionPath = defaultVersionPath()) {
  let floor = FALLBACK_VERSION
  try {
    if (existsSync(versionPath)) {
      const v = JSON.parse(readFileSync(versionPath, 'utf8')).latest_version
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

export function resolveCodexAuth(env = process.env, authPath = defaultAuthPath(env)) {
  const auth = readAuthJson(authPath)
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : {}
  return {
    auth,
    authPath,
    accessToken: env.CODEX_ACCESS_TOKEN || tokens.access_token || null,
    refreshToken: env.CODEX_REFRESH_TOKEN || tokens.refresh_token || null,
    accountId: env.CODEX_ACCOUNT_ID || tokens.account_id || null,
  }
}

// One HTTPS JSON request; resolves { status, body } or rejects with { message }.
export function jsonRequest(url, { method = 'POST', headers = {}, body = null, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpsRequest(url, {
      method,
      headers,
      timeout: timeoutMs,
    }, (res) => {
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

export function refreshAccessToken(refreshToken, clientName = 'codex') {
  const form = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'openid profile email',
  })
  return jsonRequest(OAUTH_TOKEN_URL, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': `codex_cli_rs/${FALLBACK_VERSION} ${clientName}`,
    },
    body: form.toString(),
  })
}

export function buildHeaders(accessToken, accountId, version, clientName = 'codex') {
  const sid = randomUUID()
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Accept: 'text/event-stream',
    Connection: 'Keep-Alive',
    version,
    session_id: sid,
    'x-client-request-id': sid,
    'User-Agent': `codex_cli_rs/${version} (Mac OS 26.0.1; arm64) ${clientName}`,
    originator: 'codex_cli_rs',
  }
  if (accountId) headers['chatgpt-account-id'] = accountId
  return headers
}

// Stream parsed SSE JSON events with both a wall-clock deadline and a stall
// watchdog. The endpoint is unofficial and can change, so malformed events
// are ignored while protocol/network errors remain actionable.
export async function* streamSSE(
  url,
  headers,
  body,
  { totalTimeoutMs = TOTAL_TIMEOUT_MS, stallTimeoutMs = STALL_TIMEOUT_MS } = {},
) {
  const ac = new AbortController()
  const deadline = Date.now() + totalTimeoutMs
  const queue = []
  let done = false
  let lastRead = Date.now()

  const timer = setInterval(() => {
    if (Date.now() - lastRead > stallTimeoutMs) {
      ac.abort(new Error('stalled: no data for ' + (stallTimeoutMs / 1000) + 's'))
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
        if (!line || !line.startsWith('data:')) continue
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
      if (Date.now() > deadline) throw new Error('timed out: no response within the total budget')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } finally {
    clearInterval(timer)
    ac.abort()
  }
}

export function safeJson(buf) {
  try { return JSON.parse(buf.toString('utf8')) } catch { return null }
}
