# Cron 协议统一方案（Phase 1：Tool Layer 收敛，CLI 保留）

> 写给实现者：本文是一份完整的实施规范，自带背景、目标、改动清单、测试计划、回退策略。读完不需要补充对话上下文即可动手。

---

## 1. 背景

当前 bridge 让引擎调用定时任务（cron）有**两条路径**：

1. **CLI 路径**：引擎的 Bash 工具运行 `cctb cron add ...`，通过 per-turn 环境变量 `CCTB_CRON_URL` / `CCTB_CRON_TOKEN` 找到一个 per-turn HTTP helper server，发 POST 请求。
2. **Tool 标签路径**：引擎在响应文本里输出 `[tool:{"name":"cron.add","payload":{...}}]`（或显式 fenced `tool-call` block），bridge 在投递前解析，然后转入内部 `cron.add` tool 落库。旧 `[cron-add:{...JSON...}]` 仍作为兼容别名保留。

两条路径的存在原因：
- CLI 路径**只在 per-turn 重新 spawn 进程的 adapter 上工作**（`ProcessCodexAdapter`、`ProcessClaudeAdapter`），因为 helper URL/token 每轮都换、要新进程才能拿到。
- `ClaudeStreamAdapter`（Claude bot 默认使用）**worker 跨轮复用**，环境变量在第一次 spawn 时就锁死，per-turn 注入永远到不了 worker 内。所以它必须走标签路径。
- `CodexAppServerAdapter` 同理（`supportsTurnScopedEnv = false`）。

后果：
- agent.md 指令必须写两套（"先试 CLI，失败用标签"），引擎要做条件判断。
- bridge 维护两套机制：helper server + tag parser。
- 加新引擎要再选一遍。
- Claude bot 经常幻觉成功（"✓ 已设置任务 ID xxxxxx"），因为 CLI 默默失败、模型猜测它成功了。

## 2. 目标

**用一条机制（schema-backed tool tag / tool block）覆盖所有引擎、所有 adapter、所有进程模型。**

具体目标：
1. 引擎统一走 `[tool:{"name":"cron.add",...}]` 标签，不再用 CLI。
2. agent.md 的 `## Scheduled Tasks` 段落简化到 1 条声明、0 条件分支。
3. 删除 per-turn cron helper server、删除 `CCTB_CRON_URL/TOKEN` env 注入。
4. 保留 `cctb cron` CLI 作为人类/调试入口，但不再把它写进 agent.md，也不再给引擎注入 per-turn cron env。
5. `npm test` 全过、`npm run build` 干净。

非目标（本次不做）：
- 不动 `[send-file:...]` / `[send-image:...]`、不动 `cctb send` CLI、不动 `CCTB_SEND_URL/TOKEN`。这些走 Phase 2。
- 不改 ClaudeStreamAdapter / ProcessClaudeAdapter 选择逻辑。
- 不改 `/cron` Telegram 命令（直接走 cron-commands.ts → cronStore，不经过 helper server，不受影响）。

## 3. 设计原则

1. **机制单一**：所有引擎读到完全一样的指令、走完全一样的代码路径。
2. **解耦进程模型**：协议只依赖"引擎能输出文本"，不依赖 env、PATH、helper server、子进程生命周期。
3. **chatId / userId 由 bridge 注入**：引擎不能在 payload 里指定别的 chat（防止 bot 在群里被 prompt-inject 到伪造别人的提醒）。
4. **失败显式可见**：解析错误必须以 "✗" 行的形式追加到用户回复，绝不静默吞掉。
5. **向后兼容窗口**：保留 `cron-helper-server.ts` 模块代码不立即删，但停止从 `message-turn.ts` 调用。下个 patch release 再正式删除文件。

## 4. 标签协议规范（不变，沿用现有 cron-tags.ts）

格式：

```
[tool:{"name":"cron.add","payload":JSON}]
```

`JSON` 是一个 JSON 对象，字段如下：

| 字段 | 必填 | 说明 |
|---|---|---|
| `prompt` | ✓ | 字符串，最长 4000，触发时作为消息发给引擎 |
| `cron` | 三选一 | cron 表达式，例 `"0 9 * * 1"`（周一 9 点） |
| `at` | 三选一 | ISO 时间戳，例 `"2026-05-01T09:00:00Z"`（必须将来）|
| `in` | 三选一 | 相对延时，正则 `^\d{1,6}(s|m|h|d)$`，例 `"10m"`、`"2h"`、`"1d"`，最长 366d |
| `description` | 可选 | 字符串，最长 200，用于 `/cron list` 显示 |
| `maxFailures` | 可选 | recurring job 的连续失败阈值，默认 3 |

