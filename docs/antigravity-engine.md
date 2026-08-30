# Antigravity Engine

TaroCub drives the official `agy` CLI as a native local engine. The verified
compatibility baseline is **Antigravity CLI 1.1.22**. Install and authenticate
`agy` locally before selecting `/engine antigravity`.

Official references:

- [Antigravity headless CLI](https://antigravity.google/docs/cli/headless/)
- [Antigravity slash commands](https://antigravity.google/docs/slash-commands/)
- [Antigravity CLI releases](https://github.com/google-antigravity/antigravity-cli/releases)

## Runtime Contract

Ordinary turns use one headless process per turn with both input and output in
NDJSON `stream-json` format. TaroCub sends one `user` event, closes stdin, and
accepts only structured `init`, `step_update`, and `result` records from stdout.
An unstructured stdout line, an error result, or a clean exit without the final
result record fails closed instead of being posted as assistant text.

TaroCub maps the stream as follows:

| Antigravity event | TaroCub event |
|---|---|
| `init.conversation_id` | session binding |
| agent-response `text_delta` | answer stream |
| active tool step | `tool_use` |
| terminal tool step | correlated `tool_result` |
| successful `result` | authoritative final answer |
| per-step usage | current-turn token accounting |

The result-level usage of a resumed conversation is cumulative. TaroCub does
not record that value directly; it sums the latest usage for each step in the
current process so resumed turns are not billed twice.

`/goal` is the one deliberate protocol exception. Antigravity does not accept
CLI slash commands through stream input, so TaroCub invokes native direct `-p`
prompt mode with `/goal` as the first prompt token while still parsing structured
output. Private bridge guidance and attachments follow the goal text and are
not allowed to hide the slash command inside an XML wrapper.

## Model, Effort, and Sessions

- `/model <id>` persists a single-token model ID and passes it as `--model` on
  the next turn. Use `agy models` to discover the current IDs. `/model off`
  restores the CLI default.
- `/effort` supports `low`, `medium`, `high`, and `off`, matching the native
  startup flag. Incompatible persisted values are removed before startup.
- A new turn binds the `conversation_id` from the structured stream. A resumed
  turn passes `--conversation <uuid>`. `/resume` can still scan recent CLI logs
  because `agy` does not expose a structured conversation-list command.
- The normal runtime policy is a six-hour hard cap plus a 30-minute inactivity
  watchdog. `/timeout off` removes both bridge watchdogs but explicitly passes
  a seven-day native ceiling; omitting the native flag would silently restore
  `agy`'s five-minute default.

## Capability Matrix

| Capability | Status | Boundary |
|---|---|---|
| Structured answer streaming | Supported | Native `stream-json` |
| Structured tool lifecycle | Supported | Tool input/output is correlated by step index |
| Conversation resume | Supported | Explicit UUID binding; log scan for discovery |
| Model and effort selection | Supported | Applied at process startup |
| Token usage | Supported | Per-turn step usage; no USD cost |
| Native `/goal` | Supported | Direct `-p` prompt mode, structured output |
| Files, media ASR, delivery tags | Supported | Shared TaroCub channel/delivery layers |
| Native MCP/plugins | Supported | Managed by Antigravity's own configuration |
| Per-tool remote approval | Not exposed | Headless stream input has no interactive control-response protocol |
| Structured questions | Not exposed | Turn-level approval is the safe bridge fallback |
| Mid-turn steering | Not exposed | Follow-ups queue as another turn |
| Post-result background lifecycle | Not exposed | Per-turn process exits after the result |
| Manual `/compact` or context telemetry | Not exposed | No official headless API currently available |

For approval mode `normal`, TaroCub asks once before the turn and then grants
the whole headless process inside Antigravity's sandbox. `full-auto` combines
the skip-permissions flag with `--sandbox`; only explicit `bypass` omits the
sandbox. This is not equivalent to the per-tool approval flows available from
Claude Code, Kimi ACP, or DeepSeek Harness.

## 中文摘要

TaroCub 已按 Antigravity 1.1.22 的原生结构化协议接入：普通轮次使用
`stream-json` 输入/输出，回答、工具、终态和 token 分开处理；恢复会话只统计
本轮 step，避免累计 token 重复记账。`/model` 和 `/effort` 会转成原生启动
参数，`/goal` 保持原生命令开头并解析结构化结果。`full-auto` 会同时启用
`--sandbox`；只有显式 `bypass` 才跳过沙箱。

尚未对齐 Codex/Claude 的部分来自当前上游边界，而不是 bridge 伪装支持：
Antigravity headless 暂无单工具远程审批、运行中 steer、结果后的后台任务生命
周期，以及手动 compact/context API。TaroCub 对这些能力明确显示为不支持。
