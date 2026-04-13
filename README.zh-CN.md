<p align="center">
  <a href="./README.md"><strong>English</strong></a>&nbsp;&nbsp;|&nbsp;&nbsp;<strong>中文文档</strong>
</p>

<p align="center">
  <img src="./assets/github-banner.png" alt="CC Telegram Bridge" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/cloveric/cc-telegram-bridge/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cloveric/cc-telegram-bridge?style=flat-square&color=818cf8" alt="License"></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%7C%20macOS%20%7C%20Linux-0078D4?style=flat-square&logo=node.js&logoColor=white" alt="Windows | macOS | Linux">
  <img src="https://img.shields.io/badge/%E5%BC%95%E6%93%8E-Codex%20%7C%20Claude-F97316?style=flat-square" alt="Codex | Claude">
  <img src="https://img.shields.io/badge/%E6%B5%8B%E8%AF%95-Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white" alt="Vitest">
</p>

<h3 align="center">
  把真正的 Codex 和 Claude Code CLI 搬到 Telegram。<br>
  不是 API 封装 — 是原生 CLI，带会话、记忆和文件处理。<br>
  多 bot 并行，每个拥有独立的引擎、人格和状态 — 默认隔离，需要协作时通过 Agent Bus 互通。
</h3>

<p align="center">
  <em>基于原生 CLI harness 构建 — 会话持久化、跨设备续接、语音输入、文件投递、Agent 协作，开箱即用。<br>对 99% 的人来说，比任何 *Claw 都更省心、更稳定。</em>
</p>

<p align="center">
  <a href="#双引擎codex--claude-code">双引擎</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#多-bot-部署">多 Bot</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#agent-bus">Agent Bus</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#yolo-模式">YOLO</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#会话续接">续接</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#预算控制">预算</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#备份与恢复">备份</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#快速开始">快速开始</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#服务运维">运维</a>
</p>

> **RULE 1：** 让你的 Claude Code 或 Codex CLI 来帮你配置这个项目。克隆仓库，在终端里打开，然后告诉你的 AI agent：*"读一下 README，帮我配置一个 Telegram bot"*。剩下的它会搞定。

---

## 双引擎：Codex + Claude Code

每个 bot 实例可以独立选择 **OpenAI Codex** 或 **Claude Code** 作为后端引擎，一条命令即可切换：

```bash
# 将某个实例设为 Claude Code
npm run dev -- telegram engine claude --instance review-bot

# 将另一个设为 Codex
npm run dev -- telegram engine codex --instance helper-bot

# 查看当前引擎
npm run dev -- telegram engine --instance review-bot
```

| 特性 | Codex 引擎 | Claude 引擎 |
|---|---|---|
| CLI 命令 | `codex exec --json` | `claude -p --output-format json` |
| 会话恢复 | `codex exec resume --json <id>` | `claude -p -r <session-id>` |
| 项目指令 | `agent.md`（注入到 prompt） | `agent.md`（`--system-prompt`）+ `CLAUDE.md`（工作目录自动加载） |
| YOLO 模式 | `--full-auto` / `--dangerously-bypass-*` | `--permission-mode bypassPermissions` / `--dangerously-skip-permissions` |
| `/compact` | 不需要（每次 exec 无状态） | 压缩会话上下文，减少 token 消耗 |
| 工作目录 | 实例目录下的 `workspace/` | 实例目录下的 `workspace/`（放 `CLAUDE.md`） |

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

想开多少个 bot 就开多少个。每个实例完全隔离 — 独立的引擎、token、人格、线程、访问规则、收件箱和审计日志。