**`cron` / `at` / `in` 必须恰好出现一个**，否则报 "use exactly one of in, at, or cron"。

`chatId` / `userId` / `chatType` **永远不能出现在 payload 里**——如果出现，忽略不报错（向前兼容）。bridge 在解析时从 dispatch context 注入。

合法示例：

```
[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"提醒我检查邮件"}}]
[tool:{"name":"cron.add","payload":{"at":"2026-05-01T09:00:00Z","prompt":"周一早会","description":"weekly standup"}}]
[tool:{"name":"cron.add","payload":{"cron":"0 9 * * 1","prompt":"周一汇总上周进展"}}]
```

bridge 行为：
1. 扫描 inline `[tool:...]` 标签和显式 fenced `tool-call` block；普通 markdown code 示例不会误触发。
2. 对每个匹配：把 JSON payload 和 dispatch context 交给 `executeTelegramTool({ name: "cron.add", ... })`。
3. `cron.add` tool 负责解析 JSON → 构造 `CronJobInput`（chatId/userId 来自 context）→ `cronStore.add()` → `scheduler.refresh()`。
4. 把所有标签从用户可见文本中剥掉。
5. 在剥后的文本末尾追加确认/失败行：
   - 成功：`✓ 已添加定时任务  ID  xxxxxxxx\n⏰ <when>\n📝 <prompt>`
   - 失败：`✗ 定时任务添加失败：<error message>`
6. timeline 写一条 `command.handled` 事件（success 或 error）。
7. recurring job 运行失败会累计 `failureCount` 和最近 10 条 `runHistory`；达到 `maxFailures` 后自动停用并写 `cron.disabled_after_failures`。

**传输层在 `src/telegram/tool-tags.ts`，执行层在 `src/tools/telegram-tool-registry.ts` / `src/tools/cron-add-tool.ts`。旧的 `src/telegram/cron-tags.ts` 仍作为 `[cron-add:...]` 兼容别名保留。**
The registry also owns tool schemas and current-chat management tools (`cron.list`, `cron.remove`, `cron.toggle`, `cron.run`) so future transports can invoke cron capabilities without adding more ad-hoc business logic to tag parsers.

## 5. Phase 1 改动清单

### 5.1 修改：`src/commands/access.ts`

**目标**：把 `## Scheduled Tasks` 段简化成单一标签声明。

#### 5.1.1 替换 `DEFAULT_INSTANCE_AGENT_INSTRUCTIONS` 中的 `## Scheduled Tasks` 段

**当前内容**（删掉）：

```
## Scheduled Tasks

For reminders or recurring tasks, use `cctb cron add --in 10m --prompt "..."`,
`cctb cron add --at ISO_TIME --prompt "..."`, or
`cctb cron add --cron "<m h dom mon dow>" --prompt "..."` when available;
use `cctb cron list` to inspect. If `cctb cron` is unavailable, ask the user
to send `/cron add <m h dom mon dow> <task>` or emit one
`[cron-add:{"in":"10m","prompt":"..."}]` fallback tag; use `at` or `cron`
instead of `in` when needed, never include chatId/userId, and let the bridge
confirm. Do not claim a reminder is scheduled unless the command succeeds or
the bridge confirms the fallback.
```

**新内容**：

```
## Scheduled Tasks

To schedule a Telegram reminder or recurring task, emit one inline tool tag in
your reply:

  [tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check email"}}]
  [tool:{"name":"cron.add","payload":{"at":"2026-05-01T09:00:00Z","prompt":"Monday standup"}}]
  [tool:{"name":"cron.add","payload":{"cron":"0 9 * * 1","prompt":"weekly summary"}}]

`prompt` is required. Use exactly one of `in` (e.g. "10m", "2h", "1d"),
`at` (ISO 8601 timestamp), or `cron` (5-field expression). Optional
`description` is shown in `/cron list`. Never put `chatId` or `userId` in
the payload. The bridge will confirm in the same reply with a "✓ 已添加" /
"✗ 失败" line. Do not claim a reminder is scheduled in your own words —
let the bridge confirmation be the receipt. Use native/session-local schedulers
only if the user explicitly asks for non-Telegram scheduling.

Users can also type `/cron list`, `/cron add ...`, `/cron rm ...` directly
in chat to manage tasks themselves.
```

