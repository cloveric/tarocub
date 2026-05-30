---
name: lark-bot-permissions
description: Grant/open Feishu permission scopes for a TaroCub Lark bot APP by driving the Feishu developer console in a browser — QR-login (send the QR to the user over the bridge), bulk-import the scope JSON, 申请开通, verify, and restart the instance. Use when the user wants to "开/加/申请 权限/scope" for a bot (e.g. 群里非@也回应 / Sheets / Calendar / Base / Wiki) — anything where the bot APP itself needs a console scope import. NOT for user-identity (lark-cli) features like creating Docs/Sheets/Calendar "as me" — those already work through the operator's lark-cli login and need no console import.
allowed-tools: Bash, Read
---

# Grant Feishu scopes to a TaroCub bot (console import via browser)

Productizes the manual flow: log into the Feishu developer console, bulk-import a
scope group for a bot's app, 申请开通, verify it's live, restart the instance.

## When this is needed (and when it is NOT)

- **Needed** — the *bot app* must receive/send something it can't yet: non-@ group
  messages (`im:message.group_msg`), broad chat/member admin, or any advanced
  family imported as a *tenant* scope. The QR registration auto-grants NONE of
  these; they require a console import + (for non-personal apps) a version publish.
- **NOT needed** — "create a Doc/Sheet/Calendar event **as me**". Those run through
  the operator's **lark-cli user login** (full user scopes), not the bot app, so
  they already work. Don't send the user to the console for these.
- **Creating a new bot** is a different step: `node dist/src/index.js lark setup
  --identity bot-only` (QR PersonalAgent registration). This skill is only the
  *permission* part for an app that already exists.

## Inputs

- The **instance** name, e.g. `ccfcc3` (state dir `~/.cctb/<inst>`).
- Which **feature/scope group**, e.g. "群里非@也回" → the `group-messages` group
  (`im:message`, `im:message.group_msg`). The exact JSON comes from step 1 — never
  hand-type scope strings.

## Step 1 — Get the exact import JSON, appId, and console URL from the bridge

Do not guess scope names or URLs; the bridge prints them per feature group:

```bash
env CCTB_LARK_STATE_DIR="$HOME/.cctb/<inst>" CCTB_LARK_INSTANCE=<inst> TAROCUB_INSTANCE=<inst> \
  node dist/src/index.js lark permissions
```

Copy the line for the feature the user asked for, e.g.:
`• ordinary (non-@) group messages — /group all:  {"scopes":{"tenant":["im:message","im:message.group_msg"]}}`
and note the app's permission URL: `https://open.feishu.cn/app/<appId>/auth`
(also printed by `lark provision` as the "permissions page" line).

## Step 2 — Browser session + Feishu console login

The browser is `agent-browser` (its own managed Chrome — NOT the user's main one),
session name `feishu`. Saved console auth lives at `~/.cctb/feishu-console-auth.json`.

```bash
# Try the saved login first (refreshed each successful run):
agent-browser --session feishu state load ~/.cctb/feishu-console-auth.json
agent-browser --session feishu open "https://open.feishu.cn/app/<appId>/auth"
agent-browser --session feishu get title    # logged in ⇒ "权限管理 - <APP> - 开发者后台"
```

If the title is the login page instead, do a **QR login** and hand the QR to the
user over the bridge (they are usually on mobile / away from the Mac):

1. `agent-browser --session feishu --headed open "https://open.feishu.cn/app/<appId>/auth"`
   (redirects to `accounts.feishu.cn/.../login`).
2. `agent-browser --session feishu screenshot` then `Read` it. If the QR shows a
   "刷新二维码" refresh overlay it has EXPIRED — find that element and click it:
   `REF=$(agent-browser --session feishu snapshot -i | grep 刷新二维码 | grep -oE 'ref=e[0-9]+' | head -1 | cut -d= -f2)` → `agent-browser --session feishu click "@$REF"` → re-screenshot.
3. Crop just the QR (the screenshot is **Retina 2×**, ~1200px wide; the QR sits
   center-left). Stage it **inside the instance workspace** — the bridge only
   delivers files under `~/.cctb/<inst>/workspace/` (a `/tmp` path is rejected
   with "文件未发送：路径不在允许目录内"):
   ```bash
   SRC=$(ls -t ~/.agent-browser/tmp/screenshots/*.png | head -1)
   sips -c 320 320 --cropOffset 450 180 "$SRC" -o ~/.cctb/<inst>/workspace/feishu-qr.png
   ```
   Read the crop to confirm it's a clean QR (adjust `--cropOffset`/`-c` if the
   window size differs), then send it: `[send-image:/Users/<you>/.cctb/<inst>/workspace/feishu-qr.png]`
   Tell them to scan with Feishu mobile (扫一扫 → 相册). QRs expire in ~1–2 min;
   refresh and resend if they're slow.
