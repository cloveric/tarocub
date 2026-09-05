# Kimi Engine Protocol Notes

This document records the protocol evidence used to add Kimi Code CLI as a
TaroCub engine. It is intentionally evidence-first: behavior is marked as
verified only when it was observed against the locally installed binary.

## Probe Baseline

- Probe date: 2026-08-02
- Binary: `~/.kimi-code/bin/kimi`
- Version: `0.31.1`
- Prompt protocol: `kimi -p <prompt> --output-format stream-json`
- Preferred integration protocol: `kimi acp`
- ACP SDK used only for the disposable probe: `@agentclientprotocol/sdk@0.23.0`

The raw probe output was kept outside the repository under
`/tmp/tarocub-kimi-m1-20260802/`. It contains no Kimi credentials and is not a
release artifact.

## Integration Decision

Use ACP as the primary Kimi adapter protocol.

Prompt-mode `stream-json` is useful for diagnostics, but it cannot reach parity
with the existing streaming engines:

- it does not expose thinking chunks;
- it does not expose structured mid-turn approval callbacks;
- an `AskUserQuestion` request appears only as final prose;
- `-p` rejects `--yolo`, `--auto`, and `--plan` rather than composing with
  them;
- no per-turn token usage was observed.

ACP was verified to provide:

- assistant and thought chunks;
- structured tool lifecycle updates;
- mid-turn permission requests;
- structured `AskUserQuestion` choices over the same permission callback;
- soft cancellation with a `cancelled` stop reason;
- durable session IDs and cross-process `session/load`;
- runtime model, thinking, and mode configuration options.

This is sufficient to build the adapter without simulating unavailable Kimi
features.

## Kimi 0.41.0 Compatibility Re-probe

- Probe date: 2026-09-05
- Binary: official macOS arm64 Kimi Code archive, isolated before installation
- Version: `0.41.0`
- Integration protocol: persistent `kimi acp`

An isolated, no-prompt ACP probe initialized a new session and loaded the same
session in a second process with TaroCub's real stdio Search MCP descriptor. The
server child-start marker fired once on each path. Protocol version 1, the
`k3`/`k3-256k` model options, `low`/`high`/`max` thinking options, and
`default`/`plan`/`auto`/`yolo` mode options remained compatible.