#### 5.1.2 把当前的 `DEFAULT_INSTANCE_AGENT_INSTRUCTIONS` 段做为 legacy 加入升级识别

把当前生产中的 `## Scheduled Tasks` 段（含 `cctb cron add`、`fallback tag` 的混合版）追加到 `GENERATED_SCHEDULED_TASKS_BLOCKS` 数组的**最末位**。这样 `replaceTelegramTransportSection`（或对应的 `## Scheduled Tasks` 升级逻辑）能识别现有 7 个 bot 的 agent.md 并替换成新版。

> 实现注意：当前 `replaceTelegramTransportSection` 函数同时处理 Telegram Transport 和 Scheduled Tasks 两段。检查它是否已经能识别 Scheduled Tasks legacy block。如果不能，扩展它。

#### 5.1.3 验证升级路径

写一个新测试 `tests/access.test.ts`（或扩展现有的）：

- 输入：含旧 `## Scheduled Tasks`（`cctb cron add ... fallback tag ...` 或 `[cron-add:]`）的 agent.md
- 调用：`upgradeInstanceAgentInstructions`
- 断言：升级后内容只包含新的 `[tool:{"name":"cron.add",...}]` 声明，不包含 `cctb cron add` / `fallback`。

### 5.2 修改：`src/telegram/message-turn.ts`

**目标**：删除 per-turn cron helper server 启动/关闭和 `CCTB_CRON_URL/TOKEN` env 注入。`processCronAddTags` 调用保留。

定位代码段（参考 line 488-549，具体行号以当前文件为准）：

```ts
let cronHelper: CronHelperServer | undefined;
try {
  if (context.bridge.supportsTurnScopedEnv !== false) {
    sideChannel = await startSideChannelSendServer({...});
    // ...sideChannel 设置代码保留...

    // ↓↓↓ 删除从这里开始 ↓↓↓
    const cronRuntime = getActiveCronRuntime();
    if (cronRuntime) {
      try {
        cronHelper = await startCronHelperServer({...});
        sideChannelEnv = {
          ...sideChannelEnv,
          CCTB_CRON_URL: cronHelper.url,
          CCTB_CRON_TOKEN: cronHelper.token,
        };
      } catch {
        await cronHelper?.close().catch(() => {});
        cronHelper = undefined;
      }
    }
    // ↑↑↑ 删除到这里结束 ↑↑↑
  }
} catch {
  await sideChannel?.close().catch(() => {});
  await cronHelper?.close().catch(() => {});  // ← 删
  // ...
  cronHelper = undefined;  // ← 删
}
```

`finally` 块里：

```ts
await sideChannel?.close().catch(() => {});
await cronHelper?.close().catch(() => {});  // ← 删
```

文件顶部 import：

```ts
import { startCronHelperServer, type CronHelperServer } from "../runtime/cron-helper-server.js";  // ← 删
import { getActiveCronRuntime } from "../runtime/cron-runtime.js";  // ← 保留（processCronAddTags 还要用）
import { processCronAddTags } from "./cron-tags.js";  // ← 保留
```

**保留**（不动）：`processCronAddTags(...)` 调用——这是协议的实现入口。

### 5.3 修改：`src/codex/turn-env.ts`

把 `CCTB_CRON_URL` 和 `CCTB_CRON_TOKEN` 从 `ALLOWED_TURN_EXTRA_ENV_KEYS` 集合中删除：

```ts
const ALLOWED_TURN_EXTRA_ENV_KEYS = new Set([
  "CCTB_SEND_URL",
  "CCTB_SEND_TOKEN",
  "CCTB_SEND_COMMAND",
  // "CCTB_CRON_URL",   ← 删
  // "CCTB_CRON_TOKEN", ← 删
  "PATH",
]);
```

### 5.4 保留：`src/cron-cli.ts` 及其 CLI 入口

Phase 1 不删除 `src/cron-cli.ts`、`tests/cron-cli.test.ts`，也不删除 `src/commands/cli.ts` 里的 `cctb cron` 分支。它们继续作为开发者/管理员调试入口存在，但 agent.md 不再提示引擎使用它们。