```
          ┌─────────────────────────────────────────────┐
          │            cc-telegram-bridge                │
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

# 给手机用开启 YOLO
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

## YOLO 模式

```bash
npm run dev -- telegram yolo on --instance work      # 安全自动审批
npm run dev -- telegram yolo unsafe --instance work   # 跳过所有检查
npm run dev -- telegram yolo off --instance work      # 恢复正常流程
npm run dev -- telegram yolo --instance work          # 查看状态
```

| 模式 | Codex | Claude | 适用场景 |
|---|---|---|---|
| `off` | 正常审批 | 正常审批 | 默认，最安全 |
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

## 详细度控制

控制流式进度显示的精细程度：

```bash
npm run dev -- telegram verbosity 0 --instance work   # 安静 — 无实时更新
npm run dev -- telegram verbosity 1 --instance work   # 正常 — 每 2 秒更新（默认）
npm run dev -- telegram verbosity 2 --instance work   # 详细 — 每 1 秒更新
npm run dev -- telegram verbosity --instance work      # 查看当前级别
```

存储在 `config.json`，热加载生效。

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

在 Telegram 中发送语音消息 — 桥接器会在本地转写后将文本发送给 AI 引擎。无需云端 ASR 服务。

**工作原理：**

1. 用户在 Telegram 中发送语音消息
2. 桥接器下载 `.ogg` 文件
3. 通过本地 ASR 服务转写（优先 HTTP，CLI 备用）
4. 转写文本作为用户消息发送给引擎

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

**自定义 ASR：** 修改 `src/telegram/delivery.ts` 中的 `transcribeVoice()` 函数即可适配其他 ASR 引擎。

---

## 会话续接

在电脑上用 Claude Code 开了个头？发 `/resume` 就能在 Telegram 上接着干 — 不用重复解释上下文。

```
/resume          ← Bot 扫描本地最近 1 小时的 session
```

Bot 列出最近的 session：

```
最近的本地 session：
1. [cc-telegram-bridge] 64c2081c… (5m ago)
2. [my-app] a3f8b21e… (32m ago)

回复 /resume <编号> 继续该 session。
```

选一个：

```
/resume 1        ← Bot 自动建软链、切工作区、绑 session
```

之后发的每条消息都走原始 session — 相同的上下文、相同的项目目录、相同的对话历史。完成后：

```
/detach          ← 清理软链、解绑 session、恢复默认工作区
```

**底层原理：**

1. 扫描 `~/.claude/projects/` 中最近 1 小时内修改过的 `.jsonl` 文件
2. 在 bot 的 `engine-home/projects/` 下创建软链指向本地 session 目录
3. 将工作区切换到你的真实项目路径
4. 绑定 session ID，Claude CLI 通过 `-r <sessionId>` 恢复会话
5. `/detach` 反向操作 — 本地 session 不受任何影响

**零污染：** `--append-system-prompt` 是每次调用时传入的，不会写进 session 文件。bridge 指令不会泄漏到你的本地会话中。

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

通过本地 HTTP IPC 实现 bot 间通信。bot 之间可以用 `/ask` 互相委托任务，bus 负责路由、对等验证和防循环。

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
| `verifier` | `/verify` 自动验证的实例名（如 `"reviewer"`）。 |

双方都必须允许对方 — 单方面配置会被拒绝。

### 使用

在任意 bot 的 Telegram 聊天中：

```
/ask reviewer 帮我审查这个函数的安全问题
/fan 分析这段代码的 bug、安全问题和性能
/verify 写一个数组排序函数
```

- `/ask <实例> <提示>` — 委托给指定 bot，结果内联显示
- `/fan <提示>` — 同时查询当前 bot + 所有 `parallel` bot，汇总结果
- `/verify <提示>` — 在当前 bot 执行，然后自动发给 `verifier` 检查

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

**全互联（Mesh）** — 所有 bot 自由通信：

```json
// 每个实例
{ "bus": { "peers": "*" } }
```

所有 bot 可以和所有 bot 通信。最简配置，适合 3-5 个 bot 的小团队。

---

## 快速开始

> **简单来说** — 你只需要在手机上做两件事：从 BotFather 拿 token 和发送配对码。其余全部在电脑上通过 Claude Code 或 Codex 完成。

### 环境要求

- **Node.js** >= 20
- **OpenAI Codex CLI** 和/或 **Claude Code CLI** 已安装并认证
- 一个 **Telegram 账号**（手机）

### 第一步：创建 Telegram Bot（手机操作）

1. 打开 Telegram，搜索 **[@BotFather](https://t.me/BotFather)**
2. 发送 `/newbot`
3. 按提示设置 bot 名称和用户名
4. BotFather 会回复一个 **bot token**，类似 `123456789:ABCdefGHIjklMNOpqrsTUVwxyz0123456789`
5. 复制这个 token

### 第二步：安装和配置（电脑操作）

打开终端的 Claude Code 或 Codex，告诉它：

> *"克隆 https://github.com/cloveric/cc-telegram-bridge 并用这个 token 配置 Telegram bot：`<粘贴你的 token>`"*

或者手动操作：

```bash
git clone https://github.com/cloveric/cc-telegram-bridge.git
cd cc-telegram-bridge
npm install
npm run build

