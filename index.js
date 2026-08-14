// dsh-imagecraft — deployment bundle entry point (installed via `dsh plugin add`).
//
// Registers image_gen and image_vision into the host tools registry so every
// session of the profile sees them. Shares all logic with the preset-install
// entry (imagegen-tool.js) through tools.js.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installImageTools } from './tools.js'

export const name = 'dsh-imagecraft'

export function apply(ctx) {
  const shell = ctx.get('shell')
  const credentials = ctx.get('credentials')
  const fs = ctx.get('fs')
  if (shell === undefined || credentials === undefined) return
  const [genDispose, visionDispose] = installImageTools(
    (definition) => defineTool(definition),
    { shell, credentials, fs },
    (tool) => ctx.tools.register(tool),
  )
  ctx.effect(() => genDispose, 'dsh-imagecraft: register image_gen')
  ctx.effect(() => visionDispose, 'dsh-imagecraft: register image_vision')
}

export const inject = ['tools']
