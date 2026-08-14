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

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
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

const TOTAL_TIMEOUT_MS = 300_000
const STALL_TIMEOUT_MS = 120_000

const verbose = process.env.CG_VERBOSE === '1'
const log = (msg) => { if (verbose) console.error(msg) }

function die(message) {
  console.log(JSON.stringify({ ok: false, error: String(message) }))
  process.exit(1)
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
  const headers = buildHeaders(accessToken, accountId, version, 'codex-imagegen')
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

  const authPath = defaultAuthPath()
  const auth = readAuthJson(authPath)
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
          const refreshed = await refreshAccessToken(refreshToken, 'codex-imagegen')
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