# 用你的 bot token 配置
npm run dev -- telegram configure <your-bot-token>

# 可选：切换到 Claude 引擎（默认是 Codex）
npm run dev -- telegram engine claude

# 开启 YOLO 模式（免确认）
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

**搞定！** 现在可以在 Telegram 上和 Codex 或 Claude 对话了。支持文字、语音消息和文件。

### 多 Bot

```bash
# 在 BotFather 再创建一个 bot，然后：
npm run dev -- telegram configure --instance work <第二个token>
npm run dev -- telegram engine claude --instance work
npm run dev -- telegram yolo on --instance work
npm run dev -- telegram service start --instance work
# 配对方式相同：发消息，拿码，执行 telegram access pair <码> --instance work
```

---

## 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         cc-telegram-bridge                          │
├─────────────┬──────────────┬──────────────────┬─────────────────────┤
│  Telegram   │   运行时     │     AI 引擎      │      状态           │
│  层         │   层         │     层           │      层             │
├─────────────┼──────────────┼──────────────────┼─────────────────────┤
│ api.ts      │ bridge.ts    │ adapter.ts       │ access-store.ts     │
│ delivery.ts │ chat-queue.ts│ process-adapter  │ session-store.ts    │
│ update-     │ session-     │   .ts (Codex)    │ runtime-state.ts    │
│ normalizer  │ manager.ts   │ claude-adapter   │ instance-lock.ts    │
│   .ts       │              │   .ts (Claude)   │ json-store.ts       │
│ message-    │              │                  │ audit-log.ts        │
│ renderer.ts │              │ agent.md + config│                     │
└─────────────┴──────────────┴──────────────────┴─────────────────────┘
```

**数据流：**

```
Telegram 消息 → 标准化 → 访问检查 → 聊天队列（串行）
    → 加载 config.json（引擎） → 加载 agent.md → 会话查找
    → Codex Exec 或 Claude -p（新建或恢复）
    → 流式进度更新（每 2 秒） → 最终渲染 → 发送 → 审计
