// Shared Codex CLI login and Responses transport helpers.
//
// This module only consumes the Codex CLI's existing login state. It does not
// implement login, register a provider, or expose credentials to the browser.

import { request as httpsRequest } from 'node:https'
import {
  readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, chmodSync, lstatSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, relative, resolve, isAbsolute, sep, win32 } from 'node:path'
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

function workspaceRoot() {
  return resolve(process.cwd())
}

function assertWorkspaceRelative(input, label) {
  if (typeof input !== 'string' || !input.trim()) throw new Error(`${label} is required`)
  if (input.includes('\0')) throw new Error(`${label} contains an invalid character`)
  if (isAbsolute(input) || win32.isAbsolute(input) || /^[A-Za-z]:/.test(input)) throw new Error(`${label} must be relative to the workspace`)
  const parts = input.split(/[\\/]+/)
  if (parts.includes('..')) throw new Error(`${label} must not contain parent-directory segments`)
  const root = workspaceRoot()
  const target = resolve(root, input)
  const rel = relative(root, target)
  const parentPrefix = process.platform === 'win32' ? '..\\' : '../'
  if (!rel || rel === '..' || rel.startsWith(parentPrefix) || isAbsolute(rel)) {
    throw new Error(`${label} must stay inside the workspace`)
  }
  return { root, target }
}

export function resolveWorkspacePath(input, label = 'path') {
  return assertWorkspaceRelative(input, label).target
}

export function workspaceRelativePath(target) {
  const root = workspaceRoot()
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('path is outside the workspace')
  return rel.split(sep).join('/')
}

function assertDirectoryChain(root, target) {
  const rel = relative(root, target)
  let current = root
  for (const part of rel.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part)
    let info
    try {
      info = lstatSync(current)
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
      try {
        mkdirSync(current)
      } catch (mkdirErr) {
        if (mkdirErr?.code !== 'EEXIST') throw mkdirErr
      }
      info = lstatSync(current)
    }
    if (info.isSymbolicLink()) throw new Error('workspace path must not contain symbolic links')
    if (!info.isDirectory()) throw new Error('workspace output parent is not a directory')
  }
}

export function prepareWorkspaceOutput(input, label = 'output path') {
  const { root, target } = assertWorkspaceRelative(input, label)
  assertDirectoryChain(root, dirname(target))
  try {
    if (lstatSync(target)) throw new Error(`${label} already exists`)
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  return target
}

export function resolveWorkspaceFile(input, label = 'image path') {
  const { root, target } = assertWorkspaceRelative(input, label)
  const rel = relative(root, target)
  let current = root
  for (const part of rel.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part)
    const info = lstatSync(current)
    if (info.isSymbolicLink()) throw new Error(`${label} must not use symbolic links`)
    if (current === target && !info.isFile()) throw new Error(`${label} must be a regular file`)
    if (current !== target && !info.isDirectory()) throw new Error(`${label} parent is not a directory`)
  }
  return target
}

export function writeNewWorkspaceFile(target, bytes) {
  writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 })
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
  }
}

// One HTTPS JSON request; resolves { status, body } or rejects with { message }.
export function jsonRequest(url, { method = 'POST', headers = {}, body = null, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let req
    const timer = setTimeout(() => req?.destroy(new Error('request timeout')), timeoutMs)
    const resolveOnce = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }
    const rejectOnce = (message) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise({ message })
    }
    req = httpsRequest(url, {
      method,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolveOnce({ status: res.statusCode, body: Buffer.concat(chunks) }))
      res.on('error', (err) => rejectOnce('response error: ' + err.message))
    })
    req.on('timeout', () => req.destroy(new Error('connect timeout')))
    req.on('error', (err) => rejectOnce('network error: ' + err.message))
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

export function buildHeaders(accessToken, version, clientName = 'codex') {
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
    const parseLine = (rawLine) => {
      const line = rawLine.replace(/\r$/, '')
      if (!line || !line.startsWith('data:')) return
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
    res.on('data', (chunk) => {
      lastRead = Date.now()
      buffer += chunk.toString('utf8')
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        parseLine(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
      }
    })
    res.on('end', () => {
      if (buffer) parseLine(buffer)
      done = true
    })
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