Kimi 0.41.0 deliberately changes permission semantics: ACP `auto` is now true
Never Ask mode, so dangerous and unanalyzable shell commands are no longer
stopped for confirmation. TaroCub keeps its existing mapping but changes the
default for Kimi configurations without a stored approval mode to bridge
`full-auto` / ACP `yolo`; bridge `bypass` / ACP `auto` remains available only as
an explicit unsafe choice. Existing `bypass` configs without a 0.41 Never Ask
acknowledgement resolve to `yolo`; running the unsafe command again records that
acknowledgement. The status and command text describes that boundary without
claiming an OS sandbox. See the
[0.41.0 release](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%400.41.0)
and [upstream permission change](https://github.com/MoonshotAI/kimi-code/pull/3529).

The same release allows `AskUserQuestion(background=true)` to survive the end
of its foreground turn. TaroCub therefore gives background-question approvals
a worker-scoped abort lifecycle, retains them while the task is active, and
matches requests that arrive after the turn to the authenticated Hook-recorded
question task. Ambiguous or orphaned late requests are denied; worker teardown
and bounded task expiry also abort them fail closed.

## Kimi 0.40.1 Compatibility Re-probe

- Probe date: 2026-09-03
- Binary: `~/.kimi-code/bin/kimi`
- Version: `0.40.1`
- Integration protocol: persistent `kimi acp`

Both ACP new/load paths, the injected stdio Search MCP, and the advertised
`k3` / `max` / `auto` options remained compatible. Kimi 0.40.0 also stabilized
the optional secondary model, removed its own Bash cwd workspace restriction,
and changed dangerous-command handling: ACP `auto` blocks dangerous shell
commands by default, while manual/YOLO modes ask by default. TaroCub therefore
keeps the existing semantic mapping (`full-auto` -> ACP `yolo`, `bypass` -> ACP
`auto`) but no longer describes either mode as an OS sandbox. For the
bridge-level `full-auto` contract, delegated terminal cwd values are resolved
through symlinks and rejected when they leave the real workspace.

The cwd check constrains where a delegated terminal starts; it does not prevent
an allowed command from naming an absolute path outside the workspace. It must
not be presented as filesystem isolation.

## Kimi 0.39.1 Compatibility Re-probe

- Probe date: 2026-08-30
- Binary: `~/.kimi-code/bin/kimi`
- Version: `0.39.1`
- Integration protocol: persistent `kimi acp`

An isolated, no-prompt live probe initialized ACP, created a session with the
TaroCub stdio Search MCP, terminated that worker, and loaded the same session in
a fresh ACP process with the same MCP configuration. Both `session/new` and
`session/load` succeeded, and an external marker confirmed that the Search MCP
child process actually started each time. No stdio runtime-identity error or
fallback path was observed.

The compatibility baseline is therefore 0.39.1. TaroCub always sends the full
configured MCP list and surfaces session-initialization errors instead of
silently retrying without stdio search. This makes MCP regressions visible and
prevents a Bot from appearing healthy after its search capability disappeared.

The earlier 0.37.2 probe established Kimi's delegated ACP terminal behavior and
also exposed the now-fixed stdio runtime-identity regression. TaroCub continues
to implement terminal create, bounded UTF-8 output, wait, kill, release, and
worker-teardown cleanup; adapter tests retain those lifecycle contracts. The
temporary 0.37.2 stdio omission fallback has been retired.

## Kimi 0.32 Background-Task Hook Re-probe

- Probe date: 2026-08-05
- Binary: `~/.kimi-code/bin/kimi`
- Version: `0.32.0`
- Hook reference: <https://moonshotai.github.io/kimi-code/en/customization/hooks>

A live ACP turn starting detached Bash work returned structured tool output
containing `task_id`, `description`, and `automatic_notification: true`. When
the task completed, Kimi wrote a `turn.steer` notification into its internal
wire log, but the already completed ACP prompt subscription did not forward
that later turn to TaroCub. ACP alone therefore cannot provide reliable
out-of-band completion delivery.

Kimi 0.32 observer hooks close that gap. TaroCub registers a local
`tarocub-hook-relay` plugin in the selected `KIMI_CODE_HOME` with exactly these
events:

- `TaskStarted`, for the earliest detached-task start signal;
- `Notification`, restricted at runtime to background-task sources and used as
  the authoritative terminal event;
- `SubagentStop`, used to enrich a matching agent-task completion with the
  sub-agent response.

The plugin command is inert unless its Kimi subprocess inherits a per-process
loopback URL and random relay token from TaroCub. Accepted payloads must carry a
live ACP session ID and are serialized before entering the shared engine-event
path. Existing plugin records are preserved, registry updates are atomic, and
TaroCub does not rewrite Kimi credentials, sessions, skills, MCP configuration,
or `config.toml`. Hook failures are observer failures and never fail a Kimi
turn. On older Kimi releases, foreground ACP behavior remains available, but
TaroCub does not retain tool-result task metadata because no authoritative
terminal event exists; reliable post-turn lifecycle tracking requires the 0.32
hook surface.

`SessionHeartbeat` is intentionally neither registered nor accepted by the
relay. It indicates that a session process is alive; it does not prove that a
turn or background task is advancing. Treating it as progress would keep a
stuck task and restart guard alive indefinitely. ACP transport/process closure
continues to provide process-liveness failure detection, while only
task-specific start and terminal events affect task retention.

Kimi invokes observer hooks concurrently and does not guarantee delivery order.
TaroCub therefore keeps a bounded terminal tombstone per session/task: once a
terminal notification has been emitted, a late `TaskStarted`, duplicate
`Notification`, or delayed tool-result fallback cannot recreate a running task
or hold the restart guard for six hours. The loopback relay also stops accepting
new posts and drains every already accepted handler before adapter shutdown
kills the ACP worker.

The 0.32 `Notification` payload carries only a title/body summary; it omits the
background process children that contain the real output. For detached Bash
tasks, TaroCub resolves `output.log` only inside the matching
`KIMI_CODE_HOME/sessions/.../session_<id>/agents/<agent>/tasks/<task>/`
directory, verifies the resolved path stays under the sessions root, and reads
at most the final 64 KiB. Small outputs are delivered in full; large outputs are
explicitly marked as truncated. Agent tasks continue to prefer the matching
`SubagentStop` response.

### Kimi 0.33 task-origin review turns

Kimi 0.33 does not treat a process `Notification` as the final user answer. It
creates a synthetic turn whose origin is `task`, injects the notification as
that turn's prompt, and may inspect the output, explain a failure, launch a
replacement detached task, or produce corrected delivery tags. The original
ACP `session/prompt` subscription has already completed at that point, but the
persistent ACP connection continues to emit `session/update` messages.

TaroCub therefore also relays `TurnStarted`, `Stop`, `StopFailure`, and
`Interrupt`. A task-origin `TurnStarted` retains those otherwise orphaned ACP
updates and associates replacement task IDs discovered in tool output. Raw
process `Notification` events become internal state transitions rather than
immediate user messages. When the task-origin turn stops, an intermediate turn
that launched a replacement task is terminalized in the timeline with user
delivery suppressed; the final task-origin turn emits one reviewed completion
or failure. This preserves continuous restart protection without showing every
failed implementation attempt as the answer.

If a compatible Kimi build sends a terminal process notification but never
starts a task-origin review, TaroCub waits for a short bounded grace period and
then falls back to the bounded task output described above. Before making that
decision it performs a bounded drain of every Hook already accepted by the
loopback relay, so a queued `TurnStarted` cannot lose a race to the fallback
timer under load without letting a hung renderer block fallback forever. A
retained review also shares the six-hour task safety bound, so a lost terminal
Hook cannot block configuration changes or graceful restart indefinitely.
Silence before that bound never kills the ACP worker: same-workspace model,
thinking, or instruction changes are deferred, while workspace and approval-mode
changes fail closed until completion or explicit `/reset`. `SessionHeartbeat`
still does not extend either bound.

## Kimi 0.33 Agent-Core-v2 Re-probe

- Probe date: 2026-08-06
- Binary: `~/.kimi-code/bin/kimi`
- Version: `0.33.0`
- Engine: default `agent-core-v2` (no legacy fallback flag)

The 0.33 default engine completed real ACP initialization and session creation
without an interactive workspace-trust prompt blocking stdio. TaroCub then
successfully applied the ACP-advertised K3 model, `max` effort, and `auto`
approval mode; the local K3 model catalog declares a 1,048,576-token context
window. Text/thought/tool streaming, the injected `cctb_search` MCP, a native
plugin MCP, and the 0.32 observer-hook relay all worked in live turns.

The detached-task probe emitted `background_task_started`, delivered the
authoritative `task_notification` with the bounded real `output.log`, and did
not leave retained work after completion. Successful process output that
explicitly reports a supported workspace artifact with a final `saved`,
`wrote`, or `generated` line is normalized into the shared delivery layer;
failed tasks and paths that are missing, hidden, unsupported, or outside the
real workspace are never auto-delivered. Agent-core-v2 can continue the same
foreground turn after an earlier assistant message and tool call. ACP exposes
those as unlabelled text deltas, so TaroCub now inserts a paragraph boundary
when assistant output resumes after a tool boundary; token fragments within a
single assistant message remain unchanged.

Kimi 0.33's first-request MCP startup wait and `structuredContent`/`_meta`
support require no bridge-side protocol change. Native and injected MCP tools
were both callable in the same ACP session. Per-turn usage remained absent,
and live `/goal` and `/plugins list` probes both returned `Unknown ACP command`.
The official Computer Use and WebBridge capabilities must therefore be
installed through the local interactive TUI, then loaded by a fresh Bot
session; TaroCub does not modify the user-wide plugin registry on its own.

## Prompt-Mode Evidence

### Simple answer and session ID

Command shape:

```bash
kimi -p "Reply exactly KIMI_SIMPLE_OK and do not use tools." \
  --output-format stream-json
```

Observed stdout shape:

```json
{"role":"assistant","content":"KIMI_SIMPLE_OK"}
{"role":"meta","type":"session.resume_hint","session_id":"<session-id>","message":"..."}
```

The `session.resume_hint` meta event is the prompt-mode source of the Kimi
session ID. Running a second process with `-S <session-id>` recovered the exact
token from the preceding turn, so this is real context continuation rather than
an identifier-only acknowledgement.

### Tool call

For a prompt that required `pwd`, stdout contained the following sequence:

```json
{"role":"assistant","tool_calls":[{"type":"function","function":{"name":"Bash","arguments":"{\"command\":\"pwd\"}"},"id":"<tool-call-id>"}]}
{"role":"tool","tool_call_id":"<tool-call-id>","content":"<working-directory>\n"}
{"role":"assistant","content":"<final answer>"}
{"role":"meta","type":"session.resume_hint","session_id":"<session-id>","message":"..."}
```

Prompt mode applies its own automatic permission behavior. The following
combinations were rejected before a turn started:

```text
Cannot combine --prompt with --yolo.
Cannot combine --prompt with --auto.
```

This matches the current CLI reference. Engine permission modes therefore must
not be implemented by appending `-y` or `--auto` to a prompt-mode command.

### File write

A prompt requiring a workspace file produced `Write` and `Read` tool-call/tool
result pairs before the final answer. The resulting file bytes were verified on
disk and exactly matched the requested content. This proves that prompt mode
does execute workspace tools, but it does not add a client-controlled approval
callback.

### User question

When instructed to ask the user to choose red or blue and wait, prompt mode
emitted only this assistant event followed by a resume hint:

```json
{"role":"assistant","content":"Quick question before I continue - red or blue?"}
```

There was no structured question event and the process did not remain waiting
for an answer. A bridge could only treat that as an ordinary completed answer,
which is not sufficient for the existing Lark question-card behavior.

### Thinking and usage

Across the simple, tool, file-write, and question prompt-mode probes:

- no thinking or reasoning event was emitted;
- no usage, token, context-size, or cost event was emitted;
- successful stderr streams were empty;
- the only final metadata was `session.resume_hint`.

## ACP Evidence

ACP uses newline-delimited JSON-RPC over stdin/stdout. The probe used the SDK's
`ClientSideConnection` and `ndJsonStream` rather than parsing implementation
details outside the protocol.

### Initialization

The real `initialize` response advertised:

```json
{
  "protocolVersion": 1,
  "agentInfo": { "name": "Kimi Code CLI", "version": "0.31.1" },
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": {
      "image": true,
      "audio": false,
      "embeddedContext": true
    },
    "mcpCapabilities": { "http": true, "sse": true },
    "sessionCapabilities": { "list": {}, "resume": {} }
  }
}
```

The response also advertised terminal-based login. TaroCub must not attempt to
complete that interactive flow inside an ordinary chat turn; authentication
errors should tell the operator to run Kimi login explicitly.

### Session configuration

`session/new` returned a durable session ID and three select options:

| Option | Observed values | Observed default |
| --- | --- | --- |
| `model` | locally configured model IDs | local Kimi default |
| `thinking` | `low`, `high`, `max` | `high` |
| `mode` | `default`, `plan`, `auto`, `yolo` | `default` |

The model list is provider configuration, not a stable TaroCub constant. The
adapter should select a requested value through ACP and surface a clear error if
the current Kimi installation does not advertise it.

The observed mode descriptions are semantically important:

- `default`: manual tool approvals;
- `plan`: read-only planning;
- `auto`: fully autonomous, without questions;
- `yolo`: automatically approve tool actions, while preserving questions.

### Stream updates

The real simple turn emitted token-sized chunks using:

```json
{
  "sessionId": "<session-id>",
  "update": {
    "sessionUpdate": "agent_thought_chunk",
    "content": { "type": "text", "text": "..." }
  }
}
```

and:

```json
{
  "sessionId": "<session-id>",
  "update": {
    "sessionUpdate": "agent_message_chunk",
    "content": { "type": "text", "text": "..." }
  }
}
```

The terminal response was:

```json
{"stopReason":"end_turn"}
```

This supports direct mapping into TaroCub's reasoning and assistant-delta
events. Empty chunks were observed and should be ignored.

### Tool lifecycle and approval

A real `Bash pwd` turn emitted:

1. `tool_call` with `kind: "execute"`, `status: "pending"`, title, and ID;
2. incremental `tool_call_update` values while JSON arguments were generated;
3. `session/request_permission` with the tool ID and approval choices;
4. `tool_call_update` with parsed `rawInput` and `status: "in_progress"`;
5. `tool_call_update` with `rawOutput` and `status: "completed"`;
6. assistant message chunks and `stopReason: "end_turn"`.

The verified permission request shape was:

```json
{
  "sessionId": "<session-id>",
  "toolCall": {
    "title": "Bash",
    "toolCallId": "<tool-call-id>",
    "content": [{"type":"content","content":{"type":"text","text":"..."}}]
  },
  "options": [
    {"kind":"allow_once","name":"Approve once","optionId":"approve_once"},
    {"kind":"allow_always","name":"Approve for this session","optionId":"approve_always"},
    {"kind":"reject_once","name":"Reject","optionId":"reject"}
  ]
}
```

The adapter must return the advertised `optionId`; it must not infer or invent
approval IDs.

### Structured question

A real red/blue `AskUserQuestion` probe streamed the question text and then
sent `session/request_permission` with:

```json
{
  "toolCall": {
    "title": "AskUserQuestion",
    "toolCallId": "<tool-call-id>",
    "content": [{"type":"content","content":{"type":"text","text":"Which do you choose: red or blue?"}}]
  },
  "options": [
    {"kind":"allow_once","name":"red","optionId":"q0_opt_0"},
    {"kind":"allow_once","name":"blue","optionId":"q0_opt_1"},
    {"kind":"reject_once","name":"Skip","optionId":"q0_skip"}
  ]
}
```

The live permission request did **not** contain structured `rawInput` or a
`questions` array. The adapter therefore recognizes the exact tool title,
uses the tool-call content as the single question, and maps the advertised
non-reject options into the existing Lark form. Selecting `q0_opt_0` returned
`red` to the tool and the same prompt continued to its final answer.

Only advertised option IDs can be returned through ACP. The Lark form must not
offer an invented free-text `Other` answer for Kimi. Multiple simultaneous
questions and free-form answers remain unsupported until the protocol exposes
a way to represent them.

### Cancellation

Two cancellation points were verified:

- while the model was still producing thought chunks;
- after `sleep 60` was approved and its tool status became `in_progress`.

In the second case, sending `session/cancel` produced a failed tool update with
`rawOutput: "Interrupted by user"`, followed immediately by:

```json
{"stopReason":"cancelled"}
```

This is the correct `/stop` mechanism. The adapter should send the ACP cancel
notification first, retain the session ID, and reserve process termination for
a bounded shutdown fallback.

### Session restore

Cross-process restore was verified:

1. create a session and ask Kimi to remember an exact probe token;
2. terminate that ACP subprocess;
3. start a new `kimi acp` subprocess;
4. call `session/load` with the prior session ID and same cwd;
5. ask for the token.

`session/load` replayed prior user/assistant chunks and the new turn returned
the exact token. This is durable conversation continuation. The bridge should
ignore replayed history when constructing the new answer while still accepting
the restored configuration response.

### Session list

The same initialize response advertised `sessionCapabilities.list`. A direct
`session/list` probe returned durable session IDs with cwd, title, and update
time. TaroCub uses a short-lived initialized ACP control connection for listing.
Explicit-ID validation performs both `session/list` and a real `session/load`
with the authoritative returned cwd, then terminates the control process. Bare
`/resume` can therefore scan and select Kimi sessions, while binding fails
closed before persistence if the session cannot actually load.

### Usage

No `usage_update` notification and no `PromptResponse.usage` value were
observed across the ACP simple, tool, question, cancellation, seed, and loaded
turns. The built-in `/usage` command returned only assistant text:

```text
Session usage:
- Context: 0 / 1,048,576 (0.0%)
```

The 0.32.0 and 0.33.0 re-probes still produced no structured per-turn usage. Therefore the
adapter must report Kimi token/cost accounting as
unavailable. It must not convert context occupancy into billed input/output
tokens. If a future Kimi version starts sending protocol usage fields, support
can be added from real fixtures.

## MCP And Credentials

Current Kimi documentation and the local installation use separate concerns:

- provider/model settings: `~/.kimi-code/config.toml`;
- login credentials: `~/.kimi-code/credentials/kimi-code.json`;
- user MCP servers: `~/.kimi-code/mcp.json`;
- project MCP servers: `.kimi-code/mcp.json`;
- an alternate root may be selected with `KIMI_CODE_HOME`.

MCP servers are not defined as ordinary server entries inside `config.toml`.
The JSON MCP files support stdio, HTTP, and SSE transports, including per-server
environment, cwd, headers, enablement, and timeout settings. OAuth tokens are
managed separately by Kimi's MCP login flow.

The probe inspected only configuration structure and credential key names. It
did not print or copy token values. TaroCub inherits the operator's native Kimi
home by default and passes through only its explicit Kimi credential allowlist
(`KIMI_API_KEY`, model/registry API keys, and web fetch/search API keys).
Endpoint, OAuth-host, custom-header, home, marketplace, and unknown future
`KIMI_*` controls are rejected from `lark.env`/`shared.env`; provider tokens are
never persisted into TaroCub config or logs.

In addition to native Kimi MCP/plugin configuration, TaroCub passes its local
Brave/Tavily Search MCP as an ACP stdio server in both `session/new` and
`session/load`. A live probe confirmed that Kimi invoked
`mcp__cctb_search__provider_status`. Native Kimi MCP servers are not copied or
rewritten. Explicit provider environment variables win; if absent, the Search
MCP can read the existing provider keys from a local Codex MCP env section in
`CODEX_HOME/config.toml`. Values stay in local process memory and are neither
logged nor copied into Kimi config.

Kimi natively discovers `~/.agents/skills` and managed plugin skills, but ACP
did not honor a probe-only `--skills-dir`. For bridge-owned workspaces TaroCub
therefore exposes `~/.codex/skills` at `.kimi-code/skills` while preserving an
existing project skills path. A live system-context probe confirmed locally
installed skills such as `astock` and `dr` became visible.

## Consequences For Implementation

The first Kimi adapter should follow these rules:

1. Spawn `KIMI_EXECUTABLE` with `acp`, defaulting to
   `~/.kimi-code/bin/kimi` when the service PATH does not contain Kimi.
2. Initialize once per worker and create or load the bound session.
3. Map `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, and
   `tool_call_update` into existing engine events.
4. Route ordinary permission requests through the existing approval policy and
   route `AskUserQuestion` requests through the existing question-card flow.
5. Configure model, thinking, and permission mode through advertised ACP
   session options rather than prompt-mode CLI flags.
6. Use `session/cancel` for `/stop`; use process kill only after a grace period.
7. Preserve session IDs on cancellation and restart.
8. Show Kimi usage as unavailable until a structured usage field is actually
   observed.

## ACP Instruction Injection

Kimi Code 0.31.1 was probed with a valid custom-agent file, both with and
without `KIMI_CODE_EXPERIMENTAL_FLAG=1`. Starting `kimi --agent-file <path>
acp` did not apply that agent to sessions created through ACP `session/new`.
The ACP request has no agent or system-instruction field, so treating
`--agent-file` as working here would silently drop TaroCub and instance
instructions.

The supported project main-agent path behaved differently. Live ACP probes,
both inside and outside a Git repository, confirmed that workspace
`.kimi-code/agents/agent.md` with `name: agent` and `override: true` controls the
main-agent system context. The bridge atomically maintains a delimited TaroCub
block there, includes `${base_prompt}` so Kimi's built-in runtime/workspace/Skill
instructions remain active, and includes `${plugin_sections}` so enabled plugin
guidance remains active. It rejects malformed project-owned main-agent files or
reserved-marker collisions rather than claiming instructions are installed
when they are not. Instruction or project AGENTS changes re-create/load the
worker, and native slash commands such as `/compact` remain raw commands.

ACP still exposes no direct client-supplied system-prompt field. For an external
`workspaceOverride`, TaroCub does not edit that project and falls back to a
prompt-scoped instruction block for ordinary text turns. This is an explicit
safety boundary, not equivalent privileged-channel parity for arbitrary
external projects.

Kimi session config values also survive process restarts. To make `/model off`
and `/effort off` real rather than cosmetic, the bridge writes the current
`default_model` from `KIMI_CODE_HOME/config.toml` and its `high` effort default
back through ACP when those instance overrides are absent. If `default_model`
cannot be read, the bridge does not invent a model ID; operators can still set
an explicit provider-advertised ID with `/model <id>`.

## M4 Channel Alignment

The following behaviors are implemented through the shared bridge layer and
covered by integration tests for a Kimi-configured instance:

- Lark run-card streaming, thought/tool sections, stop-button cancellation,
  ordinary approvals, locale, timeout, and budget messaging;
- `[send-file:]`, `[send-image:]`, fenced `file:` blocks, and `.lark-out`
  automatic delivery;
- cron execution and Kimi engine labels;
- Kimi 0.32+ detached-task start/completion mapping into shared run-card,
  completion-notification, real Bash-output, worker-retention, and
  restart-protection paths, with conversation/session/task identity preserved
  for ordinary messages, card actions, comments, and bus turns;
- `/compact`, which was verified against a real ACP session and preserved a
  probe token across the compaction turn;
- bare `/resume`, numbered selection, and `/resume session <session-id>`, using
  real ACP `session/list` metadata plus pre-binding `session/load`, with the
  original session cwd persisted for the resumed turn;
- single-choice `AskUserQuestion` forms/buttons in Lark and Telegram using only
  ACP-advertised option IDs;
- native workspace instructions, local skills, and the injected TaroCub Search
  MCP alongside Kimi's own MCP/plugins.

No Kimi-private generated-image directory analogous to Codex
`generated_images` was observed. Kimi output is therefore subject to the
normal workspace and `.lark-out` sandbox rules; the bridge does not invent an
extra exception.

## Verified Gaps

- Kimi ACP has no mid-turn prompt injection. `/steer` reports the gap and new
  messages queue as separate turns.
- The live ACP `/goal` probe returned `Unknown ACP command: /goal`. The bridge
  rejects `/goal` explicitly rather than disguising a normal prompt as a goal.
- ACP 0.33.0 still emits no structured per-turn token or cost telemetry. `/usage` and
  `/status` say that Kimi turns are excluded; configured dollar budgets cannot
  meter them.
- ACP questions support selecting an advertised option ID, but not arbitrary
  free-text answers or verified multi-question forms.
- The existing `verbosity` setting is a compatibility/configuration value; it
  does not currently suppress Kimi thought events. Lark renders structured
  thought events in the run card, while Telegram has no live-edit stream card.
- Changing model, thinking, or mode during an already active prompt remains
  unverified. The bridge applies hot configuration to the next turn.
- Audio is not an ACP input capability (`audio: false`); channel audio remains
  supported only through the bridge's transcription-to-text path.
- ACP has no direct client-supplied system-prompt request field. Bridge-owned
  workspaces use Kimi's native main-agent override as system context; arbitrary
  external resumed workspaces are intentionally not modified and use ordinary
  prompt fallback.
- Kimi versions before 0.32 do not provide the hook surface required for
  reliable completion delivery after an ACP prompt has already returned.

## M5 Verification

The repository gate was run from a clean main worktree with:

```text
TMPDIR=/tmp/t bash scripts/pre-complete-hook.sh
```

Result: 126 test files passed, 2,220 tests passed, one test was skipped, and the
TypeScript build passed.

Sensitivity checks ran in a disposable detached worktree while retaining the
new tests:

- removing the M2 adapter implementation made the adapter suite fail to load;
- restoring the pre-M3 bridge/config implementation produced 24 test failures
  across all seven selected Kimi integration suites;
- restoring the pre-M4 channel implementation made the Kimi question,
  approval-label, compact, goal, resume/detach, usage/status, and steering tests
  fail.

The disposable worktree was removed afterwards and the main worktree remained
clean.

## M6 End-To-End Verification

The built Kimi adapter was exercised through the real shared runtime chain,
not a stub: `KimiAcpAdapter` -> `Bridge` -> `SessionManager` -> `SessionStore` ->
the installed `kimi acp` binary. The probe required the exact response marker
`KIMI_M6_FULL_CHAIN_OK`.

The real run produced the exact marker, emitted `session`, `thinking`,
`assistant_text`, and `result` events, persisted a non-empty Kimi session ID,
and rebound that logical session through the shared session store. The
temporary probe workspace and state were removed after verification.

The release-level Kimi/Codex/Claude comparison is maintained in
[Kimi Capability Matrix](./kimi-capability-matrix.md). Every Kimi row is marked
as aligned or as an explicit protocol/implementation gap.

## References

- Kimi Code documentation: <https://moonshotai.github.io/kimi-code/>
- Kimi command reference:
  <https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html>
- Kimi ACP reference:
  <https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html>
- Kimi MCP configuration:
  <https://moonshotai.github.io/kimi-code/en/configuration/mcp.html>
