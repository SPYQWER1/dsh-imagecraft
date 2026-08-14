#!/usr/bin/env node
// codex-search.mjs — public web search through the ChatGPT Codex backend.
//
// Inputs are environment variables so prompts and URLs cannot be damaged by
// shell quoting. The script prints exactly one JSON line to stdout.
//
//   CS_QUERY        search query (required)
//   CS_MAX_SOURCES  maximum sources, 1..10 (default 5)
//   CS_FRESHNESS    cached | live (default cached)
//   CS_MODEL        model id (default gpt-5.4-mini)
//   CODEX_*         optional token/account overrides

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

const DEFAULT_MODEL = 'gpt-5.4-mini'
const DEFAULT_MAX_SOURCES = 5
const MAX_SOURCES = 10
const TOTAL_TIMEOUT_MS = 120_000
const STALL_TIMEOUT_MS = 60_000
const verbose = process.env.CS_VERBOSE === '1'
const log = (message) => { if (verbose) console.error(message) }

function die(message) {
  console.log(JSON.stringify({ ok: false, error: String(message) }))
  process.exit(1)
}

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          snippet: { type: 'string' },
        },
        required: ['title', 'url', 'snippet'],
      },
    },
  },
  required: ['summary', 'sources'],
}

function buildPrompt(query, maxSources, freshness) {
  const recency = freshness === 'live'
    ? 'Prioritize the most recent information available.'
    : 'Cached results are acceptable; prioritize accuracy over recency.'
  return [
    'You are a web research assistant.',
    'Use the web_search tool to research the user query and answer from public online sources.',
    recency,
    'Return ONLY one JSON object matching this schema, with no markdown fences or commentary:',
    JSON.stringify(SEARCH_SCHEMA),
    `Return no more than ${maxSources} sources and prefer official or primary sources.`,
    'Each source URL must be a complete http or https URL and each snippet must be short and relevant.',
    '',
    `User query: ${query}`,
  ].join('\n')
}

function buildPayload(query, maxSources, freshness, model) {
  return {
    model,
    stream: true,
    instructions: buildPrompt(query, maxSources, freshness),
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `Search the public web for: ${query}` }],
    }],
    tools: [{ type: 'web_search' }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    reasoning: { effort: 'low', summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    text: { verbosity: 'low' },
  }
}

function parseResult(text, query, freshness, maxSources, model) {
  let candidate = text.trim()
  if (candidate.startsWith('```')) {
    candidate = candidate.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  }
  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('search backend returned invalid JSON')
    try { parsed = JSON.parse(candidate.slice(start, end + 1)) } catch { throw new Error('search backend returned invalid JSON') }
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.summary !== 'string' || !Array.isArray(parsed.sources)) {
    throw new Error('search backend returned an invalid result shape')
  }
  const summary = parsed.summary.trim()
  if (!summary) throw new Error('search backend returned an empty summary')
  const sources = parsed.sources.slice(0, maxSources).map((source) => {
    if (!source || typeof source !== 'object') throw new Error('search backend returned an invalid source')
    const title = typeof source.title === 'string' ? source.title.trim() : ''
    const url = typeof source.url === 'string' ? source.url.trim() : ''
    const snippet = typeof source.snippet === 'string' ? source.snippet.trim() : ''
    if (!title || !/^https?:\/\//i.test(url)) throw new Error('search backend returned an invalid source URL')
    return { title, url, snippet }
  })
  return { ok: true, query, freshness, summary, sources, model }
}

async function searchOnce(accessToken, accountId, version, payload, query, freshness, maxSources, model) {
  const headers = buildHeaders(accessToken, accountId, version, 'codex-search')
  const parts = []
  const saw = new Set()
  let failureDetail = null
  for await (const event of streamSSE(CODEX_RESPONSES_URL, headers, JSON.stringify(payload), {
    totalTimeoutMs: TOTAL_TIMEOUT_MS,
    stallTimeoutMs: STALL_TIMEOUT_MS,
  })) {
    const type = event.type
    if (typeof type === 'string') saw.add(type)
    if (type === 'error' || type === 'response.failed') {
      const detail = event.response?.error?.message ?? event.response?.error?.code ?? event.message ?? event.code
      if (detail) failureDetail = String(detail)
    }
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') parts.push(event.delta)
    if (type === 'response.output_text.done' && parts.length === 0 && typeof event.item?.text === 'string') parts.push(event.item.text)
  }
  const text = parts.join('').trim()
  if (!text) {
    const events = [...saw].sort().join(', ') || '(none)'
    throw new Error(failureDetail ? `backend failed: ${failureDetail} (events: ${events})` : `no search result returned (events: ${events})`)
  }
  return parseResult(text, query, freshness, maxSources, model)
}

async function main() {
  const query = String(process.env.CS_QUERY || '').trim()
  if (!query) die('CS_QUERY is required')
  const maxSources = Number(process.env.CS_MAX_SOURCES || DEFAULT_MAX_SOURCES)
  if (!Number.isInteger(maxSources) || maxSources < 1 || maxSources > MAX_SOURCES) die('CS_MAX_SOURCES must be an integer from 1 to 10')
  const freshness = process.env.CS_FRESHNESS || 'cached'
  if (freshness !== 'cached' && freshness !== 'live') die('CS_FRESHNESS must be cached or live')
  const model = process.env.CS_MODEL || DEFAULT_MODEL

  const authPath = defaultAuthPath()
  const auth = readAuthJson(authPath)
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : {}
  let accessToken = process.env.CODEX_ACCESS_TOKEN || tokens.access_token || null
  const refreshToken = process.env.CODEX_REFRESH_TOKEN || tokens.refresh_token || null
  const accountId = process.env.CODEX_ACCOUNT_ID || tokens.account_id || null
  if (!accessToken) die('no ChatGPT OAuth access token: set CODEX_ACCESS_TOKEN or run `codex login`')

  const version = detectVersion()
  const payload = buildPayload(query, maxSources, freshness, model)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(JSON.stringify(await searchOnce(accessToken, accountId, version, payload, query, freshness, maxSources, model)))
      return
    } catch (error) {
      if (/401/.test(String(error?.message)) && refreshToken && attempt === 1) {
        log('access token rejected; refreshing via OAuth')
        try {
          const refreshed = await refreshAccessToken(refreshToken, 'codex-search')
          if (!refreshed.body || refreshed.status >= 400) {
            const parsed = safeJson(refreshed.body)
            die('token refresh failed: HTTP ' + refreshed.status + (parsed?.error ? ` (${parsed.error})` : ''))
          }
          const data = safeJson(refreshed.body) || {}
          if (typeof data.access_token !== 'string') die('token refresh succeeded but returned no access_token')
          accessToken = data.access_token
          const nextAuth = readAuthJson(authPath)
          const nextTokens = nextAuth.tokens && typeof nextAuth.tokens === 'object' ? nextAuth.tokens : {}
          nextTokens.access_token = data.access_token
          if (typeof data.refresh_token === 'string') nextTokens.refresh_token = data.refresh_token
          if (typeof data.id_token === 'string') nextTokens.id_token = data.id_token
          nextAuth.tokens = nextTokens
          nextAuth.last_refresh = new Date().toISOString()
          persistAuth(nextAuth, authPath)
          continue
        } catch (refreshError) {
          die('token refresh failed: ' + (refreshError.message || refreshError))
        }
      }
      die(error?.message || String(error))
    }
  }
}

main().catch((error) => die(error?.message || String(error)))
