# dsh-codex-tools

[中文](./README.zh-CN.md)

A DeepSeek Harness plugin that registers three model tools backed by the ChatGPT Codex transport:

| Tool | Function |
| --- | --- |
| `web_search` | Searches the public web and returns a summary with source URLs. |
| `image_gen` | Generates a bitmap image. It does not edit or transform an existing image. |
| `image_vision` | Reads a local image and returns a description or an answer to a question about it. |

The package has no npm runtime dependencies and uses Node's built-in `https` transport. It consumes an existing Codex/ChatGPT login; it does not provide login or an LLM provider.

## Runtime requirements

- DeepSeek Harness, with the plugin installed as a profile-level Cordis bundle.
- Node.js >= 22.
- A ChatGPT/Codex login state, either `codex login` with an auth file, or credentials in DSH:
  - `OPENAI_CODEX_API_KEY`
  - `OPENAI_CODEX_REFRESH_TOKEN`

Credentials are resolved from `CODEX_ACCESS_TOKEN` and `CODEX_REFRESH_TOKEN` environment variables first (the plugin maps the DSH credential names above to these variables). If those are absent, the transport reads `$CODEX_HOME/auth.json` when `CODEX_HOME` is set, or `~/.codex/auth.json` otherwise. Set `CODEX_HOME` to choose another auth directory; the default is `~/.codex`. After an HTTP 401, a transport refreshes the access token once and attempts to persist the refreshed login state to that auth file. When the plugin injects DSH credentials, the refresh code may still write to the auth file selected by `CODEX_HOME` or the default path.

## Installation

The package is a bundle. Installing it into a profile registers the tools for every session of that profile.

```bash
# Git (there is no build step)
dsh plugin --profile web add github:SPYQWER1/dsh-codex-tools

# Local or downloaded tarball
dsh plugin --profile web add ./dsh-codex-tools-1.0.0.tgz

# npm, once published
dsh plugin --profile web add dsh-codex-tools
```

Restart the profile (`dsh web` or `dsh --profile web`) after installation. Remove it with `dsh plugin --profile web remove dsh-codex-tools`. For a Git install, pin a commit, for example `github:SPYQWER1/dsh-codex-tools#<sha>`.

The bundle entry is `index.js`; `tools.js` invokes the transports in `scripts/`. The optional peer packages are resolved from the Harness installation. To inspect the files that would be published, run `npm pack --dry-run`.

## Standalone CLI

The transports also run without the Harness. Inputs are environment variables and each command prints one JSON result line:

```bash
# Generate an image. CG_OUT must be relative to the transport workspace.
CG_PROMPT="a cute whale icon, flat vector style" CG_OUT=output/whale.png CG_SIZE=1024x1024 \
  node scripts/codex-imagegen.mjs

# Describe an image; VG_IMAGE must be relative to the transport workspace.
VG_IMAGE=output/whale.png VG_QUESTION="what is this?" \
  node scripts/codex-vision.mjs

# Search the public web.
CS_QUERY="latest DeepSeek Harness release" CS_FRESHNESS=live \
  node scripts/codex-search.mjs
```

These commands need network access and valid ChatGPT/Codex OAuth credentials. Standalone scripts read `CODEX_ACCESS_TOKEN` and `CODEX_REFRESH_TOKEN`, or the auth file described above; the `OPENAI_CODEX_*` names are the DSH credential names used by the plugin. Do not treat a network smoke test as passing unless it was actually run with credentials.

## Tool parameters

### `web_search`

| Parameter | Type | Default / limits |
| --- | --- | --- |
| `query` | string (required) | Public-web research question. |
| `maxSources` | integer | `5`; from 1 to 10. |
| `freshness` | string | `cached`, or `live` for time-sensitive queries. |
| `model` | string | `gpt-5.4-mini`. |

The result contains `summary` and `sources`; each source has a title, URL, and snippet.

### `image_gen`

| Parameter | Type | Default / limits |
| --- | --- | --- |
| `prompt` | string (required) | Describe the subject, style, composition, palette, and constraints. |
| `out` | string | `output/imagegen/<timestamp>.<format>`; must be relative to the transport workspace. Absolute paths, parent-directory segments, and symbolic links are rejected. Parent directories are created, and existing files are never overwritten. If `out` is omitted, the extension follows `format`. |
| `size` | string | `auto`, `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, or `2048x1152`. |
| `format` | string | `png`, `jpeg`, or `webp`; default `png`. |
| `model` | string | `gpt-5.5`. |

Transparent-background output is unsupported; request a suitable solid/chroma-key background and remove it locally if needed.

### `image_vision`

| Parameter | Type | Default / limits |
| --- | --- | --- |
| `image` | string (required) | Existing `png`, `jpeg/jpg`, `webp`, or `gif` under the transport workspace; absolute paths, parent-directory segments, and symbolic links are rejected. Maximum 15 MiB. |
| `question` | string | Optional focus question; omitted means a full description. |
| `model` | string | `gpt-5.5`. |

The transport reads the local file, embeds it in the request, and sends it to the ChatGPT Codex endpoint. Only files inside the transport workspace are accepted.

## Architecture

```
Harness model tool
        |
        v
index.js -> tools.js -> scripts/codex-*.mjs
                              |
                              +-- OAuth refresh (auth.openai.com)
                              +-- POST chatgpt.com/backend-api/codex/responses
                              |
             web_search: gpt-5.4-mini by default
             image_gen / image_vision: gpt-5.5 by default
```

## Caveats and service terms

- `chatgpt.com/backend-api/codex/responses` is an internal endpoint used by the official Codex CLI, not a documented public API. It may change or be restricted without notice.
- Search summaries and snippets are model-generated; open the returned source URLs and check the original text before relying on them.
- Web search and image generation use the metered **Codex-usage** bucket of the ChatGPT plan.
- Follow OpenAI's Terms of Use; do not use a ChatGPT subscription to power a public-facing image-generation service.

## Known limitations and follow-up

- `image_gen` and `image_vision` accept only workspace-relative paths. Absolute paths, parent-directory segments, and symbolic links are rejected. Image generation creates parent directories but never overwrites an existing file.
- Image files are still sent to the ChatGPT Codex endpoint for analysis. Do not pass sensitive images.
- The transports enforce basic input length, image-size, path, and format limits. Profile installation, restart/removal, OAuth refresh, and cross-platform behavior still require integration testing; the offline checks below do not cover those cases.

## Development checks

Run the following offline checks before submitting documentation or code changes:

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

## License

MIT — see [LICENSE](./LICENSE).
