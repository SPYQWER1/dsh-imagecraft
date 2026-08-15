# dsh-codex-tools

[English](./README.md)

一个 DeepSeek Harness 插件，注册三个由 ChatGPT Codex 传输层驱动的模型工具：

| 工具 | 作用 |
| --- | --- |
| `web_search` | 搜索公开网页，返回摘要和来源 URL。 |
| `image_gen` | 生成位图；不编辑或变换已有图片。 |
| `image_vision` | 读取本地图片，返回描述或针对图片的问题答案。 |

本包没有 npm 运行时依赖，使用 Node 内置 `https` 传输。它消费已有的 Codex/ChatGPT 登录态，不提供登录功能或 LLM provider。

## 运行时前置条件

- DeepSeek Harness，且插件以 profile 级 Cordis bundle 安装。
- Node.js >= 22。
- ChatGPT/Codex 登录态，二选一：使用 `codex login` 生成登录文件，或在 DSH 中配置：
  - `OPENAI_CODEX_API_KEY`
  - `OPENAI_CODEX_REFRESH_TOKEN`
  - 可选的 `OPENAI_CODEX_ACCOUNT_ID`

认证优先使用环境变量 `CODEX_ACCESS_TOKEN`、`CODEX_REFRESH_TOKEN`、`CODEX_ACCOUNT_ID`（插件将上述 DSH 凭据名映射为这些变量）。如果这些变量没有值，设置了 `CODEX_HOME` 时读取 `$CODEX_HOME/auth.json`，否则读取 `~/.codex/auth.json`。设置 `CODEX_HOME` 可更换认证目录，默认目录是 `~/.codex`。HTTP 401 后，传输脚本会刷新 access token 一次，并尝试把刷新后的登录态写回该认证文件。插件注入 DSH 凭据时，刷新逻辑仍可能写入由 `CODEX_HOME` 或默认路径选中的认证文件。

## 安装

本包以 bundle 形式发布。安装到 profile 后，该 profile 的每个会话都会注册这些工具。

```bash
# Git（无构建步骤）
dsh plugin --profile web add github:SPYQWER1/dsh-codex-tools

# 本地或已下载的 tarball
dsh plugin --profile web add ./dsh-codex-tools-1.0.0.tgz

# 发布到 npm 后
dsh plugin --profile web add dsh-codex-tools
```

安装后重启 profile（`dsh web` 或 `dsh --profile web`）。使用 `dsh plugin --profile web remove dsh-codex-tools` 卸载。Git 安装可固定 commit，例如 `github:SPYQWER1/dsh-codex-tools#<sha>`。

bundle 入口是 `index.js`；`tools.js` 调用 `scripts/` 中的传输脚本。optional peer 包从 Harness 安装解析。可运行 `npm pack --dry-run` 查看将要发布的文件。

## 独立 CLI

传输脚本也可脱离 Harness 运行。输入通过环境变量传递，每条命令输出一行 JSON 结果：

```bash
# 生成图片。CG_OUT 可为绝对路径或相对于传输进程 cwd 的路径。
CG_PROMPT="a cute whale icon, flat vector style" CG_OUT=output/whale.png CG_SIZE=1024x1024 \
  node scripts/codex-imagegen.mjs

# 描述图片；VG_IMAGE 可为绝对路径或相对于传输进程 cwd 的路径。
VG_IMAGE=output/whale.png VG_QUESTION="what is this?" \
  node scripts/codex-vision.mjs

# 搜索公开网页。
CS_QUERY="latest DeepSeek Harness release" CS_FRESHNESS=live \
  node scripts/codex-search.mjs
```

这些命令需要网络和有效的 ChatGPT/Codex OAuth 凭据。独立脚本读取 `CODEX_ACCESS_TOKEN`、`CODEX_REFRESH_TOKEN`、`CODEX_ACCOUNT_ID` 或上文所述认证文件；`OPENAI_CODEX_*` 名称是插件使用的 DSH 凭据名。没有实际使用凭据运行网络 smoke test 时，不要声称测试通过。

