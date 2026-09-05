# Antigravity Engine

TaroCub drives the official `agy` CLI as a native local engine. The verified
compatibility baseline is **Antigravity CLI 1.1.24**. Install and authenticate
`agy` locally before selecting `/engine antigravity`.

Official references:

- [Antigravity headless CLI](https://antigravity.google/docs/cli/headless/)
- [Antigravity slash commands](https://antigravity.google/docs/slash-commands/)
- [Antigravity CLI changelog](https://antigravity.google/changelog?app=cli)

The 1.1.24 baseline was live-verified with consecutive turns on one persistent
worker and a fresh-process `--conversation` resume. The public per-platform
updater manifest advertised 1.1.24 while the bundled CLI changelog still ended
at 1.1.23, so TaroCub treats the protocol probe, not an inferred changelog, as
the compatibility evidence.

## Runtime Contract

Ordinary turns share one persistent headless worker per live conversation, with
both input and output in NDJSON `stream-json` format. TaroCub writes one `user`
event per turn and keeps stdin open. It accepts one process-level `init`, the
matching `user` echo emitted by `agy`, and structured `step_update` and `result`
records for each turn. An unstructured stdout line, a mismatched user echo, an
error result, or a process exit before the active turn's final result fails
closed instead of being posted as assistant text.

The worker remains warm for later turns and is reaped after two idle hours.
Changing a startup setting such as workspace, approval mode, model, effort, or
native timeout recycles an idle worker and starts a replacement with
`--conversation <uuid>`. A crash removes the worker; the next turn resumes the
same authoritative conversation ID in a fresh process.

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
current turn so resumed turns are not billed twice.

`/goal` is the one deliberate protocol exception. Antigravity does not accept
CLI slash commands through stream input, so TaroCub first recycles the idle
persistent worker, then invokes native direct `-p` prompt mode with `/goal` as
the first prompt token while still parsing structured output. Private bridge
guidance and attachments follow the goal text and are not allowed to hide the
slash command inside an XML wrapper. The next ordinary turn starts a new stream
worker attached to the same conversation.

## Model, Effort, and Sessions

- `/model <id>` persists a single-token model ID and passes it as `--model` when
  the next worker starts. Changing it recycles an idle worker while preserving
  the conversation. Use `agy models` to discover the current IDs. `/model off`
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
| Post-result background lifecycle | Not exposed | A result ends the turn; the worker stays warm but emits no background-task lifecycle |
| Manual `/compact` or context telemetry | Not exposed | No official headless API currently available |

For approval mode `normal`, TaroCub asks once before the turn and then grants
the whole headless process inside Antigravity's sandbox. `full-auto` combines
the skip-permissions flag with `--sandbox`; only explicit `bypass` omits the
sandbox. This is not equivalent to the per-tool approval flows available from
Claude Code, Kimi ACP, or DeepSeek Harness.

## 中文摘要

TaroCub 已按 Antigravity 1.1.24 的原生结构化协议接入：每个活跃 conversation
维持一个 `stream-json` worker，后续轮次复用同一进程；回答、工具、终态和
token 分开处理，恢复会话只统计本轮 step，避免累计 token 重复记账。空闲
两小时、进程崩溃或启动参数变化时会安全回收，并用权威 conversation ID
重建。`/goal` 因上游限制仍使用一次性直接 `-p`，执行前会回收持久 worker，
下一轮再恢复同一会话。`full-auto` 会同时启用 `--sandbox`；只有显式
`bypass` 才跳过沙箱。

对会输出 `user` echo 的 CLI 版本，TaroCub 以“与当前 prompt 完全匹配的 echo”
作为持久 worker 的轮次边界：新一轮 echo 之前迟到的 `step_update` 会被隔离，
不会污染下一轮文本、进度或 token；缺少预期 echo 的结果会 fail closed。

尚未对齐 Codex/Claude 的部分来自当前上游边界，而不是 bridge 伪装支持：
Antigravity headless 暂无单工具远程审批、运行中 steer、结果后的后台任务生命
周期，以及手动 compact/context API。TaroCub 对这些能力明确显示为不支持。
