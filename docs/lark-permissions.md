# Lark/Feishu permissions (scopes) for TaroCub bots

How to grant a Feishu app scope to a TaroCub Lark instance — and the one thing that is
easy to get wrong (and cost a long, wrong detour once).

## TL;DR — the thing that's easy to get wrong

TaroCub's Lark bots are registered as **Feishu 个人版 (PersonalAgent)** apps (via the
`lark wizard` QR flow). For these apps:

- **Optional scopes activate INSTANTLY on 申请开通 — there is NO version-publish step.**
- The developer console's version page shows `当前修改均已发布` ("all current changes
  published") and the new-version form shows `权限变更: 暂无` ("no permission changes").
  That means **there is nothing to publish** — NOT that the scope request failed.
- **Do NOT hunt for a 发布 / 上线 (publish) button.** It does not exist for 个人版.
  `申请开通` *is* the activation. (A full 企业自建版 app would need a version publish +
  admin review — but the QR-registered ccfcc/ccfgg bots are 个人版.)

> History: enabling `im:message.group_msg` for ccfgg3 took a ~30-step wrong detour
> hunting a non-existent publish button. The `申请开通` had already granted it. This doc
> exists so that never repeats.

## Auto-granted vs not

- **Core scopes** (receive/send messages, **@-mentioned** group messages, cards, …) are
  **auto-granted by the QR registration** (`lark wizard`). A freshly-created bot has these
  immediately — that's why new bots come up fast.
- **Optional / advanced scopes** (non-@ group messages for `/group all`, native slash
  autocomplete, Sheets, Calendar, Base, Docs auto-grant, …) are **NOT auto-granted.**
  Each must be added in the console.

The authoritative list of optional scope groups + their JSON lives in
`src/lark/provisioning.ts` (`LARK_OPTIONAL_SCOPE_GROUPS`), or print it:

```bash
node dist/src/index.js lark permissions
```

## Native slash-command autocomplete

The bridge can already parse `/status`, `/model`, and the rest without app metadata. To
also show them in Feishu/Lark's native `/` picker, grant
`application:app_slash_command:read` and `application:app_slash_command:write`, then run:

```bash
node dist/src/index.js lark slash sync --dry-run --instance <name>
node dist/src/index.js lark slash sync --instance <name>
# Or sync every saved Lark app with its own credentials:
node dist/src/index.js lark slash sync --all
```

Sync updates only TaroCub's canonical commands and preserves unrelated app commands. The
client can take about five minutes to refresh its command cache.

## Enable an optional scope (developer console)

Example: enable non-@ group messages so `/group all` works.

1. Open the app's permission page (per-instance app_id):
   `https://open.feishu.cn/app/<app_id>/auth`
   Get `<app_id>` from `~/.cctb/<instance>/lark.env` (`LARK_APP_ID`), or
   `node dist/src/index.js lark doctor --instance <name>` prints the console URL.
2. **批量导入/导出权限** → **导入** tab → paste the scope JSON. For `/group all`:
   ```json
   {"scopes":{"tenant":["im:message","im:message.group_msg"]}}
   ```
3. **下一步，确认新增权限** → **申请开通**.
4. 个人版 → done, instant. (No publish. If it ever says审核中, that's a 企业版 path — wait
   for admin approval.)

## Verify it's granted

```bash
node dist/src/index.js lark doctor --instance <name>
```

A granted optional scope **disappears from the `Optional — …` (missing) list**. E.g. once
`im:message.group_msg` was granted, the `ordinary (non-@) group messages — /group all` line
vanished. Then restart the instance to pick it up:

```bash
node dist/src/index.js lark service restart --instance <name>
```

## Doing the console step in the operator's browser

The console needs a Feishu login. Browser precedence is:

1. A named skill keeps the browser/profile it documents. Workflow-specific browser and
   login isolation belongs in that skill rather than in TaroCub's shared system prompt.
2. Otherwise, a signed-in task may use the operator's main Chrome only when the current
   engine session actually exposes a main-Chrome/Computer Use tool. Claude Chrome is one
   such route when enabled. TaroCub itself does not make that capability universal across
   Codex, Kimi, DeepSeek, and Antigravity.
3. If no main-Chrome tool is exposed, report the limitation. Do not improvise through
   shell/AppleScript, read main-Chrome cookies or keychain data, relaunch Chrome, or silently
   switch to another browser.
4. Legacy CDP/debug-port workflows are compatibility fallbacks only. Use one only when the
   operator explicitly requests that path; never attach to ports 9222/9223 or copy the main
   Chrome profile merely because a skill happens to mention them.

Public-URL retrieval is independent of signed-in browser control: use `web_extract` or the
available browser first, fall back to Scrapling for blocked/dynamic pages, otherwise use web
search, and disclose the web use with source links.

agent-browser's **own** managed Chrome is a fresh temp profile (NOT logged in). It is not a
fallback for a missing main-Chrome tool; use it only when a named workflow documents that
isolated profile or the operator explicitly selects it. Persisted sessions, when supported,
must use the path and scope documented by that named workflow.

The scope editor in the import dialog is a **Monaco** editor: plain typing triggers
bracket auto-close (mangles JSON), and `execCommand('insertText')` appends rather than
replaces. The reliable way: focus the editor, select-all (Cmd+A), then dispatch a synthetic
`paste` `ClipboardEvent` carrying the JSON (Monaco's paste handler replaces the selection
cleanly).

## After the scope is live: the per-group toggle

In the target group, send **`/group all`** — it self-authorizes that group, sets group
mode `enabled=true`, and turns on listen-all for that group only. After that the bot replies
**without** being @-mentioned in that group.

- Other groups are unaffected (still @-only — the global default is
  `LARK_REQUIRE_MENTION_IN_GROUP=true`; `/group all` is a per-group override).
- `/group at` reverts a group to @-only. `/group status` shows the current mode.
