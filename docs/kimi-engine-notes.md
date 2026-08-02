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

### Usage

No `usage_update` notification and no `PromptResponse.usage` value were
observed across the ACP simple, tool, question, cancellation, seed, and loaded
turns. The built-in `/usage` command returned only assistant text:

```text
Session usage:
- Context: 0 / 1,048,576 (0.0%)
```

Therefore the initial adapter must report Kimi token/cost accounting as
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
did not print or copy token values. TaroCub must inherit the operator's Kimi
home by default, pass through explicitly configured `KIMI_*` values, and never
persist provider tokens into TaroCub config or logs.

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

The bridge therefore reloads `agent.md` for every turn, combines it with the
channel instructions, and prepends a clearly delimited `[Bridge Instructions]`
block to the ACP prompt. This preserves hot reload and resumed-session behavior,
but it is prompt-scoped rather than a trusted system channel and adds token and
history overhead. Revisit this implementation if a future Kimi ACP version
advertises an agent or system-prompt capability.

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
- `/compact`, which was verified against a real ACP session and preserved a
  probe token across the compaction turn;
- `/resume session <session-id>`, which validates through real ACP
  `session/load` before changing the bridge binding; Kimi ACP exposes no
  bridge-usable local session scan, so bare `/resume` explains the limitation;
- single-choice `AskUserQuestion` forms using only ACP-advertised option IDs.

No Kimi-private generated-image directory analogous to Codex
`generated_images` was observed. Kimi output is therefore subject to the
normal workspace and `.lark-out` sandbox rules; the bridge does not invent an
extra exception.

## Verified Gaps

- Kimi ACP has no mid-turn prompt injection. `/steer` reports the gap and new
  messages queue as separate turns.
- The live ACP `/goal` probe returned `Unknown ACP command: /goal`. The bridge
  rejects `/goal` explicitly rather than disguising a normal prompt as a goal.
- ACP 0.31.1 emits no structured per-turn token or cost telemetry. `/usage` and
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

## References

- Kimi Code documentation: <https://moonshotai.github.io/kimi-code/>
- Kimi command reference:
  <https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html>
- Kimi ACP reference:
  <https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html>
- Kimi MCP configuration:
  <https://moonshotai.github.io/kimi-code/en/configuration/mcp.html>
