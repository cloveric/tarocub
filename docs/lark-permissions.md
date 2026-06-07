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
- **Optional / advanced scopes** (non-@ group messages for `/group all`, Sheets, Calendar,
  Base, Docs auto-grant, …) are **NOT auto-granted.** Each must be added in the console.

The authoritative list of optional scope groups + their JSON lives in
`src/lark/provisioning.ts` (`LARK_OPTIONAL_SCOPE_GROUPS`), or print it:

```bash
node dist/src/index.js lark permissions
```

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

The console needs a Feishu login. Two ways:

- **`agent-browser connect <cdp-port>`** — attach to the operator's already-logged-in
  Chrome (e.g. CDP `9222`) and drive the console with their existing session. Fastest when
  that Chrome is logged into the Feishu open platform.
- agent-browser's **own** managed Chrome is a fresh temp profile (NOT logged in) → it needs
  a QR scan-login first; the session is saved to `~/.cctb/feishu-console-auth.json` so a
  later run skips the scan.
- The scope editor in the import dialog is a **Monaco** editor: plain typing triggers
  bracket auto-close (mangles JSON), and `execCommand('insertText')` appends rather than
  replaces. The reliable way: focus the editor, select-all (Cmd+A), then dispatch a
  synthetic `paste` `ClipboardEvent` carrying the JSON (Monaco's paste handler replaces the
  selection cleanly).

## After the scope is live: the per-group toggle

In the target group, send **`/group all`** — it self-authorizes that group, sets group
mode `enabled=true`, and turns on listen-all for that group only. After that the bot replies
**without** being @-mentioned in that group.

- Other groups are unaffected (still @-only — the global default is
  `LARK_REQUIRE_MENTION_IN_GROUP=true`; `/group all` is a per-group override).
- `/group at` reverts a group to @-only. `/group status` shows the current mode.
