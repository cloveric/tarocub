<p align="center">
  <a href="./README.md"><strong>English</strong></a>&nbsp;&nbsp;|&nbsp;&nbsp;<strong>中文文档</strong>
</p>

<p align="center">
  <img src="./assets/github-banner.png" alt="TaroCub" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/cloveric/tarocub/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cloveric/tarocub?style=flat-square&color=818cf8" alt="License"></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%7C%20macOS%20%7C%20Linux-0078D4?style=flat-square&logo=node.js&logoColor=white" alt="Windows | macOS | Linux">
  <img src="https://img.shields.io/badge/%E5%BC%95%E6%93%8E-Codex%20%7C%20Claude%20%7C%20Kimi%20%7C%20Antigravity-F97316?style=flat-square" alt="Codex | Claude | Kimi | Antigravity">
  <img src="https://img.shields.io/badge/%E6%B5%8B%E8%AF%95-Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white" alt="Vitest">
</p>

<h3 align="center">
  TaroCub：本地运行 Codex、Claude Code、Kimi Code 和 Antigravity，再从飞书/Lark（推荐）或 Telegram 控制它们。<br>
  在手机上续接电脑会话、双向传文件、跑定时任务、调度多个 agent worker，也可以把同一套 bridge 暴露到团队聊天里。
</h3>

<p align="center">
  <a href="#先从这里开始">先从这里开始</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#它能给你什么">能做什么</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#产品边界">产品边界</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#核心工作流">核心工作流</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#实时网页搜索-mcpbrave--tavily">Search MCP</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#agent-bus">Agent Bus</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#服务运维">运维</a>
</p>

## 先从这里开始

**TaroCub 不是又一个托管式 agent UI。** 它在你的机器上运行真正的 Codex、Claude Code、Kimi Code 和 Antigravity CLI，然后给它们补上 Telegram 与飞书/Lark 入口、访问控制、文件投递、语音转写、定时任务、会话续接、多 bot 路由和可审计的长任务状态。

这个项目原名 `cc-telegram-bridge`。现在的规范仓库是 `cloveric/tarocub`；GitHub 会把旧 URL 重定向过来，已有状态目录和 `cctb` 简写也会继续作为兼容层保留。

最简单的安装方式：克隆仓库，用 Codex、Claude Code、Kimi Code 或 Antigravity 打开它，然后直接对 agent 说：*"读一下 README，帮我配置一个 Telegram bot"*。这个项目本来就是给 CLI agent 自己安装和运维的。

```bash
npm install
npm run build
npm run dev -- telegram configure <telegram-bot-token>
npm run dev -- telegram yolo on
npm run dev -- telegram service start
```

