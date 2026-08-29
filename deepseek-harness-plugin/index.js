export const name = "tarocub";
export const inject = ["systemPrompt", "commands"];

const SYSTEM_PROMPT = [
  "The TaroCub companion bundle is active in this DeepSeek Harness profile.",
  "TaroCub is a separate local Feishu/Lark-first bridge; loading this plugin does not prove that the bridge is configured or running.",
  "Use /tarocub for setup and verification guidance, and never claim a successful bridge deployment without checking the local service status.",
].join(" ");

const HELP_TEXT = [
  "TaroCub companion plugin is active in this Harness profile.",
  "The Feishu/Lark bridge is a separate local service; plugin installation alone does not configure or start it.",
  "Repository and setup: https://github.com/cloveric/tarocub",
  "Install source: github:cloveric/tarocub#path:deepseek-harness-plugin",
  "After building TaroCub, verify instances with: node dist/src/index.js lark service status --all",
].join("\n");

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: "integration:tarocub",
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