## 工具参数

### `web_search`

| 参数 | 类型 | 默认值 / 限制 |
| --- | --- | --- |
| `query` | string（必填） | 公开网页研究问题。 |
| `maxSources` | integer | `5`；范围 1–10。 |
| `freshness` | string | `cached`，时效性问题可用 `live`。 |
| `model` | string | `gpt-5.4-mini`。 |

结果包含 `summary` 和 `sources`；每个来源包含标题、URL 和片段。

### `image_gen`

| 参数 | 类型 | 默认值 / 限制 |
| --- | --- | --- |
| `prompt` | string（必填） | 描述主体、风格、构图、配色和约束。 |
| `out` | string | `output/imagegen/<timestamp>.png`；相对路径由传输进程解析，也接受绝对路径。会创建父目录；已有文件可能被覆盖。省略 `out` 时，即使 `format` 是 `jpeg` 或 `webp`，默认文件名仍使用 `.png` 扩展名。 |
| `size` | string | `auto`、`1024x1024`、`1536x1024`、`1024x1536`、`2048x2048` 或 `2048x1152`。 |
| `format` | string | `png`、`jpeg` 或 `webp`；默认 `png`。 |
| `model` | string | `gpt-5.5`。 |

不支持透明背景；如有需要，请请求合适的纯色或色键背景，再在本地去除背景。

### `image_vision`

| 参数 | 类型 | 默认值 / 限制 |
| --- | --- | --- |
| `image` | string（必填） | 已存在的 `png`、`jpeg/jpg`、`webp` 或 `gif`；相对或绝对路径。最大 15 MiB。 |
| `question` | string | 可选的焦点问题；省略时返回完整描述。 |
| `model` | string | `gpt-5.5`。 |

传输脚本会读取本地文件，将其嵌入请求并发送到 ChatGPT Codex endpoint。支持绝对路径，但代码不保证路径边界；只能传入进程有权读取的图片。

## 架构

```
Harness 模型工具
        |
        v
index.js -> tools.js -> scripts/codex-*.mjs
                              |
                              +-- OAuth 刷新（auth.openai.com）
                              +-- POST chatgpt.com/backend-api/codex/responses
                              |
             web_search：默认 gpt-5.4-mini
             image_gen / image_vision：默认 gpt-5.5
```

## 注意事项与服务条款

- `chatgpt.com/backend-api/codex/responses` 是官方 Codex CLI 使用的内部 endpoint，不是文档化的公开 API，可能在无通知的情况下变更或受限。
- 网页搜索的摘要和片段由模型整理；依赖结果前应打开返回的来源 URL，核对原文。
- 网页搜索和生图会消耗 ChatGPT 套餐的 **Codex-usage** 计量配额。
- 请遵守 OpenAI 服务条款；不要用 ChatGPT 订阅搭建面向公众的图像生成服务。

## 已知限制与后续工作

当前实现尚未解决以下问题：

- `image_gen` 接受绝对路径和相对于传输进程 cwd 的路径，会创建父目录，也可能覆盖已有文件。当前没有强制工作区边界、符号链接检查或排他创建。
- `image_vision` 接受绝对路径，并会把完整的本地图片发送到 Codex endpoint。当前没有强制工作区边界或符号链接检查；不要传入敏感图片或进程不应读取的路径。
- 输入长度和资源限制、传输层的严格校验、错误脱敏以及畸形响应测试仍需完善。Token 刷新的持久化边界和 `fs` 服务注入也需要结合宿主环境复核。
- profile 安装、重启/卸载、OAuth 刷新和跨平台路径行为仍需集成测试。下面的离线检查不覆盖这些场景。

## 开发者检查

提交文档或代码变更前运行以下离线检查：

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

## 许可

MIT —— 见 [LICENSE](./LICENSE)。