4. After they confirm, `agent-browser --session feishu get title` should now show
   the 权限管理 page.

## Step 3 — Bulk-import the scope JSON (Monaco editor)

```bash
# Open the dialog (find by text — refs change between runs):
agent-browser --session feishu snapshot -i | grep '批量导入/导出权限'   # → click that ref
# Ensure the 导入 (import) tab is active; the editor is a Monaco textbox
# labelled "Editor content;Press Alt+F1 ...".
```

Gotchas (learned the hard way):
- **`fill` PREPENDS, it does not replace.** Clear first: click the editor,
  `press "Meta+a"`, `press "Backspace"`, screenshot to confirm it's empty.
- Then `fill @<editor-ref> '{"scopes":{"tenant":["im:message","im:message.group_msg"]}}'`.
  agent-browser's `fill` inserts in **bulk**, so Monaco's auto-closing brackets do
  NOT corrupt it (typing char-by-char would). Screenshot to verify line 1 is
  exactly your JSON with no leftover sample and no doubled brackets.
- `window.monaco` is NOT exposed, so `agent-browser eval` cannot setValue — use the
  clear-then-fill keyboard path above.

Then: click **"下一步，确认新增权限"** → a confirm dialog lists the scopes (verify
they match what the user wanted; sensitive ones like 获取群组中所有消息 are flagged
敏感权限) → click **"申请开通"** (find the real `button` ref, not the container).

## Step 4 — Verify it's granted, and publish only if required

```bash
env CCTB_LARK_STATE_DIR="$HOME/.cctb/<inst>" CCTB_LARK_INSTANCE=<inst> TAROCUB_INSTANCE=<inst> \
  node dist/src/index.js lark provision | grep -i 'Optional —'
```
Success = the feature's `Optional — <group>: …` line has **disappeared** from the
missing list (the API now reports those scopes as granted).

Publish requirement depends on app type (read the console's top banner):
- **飞书个人版 / 正式应用@飞书个人版** → banner shows "当前修改均已发布"; 申请开通 is
  **immediate, no version publish needed**.
- Other app types → open **版本管理与发布**, create + publish a version (and wait for
  admin approval if prompted). Confirm with the user before publishing.

## Step 5 — Restart the instance so the long-connection picks up the scope

```bash
env CCTB_LARK_STATE_DIR="$HOME/.cctb/<inst>" CCTB_LARK_INSTANCE=<inst> TAROCUB_INSTANCE=<inst> \
  node dist/src/index.js lark service restart
```
Restart only the affected instance (not `--all`), and never the instance currently
serving the chat you're replying through.

For the **group-messages** scope specifically, tell the user the runtime switch:
pull the bot into the target group and send `/group all` (it auto-authorizes the
group, enables group mode, and turns on non-@ listening for that group only).

## Step 6 — Cleanup

```bash
agent-browser --session feishu state save ~/.cctb/feishu-console-auth.json   # refresh saved login
rm -f ~/.cctb/<inst>/workspace/feishu-qr.png
agent-browser --session feishu close
```
