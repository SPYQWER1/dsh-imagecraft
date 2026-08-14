# dsh-imagecraft

[English](./README.md)

**DeepSeek Harness 的图像生成与图像理解——由你的 ChatGPT 订阅驱动，无需 `OPENAI_API_KEY`。**

一个 DeepSeek Harness 插件，注册两个模型工具：

| 工具 | 作用 |
| --- | --- |
| `image_gen` | 通过 ChatGPT Codex 后端生成位图（插画、图标、Logo、照片、概念图、UI 稿等）。 |
| `image_vision` | 用多模态模型描述图片或回答问题——让纯文本模型（如 `deepseek-v4-flash`）获得"视觉"。 |

两个工具都复用 **ChatGPT 登录态**（与官方 Codex CLI 相同的 OAuth 凭据），传输层在 [`scripts/`](./scripts) 中，零 npm 依赖，仅用 Node 内置 `https`。

## 工作原理

```
image_gen / image_vision（模型工具）
        │  harness.registerTool + 凭据服务
        ▼
index.js（Cordis bundle 入口）
        │  shell 服务，参数全部经环境变量传递
        ▼
scripts/codex-imagegen.mjs / codex-vision.mjs   ← 自研传输层
        │  OAuth 刷新（auth.openai.com）+ POST chatgpt.com/backend-api/codex/responses
        ▼
        gpt-5.5（多模态）→ PNG 文件 / 文字描述
```

认证优先级（两个传输脚本一致）：`CODEX_ACCESS_TOKEN` / `CODEX_REFRESH_TOKEN` / `CODEX_ACCOUNT_ID` 环境变量（由插件从 DSH 凭据服务解析，对应 `OPENAI_CODEX_API_KEY` / `OPENAI_CODEX_REFRESH_TOKEN`）→ `~/.codex/auth.json`（`codex login`）。遇到 HTTP 401 时传输脚本自动刷新 access token 一次，并原子写回 `~/.codex/auth.json`（0600）。

## 依赖

- DeepSeek Harness（插件以 preset 本地 Cordis 插件形式运行）
- Node.js ≥ 22（传输脚本）
- ChatGPT 订阅登录态：
  - `codex login` 生成的 `~/.codex/auth.json`（推荐），**或**
  - DSH 凭据 `OPENAI_CODEX_API_KEY` / `OPENAI_CODEX_REFRESH_TOKEN`

## 安装

仓库以 **bundle** 形态发布：装进 profile 后工具注册在 host 注册表，**该 profile 的所有会话**都能用。

```bash
# 从 git 安装（无构建步骤，无需 pnpm allowBuilds 授权）
dsh plugin --profile web add github:SPYQWER1/dsh-imagecraft

# 或发布到 npm 后
dsh plugin --profile web add dsh-imagecraft
```

然后重启该 profile（`dsh web` / `dsh --profile web`），所有会话即可见这两个工具。卸载：`dsh plugin --profile web remove dsh-imagecraft`。git 安装建议固定 commit（`github:SPYQWER1/dsh-imagecraft#<sha>`），避免后续推送静默改变安装内容。

bundle 安装时 `@deepseek-ai/dsh-tools` 等 in-box 包以 optional peer 形式从 harness 安装解析，不会拉取额外 npm 包。bundle 入口是 `index.js`，把两个工具注册进 host 注册表，并通过 `tools.js` 共享 `scripts/` 传输层。


## 使用

直接用自然语言让模型调用工具：

- *"生成一个鲸鱼图标"* → `image_gen`
- *"看看这个图片讲了什么：output/photo.png"* → `image_vision`

### `image_gen` 参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | string（必填） | 详细描述（主体、风格、构图、配色、约束）。 |
| `out` | string | 相对工作区的输出路径。默认 `output/imagegen/<时间戳>.png`。 |
| `size` | string | `1024x1024`、`1536x1024`、`1024x1536`、`2048x2048`、`2048x1152` 或 `auto`（默认）。 |
| `format` | string | `png`（默认）、`jpeg`、`webp`。 |
| `model` | string | ChatGPT 后端模型，默认 `gpt-5.5`。 |

### `image_vision` 参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `image` | string（必填） | 图片路径（png/jpeg/webp/gif），相对工作区或绝对路径。 |
| `question` | string | 可选焦点问题；默认输出完整描述。 |
| `model` | string | 默认 `gpt-5.5`。 |

## 效果示例

`image_gen` —— 根据自然语言请求生成图片：

![image_gen 演示](./生图.png)

`image_vision` —— 文本模型查看图片内容：

![image_vision 演示](./识图.png)

## 注意事项

- `chatgpt.com/backend-api/codex/responses` 是官方 Codex CLI 使用的内部端点，**不是**文档化的公开 API——OpenAI 可能随时变更或限制。
- 生图消耗 ChatGPT 套餐的 **Codex-usage** 计量配额。
- 按 OpenAI 服务条款，请勿用 ChatGPT 订阅搭建面向公众的图像生成服务。

## 许可

MIT —— 见 [LICENSE](./LICENSE)。协议形态参考了 Codex CLI 的公开行为与 [chatgpt-imagegen](https://github.com/leeguooooo/chatgpt-imagegen) 项目；本仓库实现为原创。
