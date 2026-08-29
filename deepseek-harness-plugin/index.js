export const name = "deepseek-harness-web-search";
export const inject = ["systemPrompt", "commands"];

const SYSTEM_PROMPT = [
  "The DeepSeek Harness Web Search plugin is active in this profile.",
  "When the user supplies an exact URL, use mcp__cctb_search__web_extract first; use web_search for discovery and current facts.",
  "Use provider_status for secret-safe configuration checks and health_check only for explicit live diagnostics.",
  "Preserve source metadata and any provider fallback notice in the answer.",
  "TaroCub is an optional, separate Feishu/Lark-first gateway; use /tarocub only for companion setup guidance.",
].join(" ");

const HELP_TEXT = [
  "DeepSeek Harness Web Search is active in this profile.",
  "Search tools: web_search, web_extract, provider_status, and health_check under mcp__cctb_search__.",
  "The Feishu/Lark bridge is a separate local service; plugin installation alone does not configure or start it.",
  "Repository and setup: https://github.com/cloveric/tarocub",
  "Plugin repository: https://github.com/cloveric/deepseek-harness-web-search-plugin",
  "Install source: github:cloveric/deepseek-harness-web-search-plugin",
  "After building TaroCub, verify instances with: node dist/src/index.js lark service status --all",
].join("\n");

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: "integration:web-search",
    order: 195,
    text: SYSTEM_PROMPT,
  });
  ctx.effect(() => ctx.commands.register({
    name: "tarocub",
    description: "Show TaroCub Feishu/Lark bridge setup and verification guidance",
    handler: (invocation) => Promise.resolve(
      String(invocation?.rawInput ?? "").trim() === ""
        ? { kind: "success", text: HELP_TEXT }
        : { kind: "error", text: "The /tarocub command does not accept arguments." },
    ),
  }), "tarocub: command");
}
