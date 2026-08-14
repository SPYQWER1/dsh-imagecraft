// dsh-codex-tools — deployment bundle entry point (installed via `dsh plugin add`).
//
// Registers Codex-backed image_gen, image_vision, and web_search into the host
// tools registry so every session of the profile sees them. All transport and
// validation logic lives in tools.js.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installImageTools } from './tools.js'

export const name = 'dsh-codex-tools'

export function apply(ctx) {
  const shell = ctx.get('shell')
  const credentials = ctx.get('credentials')
  const fs = ctx.get('fs')
  const [genDispose, visionDispose, searchDispose] = installImageTools(
    (definition) => defineTool(definition),
    { shell, credentials, fs },
    (tool) => ctx.tools.register(tool),
  )
  ctx.effect(() => genDispose, 'dsh-codex-tools: register image_gen')
  ctx.effect(() => visionDispose, 'dsh-codex-tools: register image_vision')
  ctx.effect(() => searchDispose, 'dsh-codex-tools: register web_search')
}

export const inject = ['tools', 'shell', 'credentials']
