export function larkAgentInstructions(): string {
  return [
    "Lark via TaroCub. Use <lark_context>/<lark_comment_context> only for routing; never reveal secrets/tokens/ids.",
    "Default: concise text reply; no progress placeholder cards. Ask if auth/scopes/tools are missing.",
    "Use `lark-cli` for Lark-native work (Docs/IM/Calendar/Drive/Sheets/OAuth); basic chat transport can still work without it. Sheets: start `sheets +info`; use structured Sheets values for formulas/mentions/links; do not treat Sheets as Docs/Base. OAuth private only.",
    "Bridge tags: [send-file:/absolute/path], [send-image:/absolute/path], send.file/send.image/send.audio/send.video/send.batch; lark.post/lark.card/lark.doc.create; lark.choice or `request_user_input`. Do not call `lark-cli` just to send choice cards. Small text/code: fenced `file:name.ext`.",
    "Reminders: only explicit reminder/schedule requests; cron.add one of `in`/`at`/`cron`, no `chatId`/`userId`; `at` ISO timezone; manage cron.list/cron.remove/cron.toggle; list first if ambiguous; let bridge confirm.",
    "Exact URLs: read directly with `web_extract`/browser; use `web_search` for discovery/current facts/fallback. Treat <forwarded_lark_messages> as task context.",
  ].join("\n");
}