然后给 bot 发一条消息，按它给出的配对命令完成授权，就可以从 Telegram 继续用本机的 Codex/Claude/Kimi/Antigravity 了。完整流程见 [快速开始](#快速开始)。

> **推荐运行方式：** 对你自己控制、希望免打断运行的 Telegram 实例，建议开启 YOLO 模式：`telegram yolo on --instance <name>`。如果关闭 YOLO，bridge 也会尽量在 Telegram 里弹审批按钮：Claude 和 Kimi 是按工具请求审批；Codex process 模式与 Antigravity 是按整轮 turn 预审批。Kimi `full-auto` 映射 ACP `yolo`，`unsafe/bypass` 映射 ACP `auto`。unsafe 模式只建议在可信机器和可信工作区使用。

## 它能给你什么

| 能力 | 实际意义 |
|---|---|
| **真实 CLI 的远程控制** | 把 Codex、Claude Code、Kimi Code 或 Antigravity 接到 Telegram，不把它们改造成一个假的聊天后端。 |
| **会话连续性** | 在手机上续接 Claude 本地 session、绑定 Codex thread、Kimi ACP session 或 Antigravity conversation，回到电脑后还能继续同一件事。 |
| **Telegram 多模态输入输出** | 文件、图片、生成产物、语音消息、音频 document 都走同一套 bridge 协议。 |
| **稳定的长任务运维** | cron、audit、timeline、usage tracking、访问控制和服务重启都由 bridge 管，不塞进模型记忆。 |
| **可追溯网页研究** | 可选 Brave/Tavily MCP 提供 `web_search`、`web_extract`、provider status、fallback notice 和 source log。 |
| **多 agent 编排** | Agent Bus 做实例间 delegation，Mini Bus 做 topic 间协作，Board 做持久化 Kanban 任务。 |
| **飞书/Lark 通道（推荐）** | 通过官方 Lark Channel SDK 复用同一个 bridge runtime，支持 streaming card、停止按钮、审批和文件/媒体投递标签。 |

## 飞书 / Lark 通道（推荐）

**飞书/Lark 是目前推荐、也是主力开发的通道** —— 交互卡片、审批、Docs 评论、Sheets/Docs/Drive 工作流、群/话题协作都在这一侧。Telegram 仍然完整支持、测试时间也最久，但已不再是日常主用平台。两个通道复用同一套 engine adapter、session、workspace、`agent.md`、审批模型和文件投递标签。

```bash
npm run build
node dist/src/index.js lark wizard   # 扫码创建/绑定 PersonalAgent app
node dist/src/index.js lark provision # 对现有 app 重新检查/补齐权限订阅
node dist/src/index.js lark status
node dist/src/index.js lark doctor
node dist/src/index.js lark service start
node dist/src/index.js lark service logs 80
node dist/src/index.js lark service restart
node dist/src/index.js lark service restart --all
node dist/src/index.js lark service status --all
node dist/src/index.js lark timeline 20
node dist/src/index.js lark audit 20
node dist/src/index.js lark dashboard
```

在活跃的 Lark bot turn 里执行 `lark service restart --all` 时，当前 Lark 实例会自动改成延迟重启，等回复完成后再重启自己。不要在 Lark bot 里手写 shell 循环逐个 restart Lark 实例，否则容易先杀掉当前执行链。

`lark wizard` 会走官方 Lark SDK 的 PersonalAgent 注册流程，在终端打印二维码，把凭据保存到 `~/.cctb/lark/lark.env`（或 `CCTB_LARK_STATE_DIR/lark.env`），然后检查 bridge 需要的能力：接收消息事件、卡片回调、bot 发消息/资源权限、飞书文档权限。如果 app 有管理权限，wizard 会补齐事件/回调订阅；如果没有，会明确告诉你缺哪个管理 scope。如果你更想手动填凭据，环境变量仍然优先：

```bash
export LARK_APP_ID="cli_xxx"
export LARK_APP_SECRET="..."
```

可选环境变量：

| 变量 | 含义 |
|---|---|
| `CCTB_LARK_STATE_DIR` | Lark 服务的状态和 workspace 目录，默认 `~/.cctb/lark`。 |
| `CODEX_TELEGRAM_INSTANCE` | 复用现有 engine 配置时使用的实例名，默认 `lark`。 |
| `LARK_DOMAIN` | 需要时覆盖 Lark/飞书 API domain。 |
| `LARK_REQUIRE_MENTION_IN_GROUP` | 默认 `true`；群消息必须提到 bot 才会触发，除非显式关闭。 |
| `CCTB_LARK_DOC_CREATE_AS` / `LARK_DOC_CREATE_AS` | 可选 `user`/`bot`，控制 `lark.doc.create` 的创建身份；默认 `bot`。 |

当前 Lark 通道支持：

- p2p/group 消息进入同一条 `Bridge.handleAuthorizedMessage` 路径，并复用 Telegram 侧同一套 pairing/allowlist 访问控制；
- 基础聊天命令：`/help`、`/status`、`/usage`、`/model`、`/effort`、`/fast`、`/engine`、`/yolo`、`/goal`、`/btw`、`/ask`、`/reset`、`/detach`、Claude/Antigravity `/resume` 扫描选择、显式 `/resume thread ...` / `/resume session ...` / `/resume conversation ...`、`/cron`、`/board`、`/mini`、`/fan`、`/chain`、`/verify`、`/stop`、Lark `/q`（运行中强制排队）；
- 私聊主时间线使用 `lark:<chat_id>` 连续会话；私聊中的真实 thread/topic 使用 `lark:<chat_id>:<thread_id>` 独立会话，但访问授权仍绑定父私聊；
- 群聊是否按 thread 隔离取决于飞书“群消息形式”：话题群或 thread 形式群按 topic 独立，普通对话形式群的 reply/thread 继续共享全群会话；
- `/newgroup <名>`、`/newgroup topic <名>`、`/newtopic <名>` 默认由实例 bot 创建并拉入发起人；显式用户 OAuth 模式则由 OAuth 用户创建。两条路径都会确保实例 bot 入群并自动授权新群；默认仍需 @bot，只有显式 `/group all` 才监听普通消息；
- streaming interactive card 和 Card 2.0 callback 停止按钮；
- 引擎权限请求审批卡片，点击审批前会按操作者重新走 bridge 访问控制；
- 收到图片/文件资源后只在当前 turn 临时下载，完成 staging/转写后清理临时输入；
- 通过 `[send-file:/abs/path]`、`[send-image:/abs/path]`、`send.audio`、`send.video` 和 `send.batch` tool tag 把文件/图片/音视频发回 Lark；
- 通过 `lark.post` tool tag 发送富文本/图文混排消息；
- 通过 `lark.card` tool tag 发送自定义交互卡片，按钮点击会回流到同一个 bridge session；
- 通过 `lark.doc.create` 创建飞书文档，适合长 specs/docs 和可评论反馈的材料；默认用 app/bot 身份创建，确实需要本机 `lark-cli` 用户身份时可显式 `as:"user"`；
- 飞书云文档评论 @bot：bridge 会拉取评论上下文，跑同一套 engine，并回复到评论线程；评论里可以执行 `lark.doc.create`，但聊天投递/定时任务类工具会明确提示不支持，不再静默吞掉；
- 通过 `/cron` 创建飞书/Lark 侧定时提醒和定时任务，每条任务保存 raw Lark chat 路由，scheduler 触发后能回到正确的 Lark 会话；
- 通过 `/board` 管理持久 Kanban 任务，复用 Telegram 的 `board.json` 状态模型，同时 timeline 记为 `channel=lark`；
- 通过 `/mini` 把飞书群 thread 注册成具名 peer，支持 ask/fan/chain/verify/crew 这类 thread-to-thread 协作；
- 通过 `/fan`、`/chain`、`/verify` 调用 Agent Bus，复用 Telegram 同一套 `bus.parallel`、`bus.chain` 和 `bus.verifier` 配置；
- 飞书合并转发消息会保留为 `<forwarded_lark_messages>` 任务上下文，方便“一键转发给 bot 处理”；
- 按 state dir 加 Lark 服务锁，并提供 `lark service start|stop|restart|status|logs|doctor`，误开多个 `lark run` 时不会让多个进程同时消费同一批飞书事件，恢复也更像 Telegram service；
- `lark send --chat <oc_xxx>` 支持本地 CLI 主动发文本/文件/图片到 Lark，必须显式指定目标 chat，避免误发到上一次保存的会话；
- timeline 会记录 `channel=lark`，并提供 Lark 专用的 `lark timeline` / `lark audit` / `lark dashboard` 别名，所以不用再绕到 Telegram CLI 也能检查 Lark 流量。

访问控制故意复用现有 bridge store。未配对的 Lark 私聊不会直接跑引擎，而是返回配对/allowlist 指引。现在可以直接用 Lark 专用别名管理 Lark state dir：`node dist/src/index.js lark access pair <code>`、`lark access allow <numeric-chat-id>`、`lark access policy allowlist` 和 `lark access status`。

Lark 专用 tool tag 沿用 Telegram side-channel 的紧凑 JSON 写法：

```text
[tool:{"name":"lark.card","payload":{"title":"请选择","body":"下一步怎么做？","actions":[{"label":"继续","value":"continue"}]}}]
[tool:{"name":"lark.doc.create","payload":{"title":"Spec","content":"# Spec\n\n正文","docFormat":"markdown"}}]
[tool:{"name":"send.video","payload":{"path":"/absolute/path/demo.mp4"}}]
```

如果传 raw `lark.card` payload，bridge 会在存在会话上下文时给普通按钮自动补 Card 2.0 `behaviors: [{type:"callback", value: ...}]` 回调 metadata；如果你已经显式提供 callback metadata，则保留你的自定义回调。

`lark-cli` 适合在 agent turn 里处理飞书 Docs/IM/Calendar 等操作，但它不是入站 bot transport。入站长连接使用 `@larksuiteoapi/node-sdk`，因为它直接提供 normalized message event、card callback、streaming card 和 media helper。

## 产品边界

| 它是 | 它不是 |
|---|---|
| 一个把现有 Codex / Claude Code / Kimi Code / Antigravity 暴露到 Telegram，并可选暴露到飞书/Lark 的本地 bridge。 | 一个托管 SaaS agent 平台，或这些原生 CLI 的替代品。 |
| 一个管理会话、文件、审批、定时任务和多 agent 路由的控制层。 | 一个模型供应商、推理服务或独立 LLM runtime。 |
| 一个给重度 CLI agent 用户使用的实用运维层。 | 一个面向所有 IM 平台的通用聊天机器人框架。 |
| 一个把 delivery receipt、审计日志和任务状态移出脆弱 prompt 的地方。 | 一个保证模型永远自动正确完成任务的魔法盒。 |

## 核心工作流

| 工作流 | 入口 |
|---|---|
| **个人手机 copilot** — 人在外面，也能操作电脑上的 Codex/Claude/Kimi/Antigravity。 | [快速开始](#快速开始)、[会话续接](#会话续接codex-threadkimi-session-与-antigravity-conversation) |
| **研究助手** — 搜索、直接读取 URL、保留 source log，再把文件发回 Telegram。 | [Search MCP](#实时网页搜索-mcpbrave--tavily)、[文件投递](#agent-任务里的文件投递) |
| **Topic mini crew** — 把一个 Telegram 群里的 forum topics 当 planner/writer/reviewer peers。 | [Mini Bus](#mini-bustopic-到-topic-的工作流)、[Telegram 群聊和 Topic](#telegram-群聊和-topic) |
| **持久化任务板** — 把 task、依赖、run、WIP limit 和 review gate 放到模型上下文之外。 | [Board](#board持久化-kanban-任务板) |
| **多 Bot agent bus** — 在隔离 bot 实例之间 delegation，带 health check 和版本化本地协议。 | [Agent Bus](#agent-bus)、[Crew Workflow](#crew-workflow中心协调) |

## 近期亮点

- **v0.1.149–v0.1.151** — Codex 任务运行中可“边跑边补话”：纯文本直接注入当前 turn（`turn/steer`，OK 表情确认），`/q <消息>` 强制独立排队；`/model fable` 接入 Claude Fable 5；一轮 19 项审计修复（`/stop` 真正中断 Codex、配对码过期锁修复、Lark 日志轮转等）。
- **v4.6.53** — 收紧飞书/Lark 产品边界：Telegram `service --all` 不再误扫 `~/.cctb/lark`，Lark 临时附件 turn 后清理，`lark send` 必须显式 `--chat`，Docs 默认用 bot 身份创建，doctor 复用统一 secret 脱敏。
- **v4.6.51–v4.6.52** — 补齐 Lark 主要 parity：直接最终回复、Lark 路由 `/cron`、`/board`、`/mini`、`/fan`、`/chain`、`/verify`、`/goal`，以及 service/audit/dashboard aliases 和 Telegram Markdown 投递加固。
- **v4.6.42–v4.6.46** — 新增 QR `lark wizard`、`lark provision`、domain-safe PersonalAgent setup、权限/订阅检查，以及飞书云文档评论 @bot 后 in-thread 回复。
- **v4.6.39–v4.6.41** — 引入飞书/Lark 通道预览：官方 Channel SDK 长连接、消息/卡片回调、服务锁、资源投递、Docs 创建、Card 2.0 callback behaviors。
- **v4.6.22** — 新增 Antigravity CLI 第三后端，引入 `/engine antigravity`、YOLO/full-auto、conversation 绑定和 print-mode 模型 guardrails。
- **v4.6.10–v4.6.18** — 加固 Telegram 核心：Codex/Claude `/goal`、音视频 ASR、`/stop` 旧进程清理，以及 Search MCP 的 `web_extract`、source log、provider metadata 和 health check。
- **v4.6.2** — 新增 `/board` 持久化 Kanban 和 `/mini` topic/thread workflow。

**升级已有 generated 实例指令：** 更新代码后请刷新已生成的 `agent.md` block，让旧 bot 拿到最新短 Telegram Transport block：

```bash
telegram instructions upgrade --all --dry-run
telegram instructions upgrade --all
telegram service restart --all
```

只有当某个实例有自定义 transport block 且你确认要覆盖时，才使用 `--force`。强制覆盖前会在原文件旁边创建 `agent.md.bak.<timestamp>` 备份。

---

## 为什么是这套架构

- **优先保留原生 CLI 能力。** bridge 运行的是真正的 Codex、Claude Code、Kimi Code 和 Antigravity CLI，所以本地认证、项目文件、会话、审批和引擎原生行为都尽量和桌面端保持一致。
- **随时续接电脑上的工作。** 在 Telegram 或 Lark 里接上本地 Codex、Claude Code、Kimi 或 Antigravity 会话，人在外面也能继续发文件、补指令；回到电脑后还能接着同一个项目继续做。会话和恢复后的 workspace 按私聊、群聊或 topic 隔离，其他对话不会静默切换到这个项目。
- **群聊 topic 可以当干净的旁路对话。** 一个 bot 可以同时服务私聊和已允许的 Telegram 群；forum topic 会有独立 session 和 cron 范围，临时任务、定时任务不会污染主对话。不同 topic 还可以组成 Mini Bus，用同一个群里的轻量 peer 跑 fan-out、chain、verify 或 crew workflow；`/board` 负责把 Kanban 任务状态持久化到模型记忆之外。
- **多引擎不需要多套玩法。** 每个 bot 可以独立选择 Codex、Claude、Kimi 或 Antigravity，但文件投递和定时任务都走同一套 schema-backed `[tool:{...}]` bridge 协议。
- **Telegram 能力放在 bridge，而不是模型记忆里。** 发文件、cron 持久化、receipt、权限检查和失败重试由 bridge 代码负责，所以换模型、重启实例、续接会话后仍然有稳定语义。
- **Prompt 短，规则稳定。** transport 规则放在实例级 `agent.md`，每轮 prompt 不再需要塞 request id、临时目录或 side-channel token。
- **看 receipt，不信口头声明。** 文件投递和定时任务创建都有结构化 accepted/rejected receipt；只有 bridge 真正发出文件或写入任务，才算完成。
- **默认可运维。** timeline、audit、doctor、dashboard、usage tracking、cron 状态和 generated 指令升级，让失败可见，也让恢复流程可重复。

---

## 多引擎：Codex + Claude Code + Kimi Code + Antigravity

每个 bot 实例可以独立选择 **OpenAI Codex**、**Claude Code**、**Kimi Code** 或 **Antigravity CLI** 作为后端引擎，一条命令即可切换：

```bash
# 将某个实例设为 Claude Code
npm run dev -- telegram engine claude --instance review-bot

# 将另一个设为 Codex
npm run dev -- telegram engine codex --instance helper-bot

# 将另一个设为 Kimi Code
npm run dev -- telegram engine kimi --instance kimi-bot

# 将另一个设为 Antigravity
npm run dev -- telegram engine antigravity --instance agy-bot

# 查看当前引擎
npm run dev -- telegram engine --instance review-bot
```

切到 Kimi 后，服务优先使用 `KIMI_EXECUTABLE`，否则回落到 `~/.kimi-code/bin/kimi`；CLI 需要先在本机完成认证。TaroCub 使用持久 `kimi acp` 协议。`full-auto` 映射 ACP `yolo`（自动批准工具但仍可提问），`unsafe/bypass` 映射 `auto`（完全自主）。

切到 Antigravity 时，bridge 会自动把该实例设为 YOLO/full-auto；如果你已经显式设成 `bypass`，则保留 `bypass`。原因是 Telegram 里的 `agy --print` 是非交互运行，默认就应该免打断。Antigravity 的模型选择仍由本机交互式 CLI 管：`agy --print` 不会运行交互式 `/model` 解析器，所以 Telegram 里的 `/model` 会由 bridge 本地回复限制说明，不会再当普通聊天发给模型。

| 特性 | Codex | Claude | Kimi | Antigravity |
|---|---|---|---|---|
| 协议 | app-server / `codex exec` | stream-json | `kimi acp` | `agy --print` |
| 会话恢复 | `/resume thread <id>` | `/resume` 扫描并选择 | `/resume` 通过 ACP `session/list` 扫描并选择，也支持 `/resume session <id>` | 自动绑定日志 conversation；`/resume` 扫描；`/resume conversation <id>` |
| 项目指令 | `agent.md` prompt 注入 | `agent.md` system prompt + workspace `CLAUDE.md` | workspace `.kimi-code/agents/agent.md` 主代理 override；保留 `${base_prompt}` 与 `${plugin_sections}`，实例/Lark 指令进入原生 system context | `agent.md` prompt 注入 |
| 流式与工具 | 原生事件 | 原生事件 | ACP 文本、思考、工具、审批事件 | stdout chunk |
| 审批 | app-server 沙箱 / process 整轮预审批 | 单工具审批 | ACP 单工具审批；Lark/Telegram 单选提问 | 整轮预审批 |
| 本地 skill / MCP | 原生 skill/MCP | 原生 skill/MCP/plugin | 原生 Kimi skill/MCP/plugin + workspace 暴露 `~/.codex/skills` + 自动注入 Search MCP | 原生能力 |
| `/goal` | bridge 原生 goal | 原生命令透传 | **gap**：真机返回 `Unknown ACP command` | 原生命令透传 |
| `/steer` | app-server 中途注入 | **gap**，后续消息排队 | **gap**，ACP 无中途 prompt 注入 | **gap**，后续消息排队 |
| `/model` / effort | bridge 配置 | bridge 配置 | ACP 广告的 session option；模型 ID 在下一 turn 验证 | 由本机交互 CLI 管 |
| `/compact` | 不需要（exec 无状态） | 支持 | 支持，已真机会话验证 | 暂不支持 |
| 用量 | token（费用视 runtime） | token + USD | **gap**：ACP 0.31.1 无结构化 token/费用 | 无结构化费用 |
| 工作目录 | 实例 `workspace/` | 实例或恢复 session 的原工作区 | 实例或恢复 session 的原 `cwd`（绑定前用真实 `session/load` 校验） | 实例 `workspace/` |
| 空闲 worker | 按 runtime | stream worker 2 小时回收 | ACP worker 2 小时回收；session 可恢复 | 每轮退出 |

Kimi 的实测事件、取消、提问、恢复和 gap 证据见 [`docs/kimi-engine-notes.md`](./docs/kimi-engine-notes.md)，四引擎逐项对照见 [`docs/kimi-capability-matrix.md`](./docs/kimi-capability-matrix.md)。

## 实时网页搜索 MCP：Brave + Tavily

bridge 内置一个可选的本地 MCP server。Codex、Claude Code 和 Antigravity 可按各自原生方式注册；Kimi 实例会由 TaroCub 在 ACP 新建/恢复 session 时自动注入，同时保留 Kimi 自己的 MCP/plugin：

- `web_search`：通过 Brave 和/或 Tavily 做实时搜索。
- `web_extract`：用 Tavily Extract 清理并抽取指定 URL 正文。
- `provider_status`：检查 Brave/Tavily 是否已配置，不暴露 API key。
- `health_check`：需要排查 auth、quota、rate limit 或 timeout 时，手动发起 Brave/Tavily 真实探活；可以传 `query` 换掉默认探活词。
- 如果用户已经给了明确 URL，agent 应该先直接读取这些 URL，再用搜索做链接发现或背景补充。

它的好处不是“又多一个搜索按钮”，而是让来源链更清楚：

- Brave 适合找 URL、当前文档、价格页、新闻和普通网页结果。
- Tavily 适合偏研究的补充搜索和正文抽取。
- `verify` 模式会同时用 Brave + Tavily 交叉检查重要结论。
- 返回结果带 `sourceLog`、`provider`、`domain`、`rank`、`accessedAt`、`extractedAt`，抽取正文还带 `contentHash`。
- 如果 Brave/Tavily 其中一个失败并走 fallback，结果会带 `fallbacks` 和 `notice`，agent 应该在答案里简单说明 fallback。

配置方式：

```bash
export BRAVE_API_KEY="..."
export TAVILY_API_KEY="..."
npm run build

codex mcp add web-search \
  --env BRAVE_API_KEY="$BRAVE_API_KEY" \
  --env TAVILY_API_KEY="$TAVILY_API_KEY" \
  -- node "$PWD/dist/src/index.js" search-mcp

claude mcp add web-search \
  -e BRAVE_API_KEY="$BRAVE_API_KEY" \
  -e TAVILY_API_KEY="$TAVILY_API_KEY" \
  -- node "$PWD/dist/src/index.js" search-mcp
```

Kimi 无需为 TaroCub Search MCP 手工注册；Antigravity 侧如需原生 MCP/plugin，请使用 Antigravity 自己的配置方式。默认 bridge 配置不应该跨引擎导入原生插件。bridge 可以跨引擎复用 skill 文档和工具使用规则，但每个实例的 `agent.md` 与各引擎原生插件系统仍然各自独立。

配置后重启相关 bot 实例，让新进程继承环境与原生 MCP/plugin 配置；Kimi 会自动获得 TaroCub Search MCP。Codex process 模式如果大量使用 MCP，建议使用 YOLO/full-auto/bypass 实例；普通非交互 `codex exec` 的 read-only approval 模式可能会取消 MCP tool call。更多细节见 [`docs/search-mcp.md`](./docs/search-mcp.md)。

### Claude 引擎：CLAUDE.md 支持

使用 Claude 引擎时，每个实例会有一个 `workspace/` 目录。在里面放一个 `CLAUDE.md` 就能定义项目级指令：

```
~/.cctb/review-bot/
├── agent.md              ← "你是一个严格的代码审查员"
├── workspace/
│   └── CLAUDE.md         ← "TypeScript 项目，用 ESLint，不要改测试文件"
├── config.json           ← { "engine": "claude", "approvalMode": "full-auto" }
└── .env
```

两层指令互不冲突：
- **agent.md** → bot 人格（通过 `--system-prompt` 注入）
- **CLAUDE.md** → 项目规则（Claude 从工作目录自动发现）

---

## 多 Bot 部署

想开多少个 bot 就开多少个。每个实例完全隔离 — 独立的引擎、token、人格、线程、访问规则、收件箱和审计日志。默认语义仍然是“一实例一个聊天”；多聊天是显式开启的例外模式。

```
          ┌─────────────────────────────────────────────┐
          │                  TaroCub                     │
          └────────────┬──────────────┬─────────────────┘
                       │              │
        ┌──────────────┼──────────────┼──────────────┐
        ▼              ▼              ▼              ▼
 ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
 │  "default" │ │   "work"   │ │ "reviewer" │ │ "research" │
 │  引擎:     │ │  引擎:     │ │  引擎:     │ │  引擎:     │
 │   codex    │ │   codex    │ │   claude   │ │   claude   │
 │            │ │            │ │            │ │            │
 │ agent.md:  │ │ agent.md:  │ │ agent.md:  │ │ agent.md:  │
 │ "通用助手" │ │ "中文回复" │ │ "严格审查" │ │ "深度研究" │
 └────────────┘ └────────────┘ └────────────┘ └────────────┘
   PID 4821       PID 5102       PID 5340       PID 5520
```

### 30 秒部署

```bash
# 配置各实例
npm run dev -- telegram configure <token-A>
npm run dev -- telegram configure --instance work <token-B>
npm run dev -- telegram configure --instance reviewer <token-C>

# 设置引擎
npm run dev -- telegram engine claude --instance reviewer

# 设置人格
npm run dev -- telegram instructions set --instance reviewer ./reviewer-instructions.md

# 推荐：给 Telegram/手机使用开启 YOLO
npm run dev -- telegram yolo on --instance work

# 全部启动
npm run dev -- telegram service start
npm run dev -- telegram service start --instance work
npm run dev -- telegram service start --instance reviewer
```

---

## Agent 指令

每个 bot 有自己的 `agent.md`。每条消息都会重新加载 — 随时编辑，无需重启。

```bash
npm run dev -- telegram instructions show --instance work
npm run dev -- telegram instructions set --instance work ./my-instructions.md
npm run dev -- telegram instructions path --instance work
```

也可以直接编辑文件：

```bash
# Windows
notepad %USERPROFILE%\.cctb\work\agent.md

# macOS
open -e ~/.cctb/work/agent.md
```

---

## Agent 任务里的文件投递

每个 Telegram turn 运行时，bridge 会通过注册过的 Telegram tool layer 投递生成文件。Agent 面向的标准形式是内联 tool tag：

```text
[tool:{"name":"send.file","payload":{"path":"/absolute/path/to/report.pdf"}}]
[tool:{"name":"send.image","payload":{"path":"/absolute/path/to/image.png"}}]
[tool:{"name":"send.batch","payload":{"message":"Done","images":["/absolute/path/to/image.png"],"files":["/absolute/path/to/report.pdf"]}}]
```

如果 payload 较长或包含很多引号，也可以输出同一个 tool envelope 的 fenced block：

````text
```tool-call
{"name":"send.file","payload":{"path":"/absolute/path/to/report.pdf"}}
```
````

CLI 工作流里，bridge 仍会把稳定的 `cctb` 命令注入到支持 turn-scoped env 的 engine 进程：

```bash
cctb send --image /absolute/path/to/image.png
cctb send --file /absolute/path/to/report.pdf
cctb send --message "Done" --file /absolute/path/to/report.pdf
```

在 active Telegram turn 内，`cctb send` 会走 turn-scoped side-channel，并保留当前 chat/session 上下文。active turn 外也可以直接用仓库 CLI，它会回退到已配置实例和当前活跃 Telegram session：

```bash
telegram send --image /absolute/path/to/image.png
telegram send --file /absolute/path/to/report.pdf
telegram send --chat 123456789 --file /absolute/path/to/report.pdf
telegram send --instance bot2 --chat 123456789 --image /absolute/path/to/image.png
```

当前投递约定：

- Agent 应该用 `[tool:...]` 投递已存在的文件、图片、PDF、PPT 和其他二进制产物。这是生成实例指令唯一教给 agent 的投递 tag 格式。
- `[tool:...]` 示例由注册过的 tool schema/examples 生成；显式 fenced `tool-call` block 也走同一个解析器。
- `cctb send` 仍可用于 turn-scoped CLI 工作流，并且内部会走同一套 send tool layer。
- active turn 外，或者 turn-scoped `cctb` helper 不可用时，用 `telegram send` 做同一条显式投递链路。
- 显式发送命令接受任意可读绝对路径。
- 旧的 `[send-file:/absolute/path]` / `[send-image:/absolute/path]` 仅作为旧会话和历史输出兼容保留。新的 agent 指令、system prompt 和示例不要再使用它们。
- 小型文本/代码文件仍可用 `file:name.ext` fenced-block 形式返回。
- helper 只在当前 Telegram turn 有效，turn 结束后不能再用。
- `[tool:...]` / `cctb send` / `telegram send` 显式发送接受任意可读绝对路径；legacy fallback tag 仍按旧的 workspace / `/resume` 路径规则校验。
- Telegram 与 Lark 都会拒发 `.env*`、`*.pem`、`*.key`、`id_rsa`、`id_ed25519` 等凭据形态文件，即使文件位于允许的 workspace 内也不例外。
- 文件投递成功和拒绝都会记录为 turn 级 receipt，所以 bridge 可以用结构化交付证据判断是否完成，而不是相信文本声明。
- 如果某个文件已经通过 stream delivery 或 side-channel helper 发过，最终 `.telegram-out` 扫描会按真实路径跳过它，避免 Telegram 重复附件。
- request-scoped `.telegram-out/<requestId>/` 目录只是运行时缓冲区，24 小时后自动清理。
- Telegram 收到的附件默认保留 3 天后清理，可用 `TELEGRAM_INBOUND_FILE_RETENTION_DAYS` 调整。
- bridge 不再保留 manifest、pending contract 或基于数量的状态来推断普通聊天 turn 里的未来交付意图。
- 纯文本任务不会误当成文件交付失败，例如图片分析、图片描述、内联报告；除非用户明确要求保存、导出、发送或交付文件。

这对 Codex、Claude、Antigravity、process 和 stream runtime 都有效，因为标准路径只要求 agent 能输出文本。文件投递现在是显式动作：生成文件，输出 tool tag 或调用发送命令，然后依赖 receipt。

从 v4.5.0 或更早版本升级时，请刷新已生成的实例指令：

```bash
telegram instructions upgrade --all --dry-run
telegram instructions upgrade --all
```

这个命令会安全替换旧的 generated Telegram Transport block；缺少 transport section 时会追加。自定义 transport section 默认不会覆盖，除非显式加 `--force`。`--force` 覆盖前会在原文件旁边创建 `agent.md.bak.<timestamp>` 备份。

---

## 定时任务 / Cron

Agent 可以通过和文件投递同一套 tool layer 创建 Telegram 投递的提醒和周期任务：

```text
[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check email"}}]
[tool:{"name":"cron.add","payload":{"at":"2026-05-01T09:00:00Z","prompt":"Monday standup"}}]
[tool:{"name":"cron.add","payload":{"cron":"0 9 * * 1","prompt":"weekly summary"}}]
```

用户也可以直接在 Telegram 里管理任务：

```text
/cron list
/cron add 0 9 * * 1 weekly summary
/cron rm <job-id>
/cron toggle <job-id>
/cron mode <job-id> new_per_run
/cron run <job-id>
```

这套 cron 是为了 Telegram 投递设计的，不是 Claude/Codex 自己的 session-local reminder：

- 任务持久化在实例状态里，bot 重启后仍会加载。
- `chatId`、`userId`、`chatType` 由 bridge 注入，不信任 agent payload 里的同名字段。
- 支持相对提醒（`in`）、绝对时间（`at`）和 5 字段 cron 表达式（`cron`）。
- 每个任务会保存 timezone；默认跟随运行 bot 的服务器/实例环境。
- 停机太久后，过期的一次性提醒会标记为 missed，不会在启动时暴雨式补发。
- 周期任务会记录失败次数和有上限的 run history，连续失败后可以自动停用。
- 定时任务默认使用 `sessionMode: "new_per_run"`，每次触发都开干净上下文，不继承创建任务时的聊天上下文；只有明确要“接着当前会话继续”的任务才使用 `sessionMode: "reuse"`。
- 这个默认值上线前创建的旧任务会保留已存储的模式；可用 `/cron mode <job-id> new_per_run` 原地升级旧周期任务，不必删除重建。
- 每个 chat 有任务数量上限，防止任务递归创建导致无限增长。

人类运维仍然可以用 CLI 检查和调试；但 generated instructions 会要求 agent 使用 `[tool:{...}]` layer，这样 Claude/Codex/Kimi/Antigravity 的 process、stream 和 ACP runtime 行为一致。

---

## YOLO 模式

如果你希望 Telegram bot 免打断运行，推荐开启 `telegram yolo on`。如果保持 YOLO 关闭，bridge 会用 Telegram 审批按钮接住无头审批：Claude 可以按单个权限请求审批；Codex app-server 模式会把 YOLO 设置映射到 app-server sandbox mode；Antigravity process 模式会做整轮 turn 预审批。`unsafe` 只适合完全可信的本地环境。

Claude 审批按钮会启动一个短生命周期的 localhost MCP bridge，并带随机 URL token。它能挡住盲扫本地端口的进程，但同一用户下能查看进程命令行的本地进程仍可能看到 token。所以 YOLO 关闭时的审批适合单用户工作站便利操作，不等于多用户隔离边界。

```bash
npm run dev -- telegram yolo on --instance work      # 安全自动审批
npm run dev -- telegram yolo unsafe --instance work   # 跳过所有检查
npm run dev -- telegram yolo off --instance work      # 恢复正常流程
npm run dev -- telegram yolo --instance work          # 查看状态
```

| 模式 | Codex | Claude | 适用场景 |
|---|---|---|---|
| `off` | Telegram 预审批整轮 turn | Telegram 工具审批 | 默认，最安全 |
| `on` | `--full-auto` | `--permission-mode bypassPermissions` | 手机操作 |
| `unsafe` | `--dangerously-bypass-*` | `--dangerously-skip-permissions` | 仅限可信环境 |

热加载 — 不用重启 bot，CLI 切一下立刻生效。

---

## 用量追踪

按实例追踪 token 消耗和费用：

```bash
npm run dev -- telegram usage                    # 默认实例
npm run dev -- telegram usage --instance work    # 指定实例
```

输出：
```
Instance: work
Requests: 42
Input tokens: 185,230
Output tokens: 12,450
Cached tokens: 96,000
Estimated cost: $0.3521
Last updated: 2026-04-09T10:00:00Z
```

Claude 报告精确 USD 费用，Codex 仅报告 token 数。

---

## 运行可见性与 Timeline

turn 运行期间，bridge 会向 Telegram 发送 typing action，并把结构化事件写入 `timeline.log.jsonl` / `audit.log.jsonl`。长工具调用不会实时编辑聊天里的消息内容；需要排查时看：

```bash
npm run dev -- telegram timeline --instance work
npm run dev -- telegram dashboard --instance work
npm run dev -- telegram service status --instance work
```

`telegram verbosity` 仍作为兼容配置保留，但当前 Codex/Claude/Kimi/Antigravity runtime 使用的是 typing action + timeline/audit 事件，不会把模型的中间输出实时改写到 Telegram 消息里。

---

## 预算控制

为每个实例设置消费上限。当总费用达到上限时，新请求将被拦截，直到提高或清除预算。

```bash
npm run dev -- telegram budget show --instance work     # 当前花费与上限
npm run dev -- telegram budget set 10 --instance work   # 上限 $10
npm run dev -- telegram budget clear --instance work    # 移除上限
```

预算实时执行 — 达到上限时 bot 会用中英双语提示。

---

## 语音输入（ASR）

在 Telegram 发送语音/音视频，或在飞书/Lark 发送音频/视频资源，桥接器都会在进入 Claude、Codex、Kimi、Antigravity 适配器**之前**完成转写。短音频走本机 Qwen ASR，无需云端服务。

**长音频自动走云端（通义听悟，可选）**：配置后，**≥ 15 分钟**的音频/视频自动路由到阿里云通义听悟离线转写（30 分钟音频约 40 秒出全文），短音频仍走本机 Qwen。未配置时全部走本地；云端失败时按安全分片回退本地。

- 激活：`TINGWU_ASR_DIR=/path/to/tingwu_asr`，指向已配好的听悟脚本目录（脚本自带 OSS 上传/任务轮询/临时对象清理，密钥留在该目录的 `.env.local`，桥不读取也不记录）
- 阈值：`ASR_CLOUD_THRESHOLD_SECONDS`（默认 900 秒）
- 超时：`ASR_CLOUD_TASK_TIMEOUT_SECONDS`。不设置时，脚本自己的 `--timeout` 是 7200 秒，但**子进程最多跑 15 分钟**就会被杀掉——否则一个卡住的云端任务会把这个会话的队列占用两小时。显式设置这个变量会同时抬高（或压低）这两个上限
- 任务目录保留：`ASR_CLOUD_JOB_RETENTION_DAYS`（默认 7 天），每次新任务顺手清理过期的 `<state>/asr-jobs/<id>/`
- **变量写在哪里**：Lark 侧直接写进 `~/.cctb/<实例>/lark.env` 即可——这四个走**白名单配置通道**（`loadLarkRuntimeEnv`，和 `LARK_APP_ID` 同一条路），服务启动重写该文件时会保留；也可以导出到启动服务的进程环境，环境变量优先。注意区分同一个文件里的两条路：它们走**白名单**，不走 **extras 透传**——透传只把引擎凭据（`IFIND_TOKEN` 这类 MCP token）转给引擎子进程，并拒绝所有桥保留前缀（`CCTB_`、`TAROCUB_`、`LARK_`、`CODEX_`、`CLAUDE_`、`ANTIGRAVITY_`、`ASR_`、`TELEGRAM_`、`TINGWU_`），因为这些控制桥自身行为（`TINGWU_ASR_DIR` 指向桥**要去执行 python 脚本**的目录），所以引擎写入的 extras 永远改不了它。被拒的 extras 会在启动时打印 `[lark] lark.env: ignored bridge-reserved keys …`
- **密钥必须放在任何引擎工作区之外**：本机约定放 `~/.tarocub-secrets/tingwu_asr`，这样在 `~/.cctb/<instance>/workspace` 里干活的 agent 读不到、也提交不了这些凭据
- **消息内开关**：「强制本地转写」/「强制云端转写」必须和音频在**同一条消息或同一批**发送（当作附件说明）才生效——纯语音消息没有 caption，事后再发是新的一轮，改不了已经开跑的转写（冲突时本地优先）
- 云端失败自动回退本地；任务产物（原始 JSON/日志/纯文本）保存在 `<state>/asr-jobs/<id>/` 便于追溯
- `/stop` 会中断时长探测、ffmpeg 切片、Qwen CLI/听悟子进程，并停止等待本地 Qwen HTTP；用户主动取消不会被误报成“转写失败”，也不会取消后又切换路径重跑。已进入模型内核的本地 HTTP 请求可能仍会在后台收尾，但不会继续占用 bot 的会话队列

**工作原理：**

1. 用户在 Telegram 发送语音/音视频，或在飞书/Lark 发送音频/视频资源
2. 桥接器下载媒体并探测时长
3. 低于阈值时走本机 Qwen ASR（HTTP 优先、CLI 备用）；达到阈值时走通义听悟，云端失败再安全分片回退本地
4. 桥接器把转写文本追加到用户消息后，才交给当前 Claude、Codex、Kimi 或 Antigravity 引擎

**以 Qwen3-ASR 为例搭建：**

```bash
git clone https://github.com/nicoboss/qwen3-asr-python
cd qwen3-asr-python
python -m venv venv
source venv/bin/activate
pip install -e .
huggingface-cli download Qwen/Qwen3-ASR-0.6B --local-dir models/Qwen3-ASR-0.6B
```

| 方式 | 地址/路径 | 延迟 | 说明 |
|------|-----------|------|------|
| HTTP 服务 | `POST http://127.0.0.1:8412/transcribe` | ~2-3s | 模型常驻内存，推荐 |
| CLI 备用 | `~/projects/qwen3-asr/transcribe.py <文件>` | ~30s | 每次加载模型 |

**可选 ASR 守护：**

bridge 默认不会主动启动任意 ASR 进程。只有你显式在实例 `.env` 里配置修复命令后，它才会在 HTTP ASR 连续失败后尝试重启本地 ASR 服务：

```bash
ASR_SERVICE_COMMAND='curl -fsS --max-time 2 -X POST http://127.0.0.1:8412/shutdown >/dev/null 2>&1 || true; sleep 2; cd "$HOME/projects/qwen3-asr" && exec "$HOME/projects/qwen3-asr/venv/bin/python3" "$HOME/projects/qwen3-asr/server.py" >> "$HOME/.cctb/asr-server.log" 2>&1'
ASR_RESTART_AFTER_FAILURES=2
ASR_RESTART_COOLDOWN_MS=60000
```

这个守护只覆盖常驻 HTTP ASR 服务。CLI 备用仍然可以转写，但不会被当作 daemon 管理。

**自定义 ASR：** 修改 `src/telegram/message-input.ts` 中的 `createDefaultTranscribeVoice()` 函数即可适配其他 ASR 引擎。

---

## 会话续接、Codex Thread、Kimi Session 与 Antigravity Conversation

在电脑上用 Claude Code 开了个头？发 `/resume` 就能在 Telegram 上接着干 — 不用重复解释上下文。用的是 Codex、Kimi 或 Antigravity？那就直接用 thread / session / conversation id 绑定现有会话，再从 Telegram 继续。

### Claude 本地 session 续接

```
/resume          ← Bot 扫描本地最近 1 小时的 session
```

Bot 列出最近的 session：

```
最近的本地 session：
1. [tarocub] 64c2081c… (5m ago)
2. [my-app] a3f8b21e… (32m ago)

回复 /resume <编号> 继续该 session。
```

选一个：

```
/resume 1        ← Bot 自动建软链、切工作区、绑 session
```

之后发的每条消息都走原始 session — 相同的上下文、相同的项目目录、相同的对话历史。完成后：

```
/detach          ← 解绑 session；如果存在 /resume 前的旧对话，就恢复它
```

**底层原理：**

1. 优先扫描 `CLAUDE_CONFIG_DIR/projects/`，未设置时回退到 `~/.claude/projects/`，查找最近 1 小时内修改过的 `.jsonl` 文件
2. 绑定 session ID，将工作区切换到你的真实项目路径
3. Claude CLI 在原目录用 `-r <sessionId>` 继续
4. `/detach` 会优先恢复 /resume 前的旧对话；如果没有旧对话，再回到默认工作区。本地 session 文件本身不会被改动

**零污染：** bridge 和实例指令都是每次调用时传入，不会写回本地 session 文件。

### Codex thread 绑定

Codex 没有和 Claude 一样的本地 session 扫描入口。如果你已经知道 thread id，可以直接绑定：

```text
/resume thread thread_abc123
```

绑定后：

- Telegram 里的后续消息会继续这个 Codex thread
- `/status` 会显示当前 thread id
- `/detach` 会解绑该 thread；如果存在绑定前的旧对话，就恢复它

这是一种“绑定已有 thread”的流程，不是导入本地 session：thread 仍然在服务端，bridge 只是在当前 chat 上绑定一个已知 thread id。

注意：默认的 Codex app-server runtime 会通过本机 Codex runtime 验证 `/resume thread <thread-id>`。如果这个 thread id 不在本机索引里，仍然会 fail closed，而不是猜测绑定成功。

### Kimi ACP session 绑定

Kimi ACP 提供 `session/list`。直接发 `/resume` 可以列出最近 session，再用 `/resume <编号>` 选择；如果已经知道 session id，也可以显式绑定：

```text
/resume session session_abc123
```

bridge 会用短生命周期 ACP 连接先执行真实 `session/list` 和 `session/load`，以 Kimi 返回的原始 `cwd` 为准。只有 session 可加载且原工作区仍是有效目录时才会改写聊天绑定，并把该 `cwd` 持久化给后续 turn；不存在、工作区不匹配或不可加载的 ID 会 fail closed。

绑定后：

- 后续消息在原项目工作区继续该 Kimi ACP session
- `/status` 显示当前 session id
- `/detach` 解绑该 session；如果存在绑定前的旧对话，就恢复它

Kimi 的实例/Lark 指令写入 bot 自有工作区的 `.kimi-code/agents/agent.md` 主代理 override，并保留 Kimi 内置 `${base_prompt}` 和 `${plugin_sections}`。本机 `~/.agents/skills`、Kimi plugin skills 与原生 MCP 继续由 Kimi 发现；TaroCub 还把 `~/.codex/skills` 暴露到 bot 自有工作区，并在 `session/new`/`session/load` 注入 Search MCP。对于外部恢复工作区，bridge 不修改对方项目文件，只对普通文本 turn 使用 prompt fallback；这是 ACP 没有直接 system-prompt 请求字段时的安全边界。

### Antigravity conversation 绑定

Antigravity print mode 会把当前 conversation ID 写进 CLI 日志。bridge 会读取这些日志，在成功运行后自动绑定到当前 Telegram chat，后续 turn 用：

```text
agy --conversation <conversation-id>
```

如果你已经知道 Antigravity conversation ID，也可以手动绑定：

```text
/resume conversation fdfc8ab1-7936-4599-98b0-d8ba2593c250
```

如果不知道 ID，直接发 `/resume`。bridge 会扫描最近的 Antigravity CLI 日志并返回编号列表；再发 `/resume 1` 即可绑定。

绑定后：

- Telegram 里的后续消息会继续这个 Antigravity conversation
- `/status` 会显示当前 conversation ID
- `/detach` 会解绑该 conversation；如果存在绑定前的旧对话，就恢复它

这仍然使用 Antigravity 的原生会话模型。bridge 不会伪造 model / effort 启动参数。因为 `agy --print` 不能运行交互式 `/model` 解析器，模型选择请在本机交互式 `agy` 里设置；Telegram `/model` 只会解释限制，不会把命令当普通 prompt 发给模型。

---

## 实例管理

通过 CLI 列出、重命名或删除实例。重命名和删除前必须先停止服务。

```bash
npm run dev -- telegram instance list                          # 显示所有实例
npm run dev -- telegram instance rename old-name new-name      # 重命名
npm run dev -- telegram instance delete staging --yes          # 删除（需要 --yes）
```

---

## 备份与恢复

一条命令备份或恢复实例的完整状态目录。零依赖的二进制归档格式，跨平台兼容，失败时自动回滚。

```bash
npm run dev -- telegram backup --instance work                 # 创建带时间戳的 .cctb.gz
npm run dev -- telegram backup --instance work --out ./bak.cctb.gz
npm run dev -- telegram restore ./bak.cctb.gz --instance work  # 恢复（实例不能已存在）
npm run dev -- telegram restore ./bak.cctb.gz --instance work --force  # 覆盖已有实例
```

---

## Agent Bus

通过本地 HTTP IPC 实现 bot 间通信。现在 bus 不只支持 `/ask`，还支持并行查询、顺序链式、自动复核，以及 coordinator 主导的 crew workflow。它负责路由、对等验证、防循环和本地鉴权。

**协议 v1** — 所有请求和响应都带 `protocolVersion`、`capabilities`、结构化 `errorCode` 和 `retryable` 标志，调用方能清楚区分临时失败（超时、peer 不可达）和终态失败（bus 未开启、peer 不在白名单）。老的无版本报文仍兼容，方便滚动升级。Peer 活性通过 `GET /api/health` 探活 + `cc-telegram-bridge` 指纹校验，端口被其他进程占用时不会被误判成活着。完整规范见 [`docs/bus-protocol.md`](./docs/bus-protocol.md)。

### 开启

在每个实例的 `config.json` 里加 `bus`：

```json
{ "engine": "codex", "bus": { "peers": "*" } }
```

| 字段 | 说明 |
|---|---|
| `peers` | `"*"` = 和所有开了 bus 的 bot 通信。`["a", "b"]` = 只和指定 bot 通信。不写或 `false` = 隔离。 |
| `maxDepth` | 最大委托跳数（默认 `3`）。防止 A→B→C→A 循环。 |
| `port` | 本地 HTTP 端口。`0` = 自动分配（默认）。 |
| `secret` | Bearer token 认证密钥（可选）。 |
| `parallel` | `/fan` 并行查询的实例列表（如 `["sec-bot", "perf-bot"]`）。 |
| `chain` | `/chain` 顺序串联的实例列表（如 `["reviewer", "writer"]`）。 |
| `verifier` | `/verify` 自动验证的实例名（如 `"reviewer"`）。 |
| `crew` | 固定 coordinator workflow 的配置块，用于 hub-and-spoke specialist 协作。 |

双方都必须允许对方 — 单方面配置会被拒绝。

### 使用

在任意 bot 的 Telegram 聊天中：

```
/ask reviewer 帮我审查这个函数的安全问题
/fan 分析这段代码的 bug、安全问题和性能
/chain 按步骤改进这个回答
/verify 写一个数组排序函数
```

- `/ask <实例> <提示>` — 委托给指定 bot，结果内联显示
- `/fan <提示>` — 同时查询当前 bot + 所有 `parallel` bot，汇总结果
- `/chain <提示>` — 按配置顺序串联多个 bot，每一跳都显式拿到上一跳输出
- `/verify <提示>` — 在当前 bot 执行，然后自动发给 `verifier` 检查

`/chain` 是轻量 pipeline；`crew` 是更重的中心协调模式。

每个进程最多同时处理 8 个 Agent Bus `/api/talk` 委托；达到上限时返回可重试的 `server_busy`，避免 `/fan` 或外部调用无限 fork 引擎进程。服务关停会等待在途 HTTP 请求，5 秒后强制关闭剩余连接。

### Board：持久化 Kanban 任务板

`/board` 是一个借鉴 Hermes Kanban 的轻量任务板。它优先解决"状态不能只放在对话里"的问题：任务、依赖、负责人、阻塞原因和完成总结都会写入 `board.json`，不会只靠模型记忆。这样它可以先服务 Mini Bus / Agent Bus 协作，后续再接自动执行。

```
/board add 写 launch plan
/board plan 发布 onboarding flow
/board desc B1 写 launch messaging 和 rollout 任务
/board accept B1 README 已更新
/board priority B1 high
/board labels B1 docs launch
/board check B1 add 更新 README
/board list
/board show B1
/board assign B1 writer
/board dep B2 B1
/board limits global 3
/board worktree B1 /tmp/tarocub-board/B1 board/B1
/board heartbeat B1 还在处理
/board recover 15
/board review B1 on reviewer
/board ready B2
/board run B2
/board start B2
/board fail B2 测试失败
/board runs B2
/board block B2 等 API 文档
/board unblock B2
/board approve B1
/board reject B1 测试还不够
/board done B1 设计已确认
```

- `/board add <任务>` — 创建持久任务，得到类似 `B1` 的稳定 ID
- `/board plan <目标>` — 让当前引擎返回 JSON 任务图，并把任务和依赖一次性落到 Board
- `/board desc <ID> <描述>` — 设置任务卡描述
- `/board accept <ID> <完成标准>` — 追加完成标准
- `/board priority <ID> <low|normal|high|urgent>` — 设置优先级
- `/board labels <ID> <标签...>` — 替换任务标签
- `/board check <ID> add <事项>` / `/board check <ID> done <C1>` — 管理 checklist
- `/board list [todo|ready|running|blocked|done]` — 列出任务
- `/board show <ID>` — 查看单个任务，包括来源 chat/topic
- `/board assign <ID> <对象>` — 给任务标记 Mini Bus peer、bot 实例或任意负责人
- `/board dep <ID> <依赖ID>` — 声明某任务依赖另一个任务完成
- `/board limits [global|assignee|conversation] <n>` — 设置 WIP 限制；默认是 `global=3`、`assignee=1`、`conversation=1`
- `/board worktree <ID> [path] [branch]` / `/board workspace <ID> <default|dir|worktree|scratch> [path]` — 给任务挂可选工作区 metadata；Mini Bus 执行时会优先使用任务自己的 workspace path
- `/board heartbeat <ID> [说明]` — 更新 active run 的存活时间戳
- `/board recover [分钟]` — 把超过阈值没有 heartbeat/新活动的 running 任务标记失败并阻塞；默认 15 分钟
- `/board review <ID> <on|off> [reviewer]` — 要求 done 前先进入 review
- `/board approve <ID>` / `/board reject <ID> <原因>` — 处理 review 中的任务
- `/board ready <ID>` — 依赖完成后把任务推进到 ready
- `/board run <ID>` — 执行一个 ready 任务；优先路由到当前群里的 Mini Bus peer，否则把负责人当作 Agent Bus 实例名委托
- `/board start <ID>` — 标记 running，并创建轻量 run 记录
- `/board fail <ID> <原因>` — 把当前 active run 记为失败，并用原因阻塞任务
- `/board runs <ID>` — 查看一个任务的 run 尝试历史
- `/board block <ID> <原因>` / `/board unblock <ID>` — 管理阻塞状态
- `/board done <ID> [总结]` — 完成任务；依赖它的任务如果条件满足会自动推进到 `ready`

当前版本不是隐藏的自动调度器。它先把任务状态模型打稳：模型辅助拆任务、任务卡 metadata、WIP 限制、workspace metadata、run heartbeat、卡住任务恢复、依赖推进、review gate，以及 `/board run <ID>` 这种一次只跑一张卡的显式执行。Lark 里 `/board show <ID>` 会渲染交互任务卡，按钮动作仍走同一套 `/board` 命令路径和权限检查。

### Mini Bus：topic/thread 到 topic/thread 的工作流

在已允许的 Telegram 群聊/forum 或 Lark 群 thread 里，`/mini` 可以让同一个 bot/app 把不同 topic/thread 当成轻量 peer。每个 peer 保留自己的 session，复用同一个实例配置和 `agent.md`，可以单点询问、并行查询，也可以按顺序串联。适合临时 planning/review 线程，不需要再新建 bot 实例。

适合用 Mini Bus 的场景：

- 一个 `intake` topic 做 coordinator，把 `planner`、`writer`、`reviewer`、`research` 等 topic 注册成 peer
- 用 `/mini fan` 让多个 topic 并行回答同一个问题，快速对比方案
- 用 `/mini chain` 让多个 topic 按顺序接力，后一跳拿到前一跳输出
- 用 `/mini verify` 做轻量复核
- 用 `/mini crew research-report` 跑固定 specialist workflow

前置条件：

- bot 已经加入并允许当前 Telegram 群或 forum
- 如果 BotFather 开了群隐私模式，建议把 bot 设成群管理员，这样它才能看到普通群消息；否则用命令、@bot 或回复 bot 触发
- 每个 Telegram topic 或 Lark thread 都要在对应 topic/thread 里执行 `/mini here <名称>` 注册

典型配置：

```
/mini here planner
/mini here writer
/mini status
/mini ask planner 把这个任务拆成步骤
/mini fan 对比这些方案
/mini chain 把这个粗略想法整理成最终回答
/mini verifier reviewer
/mini verify 写最终答案
/mini role researcher research
/mini role analyst analyst
/mini role writer writer
/mini role reviewer reviewer
/mini crew research-report 分析这个市场
```

配置好以后，在 coordinator topic 里调用：

```
/mini ask planner 把这个拆成 tickets
/mini fan 找出这个方案的风险
/mini chain 把这个方案整理成最终文案
/mini verify reviewer 这个可以 ship 吗？
```

- `/mini here <名称>` — 把当前 topic 注册成当前群里的具名 peer
- `/mini order <名称...>` — 设置默认 `/mini chain` 顺序
- `/mini parallel <名称...>` — 设置默认 `/mini fan` 目标列表
- `/mini verifier <名称|off>` — 设置 `/mini verify` 使用的 verifier
- `/mini role <researcher|analyst|writer|reviewer> <名称>` — 把 crew 角色绑定到某个 topic peer
- `/mini crew research-report <提示>` — 用 topic peer 作为 specialist 跑完整 `research-report` workflow
- `/mini ask <名称> <提示>` — 向某个具名 topic peer 发一次任务
- `/mini fan <提示>` — 并行调用当前群里所有已注册 peer topic（不包含当前 topic）
- `/mini chain <提示>` — 按注册顺序串联 peer topic，每一跳拿到上一跳输出
- `/mini verify [名称] <提示>` — 先在当前 topic 执行，再让已配置或指定的 verifier topic 复核
- `/mini rm <名称>` — 移除某个 topic peer

它的实际好处是：用很低成本换到上下文隔离。每个 topic/thread 有自己的 session 和 cron 范围，但仍然共用同一个 bot/app、workspace、engine 设置、预算统计、审批、timeline 和 audit。适合临时多 agent 工作，比如规划、写作、复核、研究，或者把 cron/job 放到旁路 topic/thread 里。

Mini Bus 只作用于当前 Telegram 群或 Lark 群，不会打开新的 bot token/app，也不会创建新的 workspace；如果多个 topic/thread 同时改同一批文件，仍然要按本地并发 agent 的方式处理工作区冲突。

Mini crew 是 Agent Bus crew 的 topic 版本：coordinator 在当前 topic 里启动，先拆分任务，再把 research 子问题并行发给 `researcher` topic，随后把 analysis、writing、review 和修订循环交给配置好的角色 topic。它复用同一套 `crew-runs/*.json`、timeline、audit、budget、approval 和 topic session 隔离机制。

### 拓扑模式

**主副模式（Hub & Spoke）** — 一个指挥，多个执行：

```
              ┌──────────┐
              │  main    │
              │ peers: * │
              └──┬────┬──┘
                 │    │
         ┌───────┘    └───────┐
         ▼                    ▼
   ┌──────────┐        ┌──────────┐
   │ reviewer │        │ researcher│
   │peers:    │        │peers:     │
   │ ["main"] │        │ ["main"]  │
   └──────────┘        └──────────┘
```

工作 bot 只和主 bot 通信。主 bot 分发任务并汇总结果。

**串联模式（Pipeline）** — 按顺序传递：

```
┌────────┐     ┌────────┐     ┌────────┐
│ intake │────▶│ coder  │────▶│ review │
│peers:  │     │peers:  │     │peers:  │
│["coder"]│    │["intake",│   │["coder"]│
└────────┘    │"review"]│    └────────┘
              └────────┘
```

每个 bot 只知道相邻的 bot。任务从左到右流动。

**并行模式（Parallel）** — 扇出到多个专家：

```
                    /fan "分析这段代码"
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
      ┌──────────┐  ┌──────────┐  ┌──────────┐
      │ sec-bot  │  │ perf-bot │  │ style-bot│
      └──────────┘  └──────────┘  └──────────┘
            │              │              │
            └──────────────┼──────────────┘
                           ▼
                       汇总结果
```

```json
{ "bus": { "peers": "*", "parallel": ["sec-bot", "perf-bot", "style-bot"] } }
```

**验证模式（Verification）** — 执行后自动审查：

```
/verify "写一个排序函数"
         │
         ▼
   ┌──────────┐    结果     ┌──────────┐
   │  coder   │ ───────────▶ │ reviewer │
   └──────────┘              └──────────┘
                                  │
                               验证意见
                                  │
                                  ▼
                        两者一起显示给用户
```

```json
{ "bus": { "peers": "*", "verifier": "reviewer" } }
```

<a id="crew-workflow"></a>

### Crew Workflow（中心协调）

更重的多 agent 协作，推荐用一个专门的 coordinator bot，再配固定 specialist bot。它遵循 hub-and-spoke 模式：

- 用户直接和 coordinator bot 对话
- specialist 之间不直接通信
- 所有上下文都由 coordinator 显式传递
- coordinator 负责阶段推进、结果拼装、run state 和最终回复

当前内置 workflow 是 `research-report`：

`coordinator -> researcher -> analyst -> writer -> reviewer`

如果 reviewer 提出修改意见，coordinator 会把草稿回写给 writer，再跑一轮或多轮修订。

coordinator 实例上的配置示例：

```json
{
  "bus": {
    "peers": ["researcher", "analyst", "writer", "reviewer"],
    "crew": {
      "enabled": true,
      "workflow": "research-report",
      "coordinator": "coordinator",
      "roles": {
        "researcher": "researcher",
        "analyst": "analyst",
        "writer": "writer",
        "reviewer": "reviewer"
      },
      "maxResearchQuestions": 4,
      "maxRevisionRounds": 2
    }
  }
}
```

当前规则：

- 只有 coordinator 实例应该配置 `crew`
- 5 个角色必须全部不同
- 发给 coordinator bot 的普通文本消息会自动走 crew workflow
- 每次 run 会落到 `crew-runs/*.json`
- 每个阶段的进度也会写进 `timeline.log.jsonl`

**全互联（Mesh）** — 所有 bot 自由通信：

```json
// 每个实例
{ "bus": { "peers": "*" } }
```

所有 bot 可以和所有 bot 通信。最简配置，适合 3-5 个 bot 的小团队。

---

## 快速开始

> **简单来说** — 你只需要在手机上做两件事：从 BotFather 拿 token 和发送配对码。其余全部在电脑上通过 Codex、Claude Code、Kimi Code 或 Antigravity CLI 完成。

### 环境要求

- **Node.js** >= 20
- **OpenAI Codex CLI**、**Claude Code CLI** 和/或 **Antigravity CLI** 已安装并认证
- 一个 **Telegram 账号**（手机）

### 第一步：创建 Telegram Bot（手机操作）

1. 打开 Telegram，搜索 **[@BotFather](https://t.me/BotFather)**
2. 发送 `/newbot`
3. 按提示设置 bot 名称和用户名
4. BotFather 会回复一个 **bot token**，类似 `123456789:ABCdefGHIjklMNOpqrsTUVwxyz0123456789`
5. 复制这个 token

### 第二步：安装和配置（电脑操作）

打开终端的 Codex、Claude Code、Kimi Code 或 Antigravity，告诉它：

> *"克隆 https://github.com/cloveric/tarocub 并用这个 token 配置 Telegram bot：`<粘贴你的 token>`"*

或者手动操作：

```bash
git clone https://github.com/cloveric/tarocub.git
cd tarocub
npm install
npm run build

# 用你的 bot token 配置
npm run dev -- telegram configure <your-bot-token>

# 可选：切换引擎（默认是 Codex）
npm run dev -- telegram engine claude
npm run dev -- telegram engine antigravity

# 推荐：开启 YOLO 模式（Telegram 无需回电脑确认）
npm run dev -- telegram yolo on

# 启动服务
npm run dev -- telegram service start
```

### 第三步：配对手机（手机操作）

1. 在 Telegram 中找到你的新 bot（搜索用户名）
2. 发送任意消息 — bot 会回复一个 **6 位配对码**，如 `38J63T`
3. 回到终端执行：

```bash
npm run dev -- telegram access pair 38J63T
```

**搞定！** 现在可以在 Telegram 上和 Codex、Claude、Kimi 或 Antigravity 对话了。支持文字、语音消息和文件。

### 多 Bot

```bash
# 在 BotFather 再创建一个 bot，然后：
npm run dev -- telegram configure --instance work <第二个token>
npm run dev -- telegram engine claude --instance work
npm run dev -- telegram yolo on --instance work
npm run dev -- telegram service start --instance work
# 配对方式相同：发消息，拿码，执行 telegram access pair <码> --instance work

# 或者创建一个专用 Antigravity bot
npm run dev -- telegram configure --instance agy-bot <第三个token>
npm run dev -- telegram engine antigravity --instance agy-bot
npm run dev -- telegram yolo on --instance agy-bot
npm run dev -- telegram service start --instance agy-bot
```

---

## 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                             TaroCub                                │
├─────────────┬──────────────┬──────────────────┬─────────────────────┤
│  Telegram   │   运行时     │     AI 引擎      │      状态           │
│  层         │   层         │     层           │      层             │
├─────────────┼──────────────┼──────────────────┼─────────────────────┤
│ api.ts      │ bridge.ts    │ adapter.ts       │ access-store.ts     │
│ delivery.ts │ chat-queue.ts│ process-adapter  │ session-store.ts    │
│ update-     │ session-     │   .ts (Codex)    │ runtime-state.ts    │
│ normalizer  │ manager.ts   │ claude-adapter   │ instance-lock.ts    │
│   .ts       │              │   .ts (Claude)   │ json-store.ts       │
│ message-    │              │ antigravity-     │ audit-log.ts        │
│ renderer.ts │              │   adapter.ts     │ timeline-log.ts     │
│             │              │ agent.md + config│ usage-store.ts      │
│             │              │                  │ crew-run-store.ts   │
└─────────────┴──────────────┴──────────────────┴─────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  Bus 层  （本地 HTTP、仅 loopback、协议 v1）                        │
├─────────────────────────────────────────────────────────────────────┤
│  bus-server.ts  · bus-client.ts  · bus-handler.ts                   │
│  bus-protocol.ts（信封、错误码、zod）  · bus-registry.ts            │
│  bus-config.ts  · delegation-commands.ts  · crew-workflow.ts        │
└─────────────────────────────────────────────────────────────────────┘
```

**数据流：**

```
Telegram 消息 → 标准化 → 访问检查 → 聊天队列（串行）
    → 加载 config.json（引擎） → 加载 agent.md → 会话查找
    → Codex Exec、Claude -p 或 agy --print（新建或恢复）
    → typing action + timeline 事件 → 最终渲染 → 发送 → 审计
```

---

## 亮点

<table>
  <tr>
    <td width="50%">
      <h3>多引擎</h3>
      <p>每个实例可切换 Codex、Claude Code、Kimi Code 或 Antigravity。不同 bot 可混合使用四种引擎，并由同一套 CLI 管理。</p>
    </td>
    <td width="50%">
      <h3>独立人格</h3>
      <p>每个实例加载自己的 <code>agent.md</code>。Claude 实例还支持 <code>CLAUDE.md</code> 项目规则。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>多 Bot 支持</h3>
      <p>一个仓库可以跑多个 Telegram bot。每个实例都有自己的 token、引擎、工作区、访问规则、会话绑定、审计日志和服务生命周期。</p>
    </td>
    <td>
      <h3>Agent Bus</h3>
      <p>本地 bot-to-bot 调用支持委托、并行 fan-out、链式执行、验证和 coordinator 主导的 crew workflow，同时不会把各 bot 的 Telegram 聊天上下文混在一起。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>会话续接</h3>
      <p><code>/resume</code> 可以接上电脑里的 Claude Code 本地 session；<code>/resume thread &lt;thread-id&gt;</code> 可以绑定已有 Codex thread；<code>/resume conversation &lt;id&gt;</code> 可以绑定 Antigravity conversation。手机上继续之前的工作，不丢上下文。</p>
    </td>
    <td>
      <h3>运行可见性</h3>
      <p>turn 运行时 Telegram 会显示 typing，timeline/audit 会记录 session、工具调用、文件 receipt、重试和完成状态，方便排查。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>YOLO 模式</h3>
      <p>一条命令让 AI 自动审批一切 — 多引擎通用，按实例配置，热加载生效。</p>
    </td>
    <td>
      <h3>安全脱离</h3>
      <p><code>/detach</code> 会在可能时回到 /resume 前的旧对话。bridge 指令不会写回你的本地 Claude、Codex、Kimi 或 Antigravity session 文件。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>按 Bot 隔离</h3>
      <p>每个实例有独立的人格、工作区、会话、访问规则、收件箱、审计日志，以及按工作区路径隔离的自动记忆。各引擎自己的配置目录（<code>~/.claude/</code> / <code>~/.codex/</code> / Antigravity CLI 配置）与你主 CLI <em>共享</em>，避免 OAuth refresh token 被多实例抢用——代价是该引擎自己的 settings、plugins、MCP 状态会落在真实 home 里，full-auto / bypass 模式下 bot 也能动到这些。</p>
    </td>
    <td>
      <h3>生产级可靠性</h3>
      <p>长轮询（~0ms 延迟）、指数退避、429 自动重试、409 冲突自动退出、SIGTERM/SIGINT 优雅关闭、容错批处理。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>用量追踪</h3>
      <p>按实例统计 token 消耗和 USD 费用。<code>telegram usage</code> 随时查看花费。</p>
    </td>
    <td>
      <h3>Timeline 与 Dashboard</h3>
      <p><code>telegram timeline</code>、<code>telegram service status</code>、<code>telegram dashboard</code> 可以查看当前 turn 状态、最近失败、文件 receipt 和 crew 快照。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>预算控制</h3>
      <p>按实例设置费用上限。达到上限时自动拦截请求 — 中英双语提示。</p>
    </td>
    <td>
      <h3>文件投递</h3>
      <p>生成的图片、PDF、PPT 和报告通过注册过的 <code>[tool:...]</code> send tag 投递，<code>cctb send</code> 和 <code>telegram send</code> 作为 CLI 入口。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>备份与恢复</h3>
      <p>一条命令备份或恢复实例。零依赖二进制格式，跨平台兼容，原子回滚。</p>
    </td>
    <td>
      <h3>实例管理</h3>
      <p>通过 CLI 列出、重命名、删除实例。运行中的实例有保护机制防止误操作。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>语音输入</h3>
      <p>直接发语音消息 — 本地通过可插拔 ASR（如 Qwen3-ASR）转写。常驻 HTTP 服务做快速推理，离线时回退到 CLI。</p>
    </td>
    <td>
      <h3>完整审计日志</h3>
      <p>每个实例独立的 JSONL 追加日志 — 支持按类型、聊天、结果过滤。10MB 自动轮转。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Docker 就绪</h3>
      <p>内含多阶段 Dockerfile，一次构建，随处部署。</p>
    </td>
    <td>
      <h3>结构化 Bus 协议</h3>
      <p>本地 bot 之间用带版本的 <code>v1</code> 协议通信 — <code>protocolVersion</code>、<code>capabilities</code>、结构化 <code>errorCode</code> 和 <code>retryable</code> 标志，调用方能区分临时失败和终态失败。Peer 活性是真的 <code>/api/health</code> 探活，不是只看 PID。详见 <a href="./docs/bus-protocol.md">docs/bus-protocol.md</a>。</p>
    </td>
  </tr>
</table>

---

## 聊天内命令一览

完整命令面,按组分类。未标 **Lark** 的命令两个通道都可用。(带示例的同款清单:[Slash Command Index](./docs/slash-commands.md)。)

**会话与任务**

| 命令 | 作用 |
|---|---|
| `/status` | 当前引擎、会话绑定、运行状态 |
| `/stop` | 停止当前任务(排队任务在各自排队卡片上取消) |
| `/reset` | 重置会话绑定 |
| `/resume [编号]` · `/resume thread <id>` · `/resume session <id>` · `/resume conversation <id>` | 续接本地 Claude 会话 / 显式绑定 Codex thread / Kimi ACP session / Antigravity conversation |
| `/detach` | 解绑当前会话/thread/conversation |
| `/goal <目标>` · `/goal --budget <n> …` · `/goal status` · `/goal clear` | 会话目标(Codex 上自主推进) |
| `/btw <问题>` | 旁问,不动当前会话 |
| `/q <消息>`(别名 `/queue`) | **Lark** — 强制排队(跳过中途注入) |
| `/steer [on\|off\|<秒数>\|unlimited\|default\|status]` | **Lark** — 任务中途引导的资格窗口(默认 30 秒,超窗自动排队;支持 `5m` 分钟写法,`0`=不限时) |
| `/continue` | 继续等待中的压缩包分析 |
| `/bg` · `/bg kill <pid>` · `/bg killall` | **Lark** — 查看/停止引擎与后台进程 |

**设置**

| 命令 | 作用 |
|---|---|
| `/config` | **Lark** — 交互配置卡片(推荐) |
| `/engine [claude\|codex\|kimi\|antigravity]` | 查看/切换后端引擎 |
| `/model [名称\|off]` | 查看/设置模型。Claude 支持别名；Kimi 接受 ACP 广告的 provider 模型 ID，并在下一 turn 验证 |
| `/effort [low\|medium\|high\|xhigh\|max\|ultra\|off]` | 推理强度(视模型而定) |
| `/fast [on\|off\|status]` | Codex 快速模式 |
| `/yolo [on\|off\|unsafe\|status]` | **Lark** — 审批模式(Telegram 侧没有这个聊天命令，用 CLI `telegram yolo …`) |
| `/stream [on\|off]` | **Lark** — 回答卡片打字机流式 |
| `/timeout [on\|off]` | 单轮 60 分钟上限(`off` = 长任务放开) |
| `/usage` | 本实例累计用量 |
| `/account` | **Lark** — 当前绑定的飞书应用 |

**群与授权**

| 命令 | 作用 |
|---|---|
| `/group [status\|allow\|deny\|on\|off\|all\|at]` | 群授权与回复模式(`on`/`off`=整个实例的群模式开关，`all`=不@也回,`at`=只@才回) |
| `/invite group\|user @某人` · `/remove …` | **Lark** — 授予/撤销群或用户授权 |
| `/newgroup <名>` · `/newgroup topic <名>` · `/newtopic <名>` | **Lark** — 新建并自动授权项目群 / 话题群；默认仍需 @bot |

**定时与持久任务**

| 命令 | 作用 |
|---|---|
| `/cron …`(`list`/`add`/`rm`/`toggle`/`mode`/`run`) | 定时提醒、周期任务、计划 agent 任务 |
| `/board …`(别名 `/kanban`)(`add`/`plan`/`list`/`show`/`run`/`heartbeat`/`recover`/`worktree`) | 模型记忆之外的持久 Kanban 任务板 |

**多 Agent 协作**

| 命令 | 作用 |
|---|---|
| `/ask <实例> <提示>` | 委托一条提示给别的 bot |
| `/fan` · `/chain` · `/verify` | Agent Bus 并行 / 串联 / 验证 |
| `/mini …`(`here`/`ask`/`fan`/`chain`/`verify`/`crew`) | topic/thread 级 peer agent |

**上下文工具与审批**

| 命令 | 作用 |
|---|---|
| `/context` | Claude 上下文占用 |
| `/compact` | 压缩 Claude 或 Kimi session 上下文 |
| `/ultrareview` | 深度代码审查（仅 Claude） |
| `/approve [session\|turn\|always]` · `/approve <请求ID>` | 审批按钮不可用时的文字兜底 |
| `/deny` · `/deny <请求ID>` | 拒绝待审批的工具调用（没有 `/deny session` 这种写法） |
| `/approve-session <请求ID>` | **Lark** — 对指定请求在本会话内持续放行 |
| `/help`(**Lark** 上别名 `/start`) | 当前聊天里的帮助 |
| `/ws list\|save\|use\|remove` | **Lark** — 工作区目录管理 |
| 强制本地转写 · 强制云端转写 | 消息关键词（非命令）：必须**和音频/视频同一条消息或同一批**发送（例如当作附件说明），才能强制走本地或云端转写；事后再发是新的一轮，改不了已经开跑的转写 |

## 服务运维

| 命令 | 说明 |
|---|---|
| `telegram service start` | 获取锁、加载状态、启动长轮询 |
| `telegram service stop` | 优雅关闭（SIGTERM/SIGINT） |
| `telegram service status` | 运行状态、PID、引擎、bot 身份、timeline 摘要、最近 crew run |
| `telegram service restart` | 停止 + 启动，干净重置 |
| `telegram service restart --all` | 重启所有已配置实例；`start`、`stop`、`status`、`doctor` 也支持 `--all` |
| `telegram service logs` | 查看 stdout/stderr 日志 |
| `telegram service doctor` | 全子系统健康检查，包括 timeline、crew、共享引擎环境和残留 launchd 项 |
| `telegram engine [codex\|claude\|kimi\|antigravity]` | 按实例切换 AI 引擎 |

如果在一个活跃 bot turn 里运行 `telegram service stop --all` 或 `telegram service restart --all`，当前实例会被自动跳过，避免命令杀掉自己的执行链。需要重启当前实例时，从终端单独执行对应 `--instance` 命令。
| `telegram yolo [on\|off\|unsafe]` | 切换自动审批模式 |
| `telegram usage` | 查看 token 用量和费用估算 |
| `telegram verbosity [0\|1\|2]` | 保留的兼容配置；当前 process runtime 使用 typing action + timeline/audit 事件 |
| `telegram budget [show\|set\|clear]` | 按实例费用上限（达到上限时拦截请求） |
| `telegram timeline` | 查看结构化生命周期事件，支持过滤 |
| `telegram instance [list\|rename\|delete]` | 通过 CLI 管理实例 |
| `telegram backup [--instance <name>]` | 将实例状态归档为 `.cctb.gz` |
| `telegram restore <archive>` | 从备份恢复实例（`--force` 覆盖已有） |
| `telegram logs rotate` | 手动触发日志轮转 |
| `telegram dashboard` | 生成并打开带 timeline 和最近 crew 快照的 HTML 仪表板 |
| `telegram help` | 显示所有可用命令 |

所有命令支持 `--instance <name>` 指定目标 bot。

## 稳定 Beta 命令

- `telegram service doctor --instance <name>`
- `telegram session list --instance <name>`
- `telegram session inspect --instance <name> <chat-id>`
- `telegram session reset --instance <name> <chat-id>`
- `telegram task list --instance <name>`
- `telegram task inspect --instance <name> <upload-id>`
- `telegram task clear --instance <name> <upload-id>`

Telegram 用户也可以使用：

- `/status`
- `/engine [claude|codex|kimi|antigravity]` — 切换当前实例引擎（桥会自动清掉陈旧绑定）
- `/effort [low|medium|high|xhigh|max|ultra|off]` — 设置推理强度；实际可用级别由当前引擎/模型决定，Kimi 通过 ACP thinking 选项应用
- `/model [名称|off]` — 为 Codex/Claude/Kimi 切换模型；Kimi 接受 ACP 广告的 provider 模型 ID，Antigravity 会解释 `agy --print` 限制
- `/fast [on|off|status]` — 切换 Codex Fast Mode。bridge 实例里把它当实验选项使用；如果出现 Codex runtime 失败，先 `/fast off`，不要反复重试；下一条简单消息仍失败时，再重启该实例一次。
- `/goal <完成条件>` — 设置引擎 goal。默认无 token 预算，除非显式提供 `--budget`；Codex 会强制执行显式预算，Claude Code 和 Antigravity 会把显式预算作为原生 goal 指导。Kimi ACP 0.31.1 不支持该命令，bridge 会明确拒绝而不是伪装成普通 prompt。
- `/btw <问题>` — 旁问（不影响当前会话）
- `/ask <实例> <提示>` — 委托给指定 peer bot
- `/fan <提示>` — 查询当前 bot 和并行 specialist bot
- `/chain <提示>` — 跑配置好的顺序 bot 链
- `/verify <提示>` — 本地执行后交给 verifier bot 自动复核
- `/resume` — Claude/Kimi：扫描并按编号恢复 session（Kimi 也支持 `/resume session <session-id>`）；Codex：使用 `/resume thread <thread-id>`；Antigravity：使用 `/resume conversation <conversation-id>`
- `/detach` — 断开恢复的 Claude/Kimi session、当前 Codex thread 或当前 Antigravity conversation；如果存在旧对话，则恢复到 /resume 之前
- `/stop` — 立即停止当前运行中的任务
- `/continue` — 恢复最近一个等待中的压缩包摘要
- `/compact`（Claude/Kimi — 压缩上下文；Codex 回退为 reset）
- `/context`（仅 Claude）— 显示当前上下文填充度，用来决定何时 `/compact`
- `/ultrareview`（仅 Claude Opus 4.7+）— 专门的代码审查通道，通常配合 `/resume` 进入本地项目
- `/reset`
- `/help`

针对压缩包摘要，推荐直接回复该摘要或点击其中的 Continue Analysis 按钮继续；裸 `/continue` 只会恢复最近一个等待中的压缩包。

状态文件损坏时的恢复行为：

- 当 `session.json`、`file-workflow.json`、`timeline.log.jsonl` 或 `crew-runs/` 不可读时，`telegram service status` 和 `telegram service doctor` 会降级为 `unknown (...)` 警告，而不是直接崩溃。
- `telegram session inspect` 和 `telegram task inspect` 会提示状态不可读并直接停止，不会假装记录不存在。
- `telegram session reset`、`telegram task clear` 以及 Telegram `/reset` 只会在文件损坏或结构非法时自愈；写入默认空状态前，会先把原始不可读文件隔离备份到同目录。
- Telegram `/status` 在底层 JSON 不可读时，会把 session/task 状态显示为 `unknown (...)`。

### Shell 辅助脚本

**Windows (PowerShell):**

```powershell
.\scripts\start-instance.ps1 [-Instance work]
.\scripts\status-instance.ps1 [-Instance work]
.\scripts\stop-instance.ps1 [-Instance work]
```

**macOS / Linux (bash):**

```bash
./scripts/start-instance.sh [work]
./scripts/status-instance.sh [work]
./scripts/stop-instance.sh [work]
```

旧版 autostart 遗留清理：

```bash
bash scripts/cleanup-legacy-launchd.sh --all
```

Claude 认证 smoke test：

```bash
npm run smoke:claude-auth
```

共享引擎环境规则：

- `CLAUDE_CONFIG_DIR` 和 `CODEX_HOME` 只有在你显式 export 时才会传给 bot。
- 如果你改了其中任意一个变量，要从同一个 shell 重启对应实例。
- `telegram service doctor` 现在会检查共享环境是否漂移，以及是否还残留旧的 launchd plist。

---

## 访问控制

按实例分两层：**配对**（初始握手）+ **白名单**（持续授权）。

默认行为现在更保守：

- 一个实例默认只服务 **一个 Telegram chat**
- 第二个 chat 不会自动配对，也不会被加入 allowlist，除非你显式打开 multi-chat
- 这样可以减少 `/resume`、workspace override、本地文件和会话状态在不同 chat 之间串掉

```bash
npm run dev -- telegram access pair <code>
npm run dev -- telegram access policy allowlist
npm run dev -- telegram access allow <chat-id>
npm run dev -- telegram access revoke <chat-id>
npm run dev -- telegram access multi on
npm run dev -- telegram access multi off
npm run dev -- telegram status [--instance work]
```

只有在你真的想让一个实例服务多个聊天时，才使用 `telegram access multi on --instance <name>`。新实例和旧实例在没有显式修改前，默认都保持 `off`。

### Telegram 群聊和 Topic

群聊有第二层允许机制：Telegram user 必须已经授权，并且当前群也必须在群里显式允许：

```text
/group status
/group allow
/group deny
/group on
/group off
/group all
/group at
```

在群里，普通消息默认会被忽略，除非消息 @ 了 bot 用户名，或者是在回复 bot 的某条消息。斜杠命令仍然可用。如果你希望当前这个已允许的群像一个常驻共享聊天一样工作，在群里发送 `/group all`；想回到更安全的默认行为，在同一个群里发送 `/group at`。要让 `/group all` 听见普通消息，需要把 bot 设为这个群的管理员，让 Telegram 真正把普通群消息投递给它；BotFather privacy mode 也可能影响投递，但群管理员是实际推荐路径。未授权用户在群里触发 bot 时默认静默，只写 audit，不向群里刷"未授权"提示。

Telegram forum topic 会作为独立对话：每个 topic 有自己的 engine session 和 cron 范围。同一个 topic 内，已授权用户共享这个 topic 的上下文；如果想开临时对话或避免上下文混在一起，用新的 topic。

---

## 审计日志

每个实例独立的 JSONL 追加日志，支持过滤查询：

```bash
npm run dev -- telegram audit [--instance work]
npm run dev -- telegram audit 50                                    # 最近 50 条
npm run dev -- telegram audit --type update.handle --outcome error  # 按类型/结果过滤
npm run dev -- telegram audit --chat 688567588                      # 按聊天过滤
```

`audit.log.jsonl` 记录**桥做了什么动作** — `update.handle`、`bus.reply`、`budget.blocked` —每次对外动作一条，10MB 自动轮转。

### Timeline

和审计日志并列，桥还会写一条**生命周期流**（`timeline.log.jsonl`），描述每个 turn 的形态 — `turn.started`、`turn.completed`、`budget.threshold_reached`、`crew.stage.*`、bus 委派等。同样是 JSONL，维度不同：

```bash
npm run dev -- telegram timeline [--instance work]
npm run dev -- telegram timeline --type turn.completed --outcome error
npm run dev -- telegram timeline --chat 688567588 --limit 100
```

简单说：audit 回答"我们做了什么动作"，timeline 回答"这个 turn 的走向是什么"。`telegram service status` 和 `telegram dashboard` 的摘要就是从 timeline 里取的。

---

## 状态目录

```
# Windows: %USERPROFILE%\.cctb\<instance>\
# macOS/Linux: ~/.cctb/<instance>/

<instance>/
├── agent.md                # Bot 人格与指令
├── config.json             # 引擎、YOLO 模式、详细度、bus
├── usage.json              # Token 用量和费用追踪
├── workspace/              # 按 bot 独立的工作目录
│   └── CLAUDE.md           # Claude Code 项目指令（仅 Claude 引擎）
├── .env                    # Bot token
├── access.json             # 配对 + 白名单数据
├── session.json            # 聊天到线程的绑定
├── file-workflow.json      # 待处理的文件上传 follow-up
├── runtime-state.json      # 水位线、偏移量
├── instance.lock.json      # 进程锁
├── audit.log.jsonl         # 结构化审计流（轮转为 .1、.2...）
├── timeline.log.jsonl      # 生命周期事件（turn.started、budget.*、crew.stage.*）
├── crew-runs/              # Crew 运行状态（仅 coordinator 实例）
│   └── <run-id>.json
├── service.stdout.log      # 服务 stdout
├── service.stderr.log      # 服务 stderr
└── inbox/                  # 下载的附件
```

---

## 开发

```bash
npm run dev -- <command>     # 开发模式
npm test                     # 运行测试
npm run test:watch           # 监听模式
npm run build                # 构建生产版本
npm start                    # 启动生产版本
```

---

## Docker

```bash
# 构建
docker build -t tarocub .

# 运行
docker run -v ~/.cctb:/root/.cctb tarocub telegram configure <token>
docker run -v ~/.cctb:/root/.cctb tarocub telegram service start
```

挂载 `~/.cctb` 以在容器重启后保留状态。

---

## 故障排查

<details>
<summary><strong>Bot 不回复</strong></summary>

1. 运行 `telegram service doctor` 诊断
2. 查看 `telegram service logs` 的错误
3. 确认引擎已安装：`codex --version`、`claude --version` 或 `agy --help`
4. 如果是 Claude 实例，运行 `npm run smoke:claude-auth`
5. 如果 `service doctor` 报 `legacy-launchd`，运行 `bash scripts/cleanup-legacy-launchd.sh --all`

</details>

<details>
<summary><strong>Codex Fast Mode 导致引擎运行时失败</strong></summary>

Fast Mode 是 Codex CLI 自己的功能，但在无人值守 bridge 实例里，可能暴露上游 Codex 诊断问题，例如插件 warm-cache 失败或 Cloudflare challenge。bridge 会在 Codex 已经产出完整回复、且 stderr 只是非阻塞插件诊断时保留回复；真实 Codex 错误仍会让 turn 失败。

1. 在出问题的 bot 里发送 `/fast off`。
2. 先发一条简单消息，例如 `hi`。
3. 如果仍失败，等当前 turn 空闲后重启这个 bot 实例一次。
4. 避免在 bot 正在生成回复时 force 重启它自己；这会杀掉活跃 Codex 子进程，表现为 `codex exited with code null`。

</details>

<details>
<summary><strong>Terminal 里的 Claude 正常，但 bot 里不正常</strong></summary>

1. 先检查 shell：`claude auth status`
2. 运行 `npm run smoke:claude-auth`
3. 再跑 `telegram service doctor --instance <name>`
4. 如果你刚改过 `CLAUDE_CONFIG_DIR`，请从同一个 shell 里重启实例
5. 如果 `doctor` 报 `legacy-launchd`，执行 `bash scripts/cleanup-legacy-launchd.sh --all`

详细说明见：[`docs/runtime-env-troubleshooting.md`](./docs/runtime-env-troubleshooting.md)

</details>

<details>
<summary><strong>Bot 发送重复回复</strong></summary>

409 Conflict 说明两个进程在轮询同一个 bot token。服务会自动检测并退出。运行 `telegram service status` 检查，然后 `telegram service stop` + `telegram service start` 干净重启。

</details>

<details>
<summary><strong>切换到 Claude 引擎</strong></summary>

1. `telegram engine claude --instance <name>`
2. 重启服务：`telegram service restart --instance <name>`
3. 可选：在 workspace 目录添加 `CLAUDE.md`

</details>

<details>
<summary><strong>agent.md 修改不生效</strong></summary>

不需要重启 — 每条消息都会重新加载。用 `telegram instructions path --instance <name>` 确认路径。

</details>

---

## 可选：配一个本地守护 Agent

这个项目现在已经能稳定使用，但仍然处在持续演进阶段。如果你在一台机器上跑多个实例，额外配一个**本地守护 agent**会很实用。它是可选项，不是必需项。

它适合做这些事：
- 检查实例健康状态
- 先看 `service status` / `service doctor` / timeline，再决定要不要动手
- 只重启出问题的那个实例
- 先汇报结论和证据，而不是默默改配置

不要把它当成第二个产品 bot。它的职责应该只限于运维：监控、诊断、重启、汇报。

### 示例 Brief

你可以把下面这段去敏感化的 brief 给本地守护 agent：

```text
你是这台机器上 TaroCub 的本地运维守护代理。

你的工作是保持 bot 实例健康，并让问题容易诊断。

核心职责：
1. 检查实例健康状态
2. 在采取动作前先诊断
3. 只在必要时重启受影响的实例
4. 清楚汇报结论、证据和动作

默认规则：
- 默认假设一个实例只服务一个 chat，除非该实例明确开启了 multi-chat。
- 不要擅自修改 engine、model、yolo/approval mode、pairing、access 或 multi-chat，除非用户明确要求。
- 不要擅自清 task，除非用户明确要求，或任务已确认是残留且用户之前已授权清理。
- 不要擅自修改项目代码或 README，除非用户明确要求。
- 优先做最小恢复动作；除非真的必要，不要一上来重启全部实例。

默认诊断顺序：
1. 看 service status
2. 看 service doctor
3. 看最近 timeline / audit
4. 必要时再看 stdout / stderr
5. 先判断问题属于：
   - 进程没跑
   - engine/runtime 失败
   - Telegram 投递失败
   - 残留 task / workflow
   - 认证或配置问题
6. 然后再决定是否需要重启

优先使用的命令：
- `node dist/src/index.js telegram service status --instance <name>`
- `node dist/src/index.js telegram service doctor --instance <name>`
- `node dist/src/index.js telegram timeline --instance <name>`
- `bash scripts/start-instance.sh <name>`
- `bash scripts/stop-instance.sh <name>`

回复格式：
- 先给结论
- 再给证据
- 最后说明已执行或建议执行的动作
```

如果你已经在本机使用像 Hermes 这样的 agent，它就很适合承担这个角色。

---

## 许可证

[MIT](./LICENSE)

---

<p align="center">
  <sub>你的 agent。你的引擎。你的规则。</sub>
</p>
