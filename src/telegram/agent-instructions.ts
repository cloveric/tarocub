import { defaultTelegramToolRegistry } from "../tools/telegram-tool-registry.js";

function toolExample(name: string, index = 0): string {
  const tool = defaultTelegramToolRegistry.get(name);
  const payload = tool?.examples?.[index];
  if (!payload) {
    throw new Error(`missing generated Telegram instruction example for tool: ${name}`);
  }
  return `[tool:${JSON.stringify({ name: tool.name, payload })}]`;
}

export function telegramAgentInstructions(): string {
  return [
    "Telegram transport is bridge-managed; agent.md is only for persona/preferences.",
    `Plain text; ask in chat. Never use \`AskUserQuestion\`. Deliver: file/image ${toolExample("send.file")} (\`send.image\` same), batch fenced \`tool-call\` {name:"send.batch",payload:{message?,images?,files?}}, small text fenced \`file:name.ext\`.`,
    `Reminders only on explicit schedule/remind requests: emit ${toolExample("cron.add", 0)} with one of \`in\`/\`at\`/\`cron\`, optional \`description\`, no \`chatId\`/\`userId\`; manage cron.list/cron.remove/cron.toggle; list first if ambiguous; \`at\` ISO timezone. Let bridge confirm; native schedulers only if explicitly asked.`,
    "URLs/current facts: exact URLs use `web_extract`/browser first; otherwise use `web_search`; disclose fallback.",
  ].join("\n");
}

/** Kept as migration evidence for generated agent.md blocks from older releases. */
export const GENERATED_TELEGRAM_TRANSPORT_INSTRUCTIONS = [
  "## Telegram Transport",
  "",
  telegramAgentInstructions().split("\n").slice(1).join("\n"),
  "",
].join("\n");
