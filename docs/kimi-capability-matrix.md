# Kimi Capability Matrix

This matrix is the release contract for the Kimi Code engine. It compares Kimi
with the existing Codex and Claude engines and labels every Kimi row as either
aligned or an explicit gap. Initial protocol discovery used Kimi Code CLI
0.31.1; background-task hooks were re-probed with 0.32.0; the full
ACP/MCP/tool/hook path was re-probed on 0.33.0; and terminal delegation plus the
initial stdio MCP compatibility boundary were re-probed on 0.37.2. The current
compatibility baseline is 0.39.1, where `session/new` and `session/load` both
live-verified native stdio MCP startup. Remaining gaps must still be re-probed
before removal.

| Capability | Codex | Claude Code | Kimi Code alignment |
|---|---|---|---|
| Runtime transport | Persistent app-server by default; process fallback | Persistent stream-json worker | **Aligned:** persistent `kimi acp` worker with JSON-RPC framing; Kimi 0.39.1's default `agent-core-v2` path is live-verified |
| Local authentication | Codex home and native login | Claude config and native login | **Aligned:** native Kimi credentials and `KIMI_CODE_HOME`; TaroCub stores no provider token |
| Text streaming | App-server/process events | Stream-json events | **Aligned:** ACP `agent_message_chunk` -> shared `assistant_text` events |
| Thinking streaming | App-server reasoning events | Stream-json thinking events | **Aligned:** ACP `agent_thought_chunk` -> shared `thinking` events |
| Tool lifecycle | Structured tool events | Structured tool events | **Aligned:** ACP `tool_call` and `tool_call_update` -> shared tool events |
| Delegated terminal lifecycle | Runtime terminal/process tools | Runtime terminal/process tools | **Aligned:** first live-verified on Kimi 0.37.2 and retained under the 0.39.1 compatibility baseline; TaroCub serves ACP terminal create, bounded UTF-8 output, wait, kill, and release requests, while worker teardown kills unreleased process trees |
| Background tasks | Structured start/completion events | Structured start/completion events | **Aligned on Kimi 0.32+:** an authenticated loopback relay maps task and turn lifecycle hooks into shared events. On Kimi 0.33, TaroCub retains the synthetic task-origin ACP turn, associates automatic retries, records intermediate failures without user delivery, and emits one final reviewed result. Tool-result metadata remains the start fallback, detached Bash fallback notices include bounded real output, explicit successful workspace artifacts enter the shared delivery layer, lost reviews expire, terminal tombstones suppress late/duplicate events, and identity is scoped by conversation, session, and task ID across every Lark turn surface |
| Background liveness | Runtime task state | Runtime task state | **Aligned without false progress:** active tasks retain their ACP worker and protect restarts until a terminal notification; accepted hooks drain before fallback decisions and worker shutdown, while `SessionHeartbeat` is intentionally ignored because process liveness is not task progress. Silence alone never kills a retained worker |
| Stop/cancel | Runtime interrupt/abort | Worker abort | **Aligned:** ACP `session/cancel`, then process termination after the grace period |
| Normal approvals | App-server tool approval; process mode pre-approves the turn | Per-tool permission callback | **Aligned:** ACP permission callbacks use the shared approval policy and Lark/Telegram UI |
| Full-auto/bypass | Native sandbox/full-auto and bypass modes | Native permission modes | **Aligned:** full-auto -> ACP `yolo`; bypass -> ACP `auto` |
| Structured questions | Native request-user-input path | Native `AskUserQuestion` | **Partially aligned:** ACP-advertised single-choice options render in both Lark and Telegram; free-text and verified multi-question input remain unavailable |
| Model selection | Bridge model configuration | Bridge aliases/model configuration | **Aligned:** provider-advertised ACP model options; invalid IDs fail on the next real session |
| Effort/thinking | Model-dependent bridge values | Model-dependent bridge values | **Aligned:** ACP thinking options support `low`, `high`, and `max`; unsupported values fail closed |
| Project/instance instructions | Trusted runtime instruction channel | Appended system prompt | **Aligned for bridge-owned workspaces:** TaroCub atomically manages a block in the default `.kimi-code/agents/agent.md` main-agent override, retaining `${base_prompt}` and `${plugin_sections}`; ACP has no direct client-supplied system-prompt field, so external resumed workspaces remain untouched and use prompt fallback for ordinary text turns |
| New conversation | New thread/session through runtime | New Claude session | **Aligned:** ACP `session/new`, with the returned session ID persisted by the shared session store |
| Explicit resume | `/resume thread <id>` with runtime validation | `/resume <n>` after local scan | **Aligned:** `/resume session <id>` validates with real ACP `session/list` plus `session/load`, preserves the authoritative original `cwd`, and only then changes the chat binding |
| Resume candidate scan | Runtime-known thread validation, no bridge list | Local Claude session scan | **Aligned:** bare `/resume` uses ACP `session/list` and supports numbered selection in Telegram and Lark |
| Detach/reset | Shared session store | Shared session store | **Aligned:** shared detach/reset behavior restores the prior logical binding when available |
| Context compaction | Stateless reset fallback | Native `/compact` | **Aligned:** real ACP `/compact`, verified to retain a probe token in the same session |
| Goal mode | Bridge-native goal API | Native `/goal` prompt | **Gap:** live ACP 0.33 returned `Unknown ACP command: /goal`; TaroCub rejects it explicitly |
| Mid-turn steering | App-server `turn/steer` | No protocol support; later message queues | **Gap:** ACP has no mid-turn prompt injection; later messages queue as separate turns |
| Per-turn usage | Structured token usage when emitted | Structured tokens and cost | **Gap:** ACP 0.33.0 still emitted no structured token or cost telemetry in real probes |
| Spend budgets | Metered from structured usage | Metered from structured usage | **Gap:** without structured Kimi usage, configured dollar budgets cannot account for Kimi turns |
| Status/usage disclosure | Shared status and usage commands | Shared status and usage commands | **Aligned:** commands explicitly say Kimi turns are excluded instead of reporting false zero usage |
| File/image response tags | Shared send tools and fenced file blocks | Shared send tools and fenced file blocks | **Aligned:** shared `[send-file:]`, `[send-image:]`, `send.*`, and whole-response fenced `file:` paths |
| Lark output directory | `.lark-out` auto-delivery | `.lark-out` auto-delivery | **Aligned:** request-scoped `.lark-out` auto-delivery uses the same sandbox and receipts |
| Private generated-image directory | Codex `generated_images` sandbox exception | None | **Gap:** no Kimi-private generated-image directory was observed; normal workspace/output rules apply |
| Lark run cards | Streaming answer/thought/tool card | Streaming answer/thought/tool card | **Aligned:** Kimi events use the same run card, stop button, terminal state, and overflow delivery |
| Telegram final delivery | Shared delivery layer | Shared delivery layer | **Aligned:** Kimi uses the same text chunking, files, approval buttons, and failure notices |
| Cron execution | Shared scheduler/turn lock | Shared scheduler/turn lock | **Aligned:** Kimi cron turns use shared locking, budget disclosure, cards, and delivery |
| Locale and operator errors | Shared locale/error classification | Shared locale/error classification | **Aligned:** Kimi engine labels, auth/spawn errors, and capability gaps are localized |
| Turn timeout | Shared timeout and cancellation | Shared timeout and cancellation | **Aligned:** shared timeout abort reaches ACP cancellation and worker cleanup |
| Audio/video input | Channel ASR -> text | Channel ASR -> text | **Aligned at bridge layer:** ACP advertises `audio: false`, so channels transcribe media to text first |
| Local skills | Codex/user/project skills | Claude/user/project skills | **Aligned:** Kimi keeps its native `~/.agents/skills`, project `.kimi-code/skills`/`.agents/skills`, and plugin skills; TaroCub exposes `~/.codex/skills` through the bridge-owned workspace `.kimi-code/skills` path without replacing existing project skills; Kimi 0.33 also fixes macOS `spawn EBADF` failures from very large skill trees |
| MCP servers | Native Codex MCP configuration | Native Claude MCP/plugins | **Aligned on Kimi 0.39.1:** native Kimi user/project MCP/plugins remain active, and TaroCub injects its complete configured MCP list, including the Brave/Tavily stdio Search MCP, through ACP for every new or loaded session. Session initialization fails closed instead of silently omitting search capability |
| Optional native plugins | Native plugins/apps | Native plugins/MCP | **Available with local setup:** Kimi 0.33 offers official Computer Use and WebBridge capabilities, but ACP does not expose `/plugins`; install them in the local TUI and start a fresh Bot session. TaroCub does not auto-install user-wide high-privilege plugins |
| Thought verbosity control | Runtime-dependent | Runtime-dependent | **Gap:** compatibility `verbosity` does not suppress Kimi thought events in ACP 0.31.1 |
| Hot config during a turn | Runtime-dependent | Runtime-dependent | **Gap with safe deferral:** changes are rejected during an in-flight foreground turn. During retained background work, same-workspace model/thinking/instruction changes are deferred while turns continue on the existing worker; workspace or approval-mode changes fail closed. The next turn after terminal/safety expiry applies the pending configuration |

The protocol evidence, exact probes, and end-to-end verification are recorded
in [Kimi Engine Protocol Notes](./kimi-engine-notes.md).
