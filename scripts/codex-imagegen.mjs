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
//   CG_OUT           output path relative to the workspace (required)
//   CG_SIZE          one of the supported dimensions or "auto" (optional)
//   CG_FORMAT        png | jpeg | webp (default png)
//   CG_MODEL         model id (default gpt-5.5)
//   CODEX_ACCESS_TOKEN   ChatGPT OAuth access token (optional; falls back to
//                        ~/.codex/auth.json)
//   CODEX_REFRESH_TOKEN  ChatGPT OAuth refresh token (optional; falls back to
//                        ~/.codex/auth.json)
//
// Auth precedence: env tokens > $CODEX_HOME/auth.json or ~/.codex/auth.json.
// When the access token is rejected (HTTP 401), the script refreshes it once
// via https://auth.openai.com/oauth/token and retries; refreshed tokens are
// persisted back to the selected auth file (atomic, 0600).
//
// stdout: one JSON line { ok, outputPath: workspace-relative, bytes, error?, ... }.
// stderr: progress lines only when CG_VERBOSE=1.
// Exit code: 0 on success, 1 on failure.

import {
  CODEX_RESPONSES_URL,
  prepareWorkspaceOutput,
  workspaceRelativePath,
  writeNewWorkspaceFile,
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
const MAX_PROMPT_CHARS = 20_000
const ALLOWED_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', 'auto'])

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

async function generateOnce(accessToken, version, payload) {
  const headers = buildHeaders(accessToken, version, 'codex-imagegen')
  const saw = new Set()
  let imageB64 = null
  let failureDetail = null
  let revisedPrompt = null
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
  const prompt = String(process.env.CG_PROMPT || '').trim()
  const out = String(process.env.CG_OUT || '').trim()
  if (!prompt || !out) die('CG_PROMPT and CG_OUT are required')
  if (prompt.length > MAX_PROMPT_CHARS) die(`CG_PROMPT must be at most ${MAX_PROMPT_CHARS} characters`)
  const size = process.env.CG_SIZE || 'auto'
  const format = process.env.CG_FORMAT || 'png'
  const model = String(process.env.CG_MODEL || 'gpt-5.5').trim()
  if (!/^(png|jpeg|webp)$/.test(format)) die('format must be png, jpeg, or webp')
  if (!ALLOWED_SIZES.has(size)) die('size must be one of 1024x1024, 1536x1024, 1024x1536, 2048x2048, 2048x1152, auto')
  if (!model || model.length > 200) die('CG_MODEL must be between 1 and 200 characters')
  try {
    prepareWorkspaceOutput(out, 'CG_OUT')
  } catch (err) {
    die(/already exists/i.test(String(err?.message)) ? 'output_exists' : 'invalid_path')
  }

  const authPath = defaultAuthPath()
  const auth = readAuthJson(authPath)
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : {}
  let accessToken = process.env.CODEX_ACCESS_TOKEN || tokens.access_token || null
  const refreshToken = process.env.CODEX_REFRESH_TOKEN || tokens.refresh_token || null
  if (!accessToken) die('auth_failed')

  const version = detectVersion()
  const payload = buildPayload(prompt, size, format, model)

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { bytes, revisedPrompt } = await generateOnce(accessToken, version, payload)
      const target = prepareWorkspaceOutput(out, 'CG_OUT')
      writeNewWorkspaceFile(target, bytes)
      console.log(JSON.stringify({
        ok: true,
        outputPath: workspaceRelativePath(target),
        bytes: bytes.length,
        revisedPrompt,
        model,
      }))
      return
    } catch (err) {
      if (err?.code === 'EEXIST' || /already exists/i.test(String(err?.message))) die('output_exists')
      const isAuthError = /401/.test(String(err && err.message))
      if (isAuthError && refreshToken && attempt === 1) {
        log('access token rejected; refreshing via OAuth')
        try {
          const refreshed = await refreshAccessToken(refreshToken, 'codex-imagegen')
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
