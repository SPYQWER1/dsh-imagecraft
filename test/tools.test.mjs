import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installImageTools } from '../tools.js'
import {
  defaultAuthPath,
  resolveCodexAuth,
  resolveWorkspacePath,
  resolveWorkspaceFile,
  workspaceRelativePath,
  prepareWorkspaceOutput,
  writeNewWorkspaceFile,
  safeJson,
} from '../scripts/codex-common.mjs'

function makeHarness(stdout = JSON.stringify({ ok: true })) {
  const definitions = []
  const registrations = []
  const calls = []
  const credentials = { resolve: async () => undefined }
  const shell = {
    resolve(spec) {
      calls.push(spec)
      return spec
    },
    async run() {
      return { exitCode: 0, stdout, stderr: '' }
    },
  }
  const define = (definition) => definition
  const register = (tool) => {
    definitions.push(tool)
    const dispose = () => { registrations.push(`disposed:${tool.name}`) }
    return dispose
  }
  return { definitions, registrations, calls, credentials, shell, define, register }
}

test('registers image generation, vision, and web search tools', () => {
  const harness = makeHarness()
  const disposers = installImageTools(harness.define, {
    shell: harness.shell,
    credentials: harness.credentials,
    fs: undefined,
  }, harness.register)

  assert.deepEqual(harness.definitions.map((tool) => tool.name), ['image_gen', 'image_vision', 'web_search'])
  assert.equal(disposers.length, 3)
  disposers.forEach((dispose) => dispose())
  assert.deepEqual(harness.registrations, [
    'disposed:image_gen',
    'disposed:image_vision',
    'disposed:web_search',
  ])
})

test('keeps workspace paths relative and prevents output overwrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-tools-workspace-'))
  const previous = process.cwd()
  process.chdir(root)
  try {
    assert.equal(resolveWorkspacePath('input.png', 'image path'), join(root, 'input.png'))
    assert.throws(() => resolveWorkspacePath('/tmp/input.png', 'image path'), /must be relative/)
    assert.throws(() => resolveWorkspacePath('C:\\input.png', 'image path'), /must be relative/)
    assert.throws(() => resolveWorkspacePath('\\\\server\\share\\input.png', 'image path'), /must be relative/)
    assert.throws(() => resolveWorkspacePath('../input.png', 'image path'), /parent-directory/)
    const target = prepareWorkspaceOutput('output/result.png')
    assert.equal(workspaceRelativePath(target), 'output/result.png')
    writeNewWorkspaceFile(target, Buffer.from('first'))
    assert.throws(() => prepareWorkspaceOutput('output/result.png'), /already exists/)
    await writeFile(join(root, 'real.png'), Buffer.from('image'))
    await symlink('real.png', join(root, 'link.png'))
    assert.throws(() => resolveWorkspaceFile('link.png'), /symbolic links/)
  } finally {
    process.chdir(previous)
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects absolute image and output paths before spawning transports', async () => {
  const harness = makeHarness()
  installImageTools(harness.define, {
    shell: harness.shell,
    credentials: harness.credentials,
    fs: undefined,
  }, harness.register)
  const exec = { signal: new AbortController().signal }
  const gen = harness.definitions.find((entry) => entry.name === 'image_gen')
  const vision = harness.definitions.find((entry) => entry.name === 'image_vision')

  assert.match((await gen.execute({ prompt: 'x', out: '/tmp/result.png' }, exec)).error, /relative/)
  assert.match((await vision.execute({ image: '/tmp/input.png' }, exec)).error, /relative/)
  assert.equal(harness.calls.length, 0)
})

test('redacts credential-like backend errors returned through tools', async () => {
  const harness = makeHarness(JSON.stringify({ ok: false, error: 'Bearer secret access_token=hidden' }))
  installImageTools(harness.define, {
    shell: harness.shell,
    credentials: harness.credentials,
    fs: undefined,
  }, harness.register)
  const tool = harness.definitions.find((entry) => entry.name === 'web_search')
  const result = await tool.execute({ query: 'test' }, { signal: new AbortController().signal })
  assert.equal(result.ok, false)
  assert.doesNotMatch(result.error, /secret|hidden/)
  assert.equal(result.error, 'auth_failed')
})

test('validates web search arguments before spawning the transport', async () => {
  const harness = makeHarness()
  installImageTools(harness.define, {
    shell: harness.shell,
    credentials: harness.credentials,
    fs: undefined,
  }, harness.register)
  const tool = harness.definitions.find((entry) => entry.name === 'web_search')
  const exec = { signal: new AbortController().signal }

  assert.deepEqual(await tool.execute({ query: '   ' }, exec), { ok: false, error: 'query is required.' })
  assert.deepEqual(await tool.execute({ query: 'x', maxSources: 0 }, exec), { ok: false, error: 'maxSources must be an integer from 1 to 10.' })
  assert.deepEqual(await tool.execute({ query: 'x', maxSources: 1.5 }, exec), { ok: false, error: 'maxSources must be an integer from 1 to 10.' })
  assert.deepEqual(await tool.execute({ query: 'x', freshness: 'future' }, exec), { ok: false, error: 'freshness must be cached or live.' })
  assert.equal(harness.calls.length, 0)
})

test('passes web search options to the Codex transport and returns sources', async () => {
  const response = JSON.stringify({
    ok: true,
    query: 'DeepSeek Harness',
    freshness: 'live',
    summary: 'A concise result',
    sources: [{ title: 'Official docs', url: 'https://example.com/docs', snippet: 'Relevant detail' }],
    model: 'test-model',
  })
  const harness = makeHarness(response)
  installImageTools(harness.define, {
    shell: harness.shell,
    credentials: harness.credentials,
    fs: undefined,
  }, harness.register)
  const tool = harness.definitions.find((entry) => entry.name === 'web_search')
  const result = await tool.execute({ query: 'DeepSeek Harness', maxSources: 3, freshness: 'live', model: 'test-model' }, {
    signal: new AbortController().signal,
  })

  assert.equal(result.ok, true)
  assert.equal(result.sources[0].url, 'https://example.com/docs')
  assert.match(harness.calls[0].command, /codex-search\.mjs/)
  assert.equal(harness.calls[0].env.CS_QUERY, 'DeepSeek Harness')
  assert.equal(harness.calls[0].env.CS_MAX_SOURCES, '3')
  assert.equal(harness.calls[0].env.CS_FRESHNESS, 'live')
  assert.equal(harness.calls[0].env.CS_MODEL, 'test-model')
})

test('supports CODEX_HOME and keeps environment credentials highest priority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-tools-'))
  const authPath = join(root, 'auth.json')
  await writeFile(authPath, JSON.stringify({ tokens: {
    access_token: 'file-access',
    refresh_token: 'file-refresh',
  } }))
  try {
    assert.equal(defaultAuthPath({ CODEX_HOME: root }), authPath)
    const resolved = resolveCodexAuth({
      CODEX_HOME: root,
      CODEX_ACCESS_TOKEN: 'env-access',
      CODEX_REFRESH_TOKEN: 'env-refresh',
    })
    assert.deepEqual({
      accessToken: resolved.accessToken,
      refreshToken: resolved.refreshToken,
    }, {
      accessToken: 'env-access',
      refreshToken: 'env-refresh',
    })
    assert.deepEqual(safeJson(Buffer.from('{"ok":true}')), { ok: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
