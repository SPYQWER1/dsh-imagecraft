# Repository Guidelines

## Project Structure & Module Organization

- `index.js` is the Cordis bundle entry point and registers the plugin's model tools.
- `tools.js` contains shared tool definitions, argument validation, backend invocation, and filesystem checks.
- `scripts/codex-common.mjs` holds shared auth, HTTP, and SSE helpers; `codex-imagegen.mjs`, `codex-vision.mjs`, and `codex-search.mjs` are the standalone transports for image generation, image understanding, and web search.
- `README.md` and `README.zh-CN.md` document installation and usage; `生图.png` and `识图.png` are README gallery assets.
- `test/tools.test.mjs` contains offline unit tests for tool registration, argument validation, and auth resolution. Runtime-generated files belong under ignored paths such as `output/` or `tmp/`.

## Build, Test, and Development Commands

This package has no compile step or npm test script. Use these checks before submitting changes:

```bash
npm pack --dry-run
node --check index.js
node --check tools.js
node --check scripts/codex-common.mjs
node --check scripts/codex-imagegen.mjs
node --check scripts/codex-vision.mjs
node --check scripts/codex-search.mjs
node --test test/tools.test.mjs
```

`npm pack --dry-run` verifies the published file set. With a valid Codex login, smoke-test the transports directly, for example `CG_PROMPT="a blue whale icon" CG_OUT=output/whale.png node scripts/codex-imagegen.mjs`, `VG_IMAGE=生图.png node scripts/codex-vision.mjs`, or `CS_QUERY="test" node scripts/codex-search.mjs`. These calls require network access and ChatGPT OAuth credentials.

## Coding Style & Naming Conventions

Use Node.js 22+ ESM, two-space indentation, single quotes, and no semicolons, matching the existing JavaScript. Use `camelCase` for functions and local variables, `UPPER_SNAKE_CASE` for module constants, and descriptive tool names such as `image_gen`. No formatter or linter is configured; keep diffs focused and run the syntax checks above.

## Testing Guidelines

No coverage threshold is configured. `test/tools.test.mjs` uses Node's built-in test runner (`node:test`) and runs offline. For code changes, run all six `node --check` commands plus `node --test test/tools.test.mjs`, and exercise the affected standalone transport when credentials are available. Add new tests as `*.test.mjs` under `test/`; keep network-dependent tests opt-in.

## Commit & Pull Request Guidelines

Recent commits use short imperative subjects with prefixes such as `docs:` and `fix:` (for example, `fix: handle expired access tokens`). Follow that style. PRs should explain the behavior change, list verification commands, update both README languages when user-facing behavior changes, and include screenshots for gallery or output changes. Never commit OAuth tokens, `~/.codex/auth.json`, generated outputs, or private logs.

## Security & Configuration Tips

Credentials come from `CODEX_*` environment variables or `codex login`; do not hard-code or print them. Changes touching the internal ChatGPT Codex endpoint or token refresh flow need extra review and a clear note in the PR.