后续如果真正做 Phase 2/3 tool layer，再单独评估 CLI 是否退役。

### 5.5 暂不删除：`src/runtime/cron-helper-server.ts` 和 `tests/cron-helper-server.test.ts`

**保留 1 个 release 周期**作为兼容窗口。在 `src/runtime/cron-helper-server.ts` 文件头部加一段注释：

```ts
// DEPRECATED: This helper server is no longer wired into per-turn dispatch.
// Engines should emit `[tool:{"name":"cron.add",...}]` tags instead — see
// docs/cron-protocol-unification.md. This file is kept for one release
// to ease rollback; remove in the version after Phase 1 ships.
```

`getActiveCronRuntime()`、`cron-runtime.ts`、`cron-store.ts`、`cron-scheduler.ts`、`cron-executor.ts`、`cron-tags.ts`、`telegram/cron-commands.ts` **全部保留不变**。

### 5.6 文档同步

- `docs/entrypoint-map.md` 如果提到 `cctb cron` 引擎调用 / cron helper server，更新为"引擎走 `[tool:{"name":"cron.add",...}]` 标签，bridge 在 tool-tags.ts 解析"。
- `docs/state-model.md` 如果有 cron helper server 段落，标注 deprecated。
- `docs/event-model.md` 检查 `command.handled` 事件描述是否仍准确。
- `docs/telegram-instance-agent.md` 同步 `## Scheduled Tasks` 新版。
- `README.md` / `README.zh-CN.md` 如果在 features 里提到 "engines call cctb cron"，改成 "engines emit `[tool:...]` tags"。

## 6. 测试计划

### 6.1 必须新增

`tests/cron-tags.test.ts`（扩充现有覆盖）：

```ts
describe("processCronAddTags", () => {
  it("extracts and applies a single in-duration tag");
  it("extracts and applies an at-timestamp tag");
  it("extracts and applies a cron-expression tag");
  it("rejects payload with both 'in' and 'cron'");
  it("rejects missing prompt");
  it("rejects invalid cron expression");
  it("rejects past at-timestamp");
  it("rejects in-duration > 366d");
  it("ignores tag inside fenced code block");
  it("ignores tag inside inline backticks");
  it("ignores chatId/userId in payload (uses context)");
  it("processes multiple tags in one response");
  it("strips tags from user-facing text");
  it("appends success line for each accepted tag");
  it("appends error line for each rejected tag");
  it("returns text unchanged when no tags present");
  it("emits timeline event for accepted tag");
  it("emits timeline event for rejected tag");
});
```

### 6.2 必须更新

- `tests/telegram-message-turn.test.ts`：删除 / 改写涉及 cron helper server 的断言。
- `tests/cli.test.ts`：保留 `cctb cron` 子命令测试，更新 agent.md 升级断言为标签协议。

### 6.3 必须保持通过

- `tests/cron-store.test.ts`
- `tests/cron-scheduler.test.ts`
- `tests/cron-executor.test.ts`
- `tests/telegram-cron-commands.test.ts`（`/cron` 命令）
- `tests/telegram-authorized-dispatch.test.ts`

### 6.4 验收脚本

```bash
npm run build           # 必须 0 错误 0 警告
npm test                # 必须全过
./scripts/pre-complete-hook.sh  # 必须通过
```

## 7. 兼容性与升级

### 7.1 现有 7 个 bot 的 agent.md

启动时 `upgradeInstanceAgentInstructions(env, instanceName, { force: false })` 已经在 `src/index.ts` 里被调用。本次扩展 `GENERATED_SCHEDULED_TASKS_BLOCKS` 后，下次 bot 启动时 agent.md 的 `## Scheduled Tasks` 会被自动替换成新版。**用户无需手动操作**。

### 7.2 已存在的 cron-jobs.json

格式不变（schemaVersion 保持当前值），所有现存 cron 任务正常加载、正常触发。

### 7.3 / cron Telegram 命令

不变。用户继续可以 `/cron list/add/rm/toggle/run/help`。

### 7.4 旧 agent.md 中提到 `cctb cron` 的影响

