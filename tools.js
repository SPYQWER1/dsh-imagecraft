// Shared core for the dsh-imagecraft bundle entry (index.js).
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
    description: 'Generate a new bitmap image (illustrations, icons, logos, photos, concept art, UI mockups, game assets) via the ChatGPT subscription. Use when the user asks to create or generate an image. Do NOT use to edit/transform an existing image (no input-image support), to produce transparent-background images (unsupported; suggest a chroma-key background instead), or when a vector/SVG/code asset is the better fit. Write `prompt` in detail: subject, style, composition, palette, lighting, constraints. Leave `size` as auto unless the user gives dimensions. On success the result carries the absolute `outputPath` — report it to the user. Result JSON: { ok, outputPath, bytes, revisedPrompt, model } or { ok: false, error }.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Image description: subject, style, composition, palette, lighting, constraints. More detail yields better results.' },
      out: { type: 'string', description: 'Output path relative to the workspace; parent directories are created. Default: output/imagegen/<timestamp>.png (never overwrites existing files).' },
      size: { type: 'string', description: 'One of 1024x1024, 1536x1024, 1024x1536, 2048x2048, 2048x1152. Default: auto — set only when the user specifies dimensions or aspect ratio.' },
      format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Output format. Default: png; use jpeg/webp when the user wants a smaller file.' },
      model: { type: 'string', description: 'Backend model id. Default: gpt-5.5.' }
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
    description: 'Describe or answer questions about an image via the ChatGPT subscription (multimodal). Use when the user references an image and you cannot see its content. `image` must be an existing file (png/jpeg/webp/gif), workspace-relative or absolute — verify it exists before calling; never guess the content. `question` is optional, any language (e.g. "翻译图中文字"); omit it for a full description (subjects, style, composition, colors, verbatim text). Never build your own OCR or read image bytes yourself — always use this tool. Returns { ok, text, model, image } or { ok: false, error }; relay `text` to the user.',
    parameters: {
      image: { type: 'string', required: true, description: 'Path to an existing image file (png/jpeg/webp/gif), relative to the workspace or absolute.' },
      question: { type: 'string', description: 'Optional focus question or instruction, any language. Omit for a full description.' },
      model: { type: 'string', description: 'Backend model id. Default: gpt-5.5.' }
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
