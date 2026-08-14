// dsh-imagegen — preset-install entry point.
//
// Agent-preset install form: place this file plus tools.js and scripts/ in an
// agent preset directory and append the composition row:
//
//   - id: tool-imagegen
//     name: './imagegen-tool.js'
//
// Deployment-level install (`dsh plugin --profile <name> add dsh-imagegen`)
// uses index.js instead; both share tools.js.
import { installImageTools } from './tools.js'

export default {
  name: 'dsh-imagegen',
  apply(ctx) {
    const shell = ctx.get('shell')
    const credentials = ctx.get('credentials')
    const fs = ctx.get('fs')
    if (shell === undefined || credentials === undefined) return
    const [genDispose, visionDispose] = installImageTools(
      (definition) => harness.defineTool(definition),
      { shell, credentials, fs },
      (tool) => harness.registerTool(ctx, tool),
    )
    ctx.effect(() => genDispose, 'dsh-imagegen: register image_gen')
    ctx.effect(() => visionDispose, 'dsh-imagegen: register image_vision')
  }
}