升级会自动替换。即使没升级（例如用户手工锁定了 agent.md），引擎运行 `cctb cron` 也不会再拿到 `CCTB_CRON_URL` / `CCTB_CRON_TOKEN`，命令会显式失败，不会静默落库。新版 agent.md 会让引擎直接输出 `[tool:{"name":"cron.add",...}]`。

## 8. 风险与回退

### 8.1 主要风险

| 风险 | 缓解 |
|---|---|
| 模型不熟悉新标签语法、产出格式偏差 | agent.md 给三个完整示例。cron-tags.ts 已有错误反馈机制，模型出错会看到 "✗" 行，下一轮自我修正。 |
| 升级路径漏检测某种历史版本 agent.md | `GENERATED_SCHEDULED_TASKS_BLOCKS` 数组完整收录所有曾出现过的版本。本次实施前先 `git log -p src/commands/access.ts` 把所有出现过的 Scheduled Tasks 段落抓出来加入。 |
| 测试覆盖不足导致回归 | 6.1 节列的 18 个测试用例全部实现。 |
| Phase 2 推迟，send-file 仍用旧机制 | OK，Phase 1 不动 send-file。Phase 2 再做时同样按本文档模式收敛。 |

### 8.2 回退策略

如果 Phase 1 上线后发现严重问题：

1. `git revert` 本次合并的 commit。
2. `cron-helper-server.ts` 仍保留一个 release 周期，`cron-cli.ts` 也未删除，revert 后 helper 自动回归。
3. 没有数据迁移，cron-jobs.json 格式始终一致。
4. agent.md 会在下次启动时**回退到旧的 GENERATED_SCHEDULED_TASKS_BLOCKS 版本之一**——`replaceTelegramTransportSection` 的对称逻辑决定。

## 9. 验收标准

实施完成的判据：

1. ✅ `npm run build` 干净通过
2. ✅ `npm test` 全部通过（含新增的 `tests/cron-tags.test.ts`）
3. ✅ `./scripts/pre-complete-hook.sh` 通过
4. ✅ `~/.cctb/<bot>/agent.md` 在 bot 启动后自动升级到新版 `## Scheduled Tasks`
5. ✅ 在一个 Claude bot 上发"提醒我 3 分钟后检查邮件"，3 分钟后真的收到提醒；`cron-jobs.json` 里能查到记录
6. ✅ 在一个 Codex bot 上做同样测试，结果一致
7. ✅ `git grep CCTB_CRON_URL` 在 src/ 下只剩 legacy 模板、CLI/测试、turn-env scrub、deprecated helper 等明确兼容点
8. ✅ `git grep "cctb cron add"` 在 src/ 下无结果（docs 里可以保留运维参考）

## 10. Phase 2 更新：文件投递也进入工具层

文件投递已按同一思路收敛到 `[tool:{...}]` 协议族：

```
[tool:{"name":"send.file","payload":{"path":"/absolute/path"}}]
[tool:{"name":"send.image","payload":{"path":"/absolute/image.png"}}]
[tool:{"name":"send.batch","payload":{"message":"Done","images":["/absolute/image.png"],"files":["/absolute/report.pdf"]}}]
[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check email"}}]
```

`cctb send` CLI、`CCTB_SEND_URL/TOKEN` env、side-channel server 继续保留作为 CLI 入口和兼容层；旧 `[send-file:]` / `[send-image:]` 标签会先归一到 send tool layer 再投递。

---

## 给 Codex 的实施备忘

1. 改动顺序建议：先做 5.1（agent.md），再做 5.2（message-turn），再做 5.3（turn-env），再做 5.4（cron-cli 删除），最后做 5.5 + 5.6 + 6.1（注释 + 文档 + 新测试）。每步独立可 review。
2. 每改一步跑一次 `npm test`，确保增量绿。
3. 不要顺手优化无关代码，scope 限定在本文档列出的文件。
4. 发现 5.1.2 升级识别遇到任何当前未覆盖的旧版本 agent.md 段落，把它加入 `GENERATED_SCHEDULED_TASKS_BLOCKS`，不要假设我们漏掉的就不存在。
5. commit 信息建议：`refactor: unify cron dispatch on inline tag protocol (Phase 1)`。

完成后请：
- 报告所有修改/新增/删除的文件清单
- 报告新测试通过情况
- 报告 `git diff --stat` 结果
- 不要自己启动/重启 bot 服务（用户会手动操作）
