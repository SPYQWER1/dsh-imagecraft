// Shared core for the dsh-imagegen bundle entry (index.js).
//
// Builds the two model tools from this module. The caller supplies the
// `define` normalizer (defineTool from @deepseek-ai/dsh-tools) and the
// `register` effect (ctx.tools.register).
//
// Transports live in ./scripts/ next to this file; paths resolve from
// import.meta.url, so the package works from any install location.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const SCRIPTS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'scripts')
const SCRIPT_CODEX = join(SCRIPTS_DIR, 'codex-imagegen.mjs')
const SCRIPT_VISION = join(SCRIPTS_DIR, 'codex-vision.mjs')

const ALLOWED_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', 'auto'])
const ALLOWED_FORMATS = new Set(['png', 'jpeg', 'webp'])

/**
 * Build and register the image_gen and image_vision model tools.
 * @param define - ToolDefinition normalizer (@deepseek-ai/dsh-tools defineTool).
 * @param deps - { shell, credentials, fs } services from the caller's context.
 * @param register - effect that registers one tool and returns its disposer.
 * @returns the two disposers.
 */
export function installImageTools(define, deps, register) {
  const { shell, credentials, fs } = deps

  const parseCliJson = (collected) => {
    if (!collected) return null
    const text = typeof collected === 'string' ? collected : collected.text
    if (!text) return null
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed
      } catch {
        continue
      }
    }
    return null
  }
  const outputText = (collected) => {
    if (!collected) return undefined
    return typeof collected === 'string' ? collected : collected.text
  }
  const codexEnv = async (extra) => {
    const access = await credentials.resolve('OPENAI_CODEX_API_KEY')
    const refresh = await credentials.resolve('OPENAI_CODEX_REFRESH_TOKEN')
    const env = { ...extra }
    if (access && access.value) env.CODEX_ACCESS_TOKEN = access.value
    if (refresh && refresh.value) env.CODEX_REFRESH_TOKEN = refresh.value
    return env
  }

  const runCodexBackend = async ({ prompt, out, size, format, model, signal }) => {
    const env = await codexEnv({
      CG_PROMPT: prompt,
      CG_OUT: out,
      CG_FORMAT: format,
      CG_SIZE: size === undefined ? 'auto' : size,
      CG_MODEL: model === undefined ? 'gpt-5.5' : model,
    })
    const spec = shell.resolve({
      command: 'node ' + JSON.stringify(SCRIPT_CODEX),
      env,
      timeoutMs: 360000,
      signal,
    })
    const run = await shell.run(spec)
    const parsed = parseCliJson(run.stdout)
    if (!parsed) {
      return { ok: false, backend: 'chatgpt-subscription', exitCode: run.exitCode, error: 'backend returned no parseable result', stderr: outputText(run.stderr) }
    }
    return { backend: 'chatgpt-subscription', ...parsed }
  }

  const runVisionBackend = async ({ image, question, model, signal }) => {
    const env = await codexEnv({
      VG_IMAGE: image,
      VG_MODEL: model === undefined ? 'gpt-5.5' : model,
    })
    if (question) env.VG_QUESTION = question
    const spec = shell.resolve({
      command: 'node ' + JSON.stringify(SCRIPT_VISION),
      env,
      timeoutMs: 240000,
      signal,
    })
    const run = await shell.run(spec)
    const parsed = parseCliJson(run.stdout)
    if (!parsed) {
      return { ok: false, exitCode: run.exitCode, error: 'vision backend returned no parseable result', stderr: outputText(run.stderr) }
    }
    return parsed
  }

  const genTool = define({
    name: 'image_gen',
    description: 'Generate a bitmap image using the ChatGPT subscription (Codex backend, no API key required). Use when the user asks to create a raster image: illustrations, icons, logos, photos, concept art, UI mockups, game assets. Provide a detailed prompt (subject, style, composition, palette, constraints). Saves the image under output/imagegen/ and returns its path. Transparent-background output is not supported (use a chroma-key background instead).',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Detailed description of the image to generate.' },
      out: { type: 'string', description: 'Output path relative to the workspace, e.g. output/imagegen/whale-icon.png. Defaults to output/imagegen/<timestamp>.png.' },
      size: { type: 'string', description: 'Output size: 1024x1024, 1536x1024, 1024x1536, 2048x2048, 2048x1152, or auto (default).' },
      format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Output format; default png.' },
      model: { type: 'string', description: 'Model override (e.g. gpt-5.5). Defaults to gpt-5.5.' }
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    timeoutMs: 360000,
    async execute(args, exec) {
      const prompt = String(args.prompt ?? '').trim()
      if (!prompt) return { ok: false, error: 'prompt is required.' }
      const size = args.size === undefined ? undefined : String(args.size)
      if (size !== undefined && !ALLOWED_SIZES.has(size)) {
        return { ok: false, error: 'size must be one of 1024x1024, 1536x1024, 1024x1536, 2048x2048, 2048x1152, auto.' }
      }
      const format = args.format === undefined ? 'png' : String(args.format)
      if (!ALLOWED_FORMATS.has(format)) {
        return { ok: false, error: 'format must be png, jpeg, or webp.' }
      }
      const model = args.model === undefined ? undefined : String(args.model)
      const out = String(args.out ?? ('output/imagegen/' + Date.now() + '.png'))

      const result = await runCodexBackend({ prompt, out, size, format, model, signal: exec.signal })

      if (result.ok && result.outputPath && fs !== undefined) {
        try {
          const target = await fs.resolve(result.outputPath)
          const info = await fs.stat(target, exec.signal)
          result.fileWritten = info !== undefined
          result.bytes = info && typeof info.size === 'number' ? info.size : result.bytes
        } catch (_err) {
          // fs confirmation is best-effort; the backend already reported.
        }
      }
      return result
    }
  })

  const visionTool = define({
    name: 'image_vision',
    description: 'Describe or answer questions about an image using the ChatGPT subscription (multimodal model via the Codex backend). Use when the user references an image file, URL, or pasted image and you cannot see its content: pass the image path and optionally a focus question; the returned text describes subjects, style, composition, colors, and quotes visible text verbatim. Never build your own OCR or read image bytes yourself — always use this tool. Requires an existing image path (png/jpeg/webp/gif).',
    parameters: {
      image: { type: 'string', required: true, description: 'Path to the image file, relative to the workspace or absolute.' },
      question: { type: 'string', description: 'Optional focus question or instruction (e.g. "翻译图中文字", "描述构图"). Defaults to a full description.' },
      model: { type: 'string', description: 'Model override (default gpt-5.5).' }
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    timeoutMs: 240000,
    async execute(args, exec) {
      const image = String(args.image ?? '').trim()
      if (!image) return { ok: false, error: 'image path is required.' }
      const question = args.question === undefined ? undefined : String(args.question)
      const model = args.model === undefined ? undefined : String(args.model)
      return runVisionBackend({ image, question, model, signal: exec.signal })
    }
  })

  return [register(genTool), register(visionTool)]
}