```

---

## 亮点

<table>
  <tr>
    <td width="50%">
      <h3>双引擎</h3>
      <p>每个实例可切换 Codex 和 Claude Code。混合搭配 — 一个 bot 跑 Codex，另一个跑 Claude，统一 CLI 管理。</p>
    </td>
    <td width="50%">
      <h3>独立人格</h3>
      <p>每个实例加载自己的 <code>agent.md</code>。Claude 实例还支持 <code>CLAUDE.md</code> 项目规则。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>流式进度</h3>
      <p>AI 生成回复时，Telegram 消息每 2 秒实时更新，不再干等 "Running..."。</p>
    </td>
    <td>
      <h3>YOLO 模式</h3>
      <p>一条命令让 AI 自动审批一切 — 双引擎通用，按实例配置，热加载生效。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>完全隔离</h3>
      <p>每个实例：独立引擎、token、访问控制、会话、线程、收件箱、审计日志、<strong>引擎记忆</strong>。bot 之间零串台。</p>
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
      <h3>详细度控制</h3>
      <p>按实例设置输出级别：0 = 安静，1 = 正常（2 秒），2 = 详细（1 秒）。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>预算控制</h3>
      <p>按实例设置费用上限。达到上限时自动拦截请求 — 中英双语提示。</p>
    </td>
    <td>
      <h3>会话续接</h3>
      <p>电脑上开了个头？<code>/resume</code> 在 Telegram 上接着干。<code>/detach</code> 回归默认 — 原始 session 零污染。</p>
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
      <h3>完整审计日志</h3>
      <p>每个实例独立的 JSONL 追加日志 — 支持按类型、聊天、结果过滤。10MB 自动轮转。</p>
    </td>
    <td>
      <h3>Docker 就绪</h3>
      <p>内含多阶段 Dockerfile，一次构建，随处部署。</p>
    </td>
  </tr>
</table>

---

## 服务运维

| 命令 | 说明 |
|---|---|
| `telegram service start` | 获取锁、加载状态、启动长轮询 |
| `telegram service stop` | 优雅关闭（SIGTERM/SIGINT） |
| `telegram service status` | 运行状态、PID、引擎、bot 身份、审计健康 |
| `telegram service restart` | 停止 + 启动，干净重置 |
| `telegram service logs` | 查看 stdout/stderr 日志 |
| `telegram service doctor` | 全子系统健康检查 |
| `telegram engine [codex\|claude]` | 按实例切换 AI 引擎 |
| `telegram yolo [on\|off\|unsafe]` | 切换自动审批模式 |
| `telegram usage` | 查看 token 用量和费用估算 |
| `telegram verbosity [0\|1\|2]` | 设置流式进度显示级别 |
| `telegram budget [show\|set\|clear]` | 按实例费用上限（达到上限时拦截请求） |
| `telegram instance [list\|rename\|delete]` | 通过 CLI 管理实例 |
| `telegram backup [--instance <name>]` | 将实例状态归档为 `.cctb.gz` |
| `telegram restore <archive>` | 从备份恢复实例（`--force` 覆盖已有） |
| `telegram logs rotate` | 手动触发日志轮转 |
| `telegram dashboard` | 生成并打开 HTML 状态仪表板 |
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
- `/effort [low|medium|high|max|off]` — 设置推理强度
- `/model [名称|off]` — 切换模型
- `/btw <问题>` — 旁问（不影响当前会话）
- `/resume` — 扫描并恢复本地 session 到 Telegram 继续
- `/detach` — 断开恢复的 session，恢复默认工作区
- `/stop` — 立即停止当前运行中的任务
- `/continue`
- `/compact`（仅 Claude — 压缩上下文；Codex 回退为 reset）
- `/reset`
- `/help`

针对压缩包摘要，推荐直接回复该摘要或点击其中的 Continue Analysis 按钮继续；裸 `/continue` 只会恢复最近一个等待中的压缩包。

状态文件损坏时的恢复行为：

- 当 `session.json` 或 `file-workflow.json` 不可读时，`telegram service status` 和 `telegram service doctor` 会降级为 `unknown (...)` 警告，而不是直接崩溃。
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

---

## 访问控制

按实例分两层：**配对**（初始握手）+ **白名单**（持续授权）。

```bash
npm run dev -- telegram access pair <code>
npm run dev -- telegram access policy allowlist
npm run dev -- telegram access allow <chat-id>
npm run dev -- telegram access revoke <chat-id>
npm run dev -- telegram status [--instance work]
```

---

## 会话检视

```bash
npm run dev -- telegram session inspect [--instance work] <chat-id>
npm run dev -- telegram session reset [--instance work] <chat-id>
```

---

## 审计日志

每个实例独立的 JSONL 追加日志，支持过滤查询：

```bash
npm run dev -- telegram audit [--instance work]
npm run dev -- telegram audit 50                                    # 最近 50 条
npm run dev -- telegram audit --type update.handle --outcome error  # 按类型/结果过滤
npm run dev -- telegram audit --chat 688567588                      # 按聊天过滤
```

---

## 状态目录

```
# Windows: %USERPROFILE%\.cctb\<instance>\
# macOS/Linux: ~/.cctb/<instance>/

<instance>/
├── agent.md                # Bot 人格与指令
├── config.json             # 引擎、YOLO 模式、详细度
├── usage.json              # Token 用量和费用追踪
├── engine-home/            # 隔离的引擎配置、记忆、会话
│   ├── memory/             # Claude: 自动记忆 (CLAUDE_CONFIG_DIR)
│   ├── sessions/           # Codex: 线程历史 (CODEX_HOME)
│   └── ...                 # 每个 bot 的引擎状态完全隔离
├── workspace/              # Claude 工作目录（仅 Claude 引擎）
│   └── CLAUDE.md           # Claude Code 项目指令
├── .env                    # Bot token
├── access.json             # 配对 + 白名单数据
├── session.json            # 聊天到线程的绑定
├── runtime-state.json      # 水位线、偏移量
├── instance.lock.json      # 进程锁
├── audit.log.jsonl         # 结构化审计流
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
docker build -t cc-telegram-bridge .

# 运行
docker run -v ~/.cctb:/root/.codex cc-telegram-bridge telegram configure <token>
docker run -v ~/.cctb:/root/.codex cc-telegram-bridge telegram service start
```

挂载 `~/.cctb` 以在容器重启后保留状态。

---

## 故障排查

<details>
<summary><strong>Bot 不回复</strong></summary>

1. 运行 `telegram service doctor` 诊断
2. 查看 `telegram service logs` 的错误
3. 确认引擎已安装：`codex --version` 或 `claude --version`

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

## 许可证

[MIT](./LICENSE)

---

<p align="center">
  <sub>你的 agent。你的引擎。你的规则。</sub>
</p>
