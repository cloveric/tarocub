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
    "Telegram transport is bridge-managed; agent.md only persona/preferences.",
    `Plain text; ask in chat. Never use \`AskUserQuestion\`. Deliver: file/image ${toolExample("send.file")} (\`send.image\` same), batch fenced \`tool-call\` {name:"send.batch",payload:{message?,images?,files?}}, small text fenced \`file:name.ext\`.`,
    `Reminders only if explicitly asked: emit ${toolExample("cron.add", 0)} with one of \`in\`/\`at\`/\`cron\`, optional \`description\`, no \`chatId\`/\`userId\`; manage cron.list/cron.remove/cron.toggle; list first if ambiguous; \`at\` ISO timezone. Let bridge confirm; native schedulers only if asked.`,
    "Login: selected skill's declared browser/profile wins. Else use only exposed main-Chrome control; unavailable→report. No shell/AppleScript/relaunch/quit/managed-browser workaround. No CDP/9222/9223, profile copies, or main-Chrome cookies/keychain unless legacy CDP requested. URL: web_extract/browser; blocked/dynamic→Scrapling; else web_search; disclose/cite.",
  ].join("\n");
}

/**
 * Frozen v0.1.354 agent.md template. Keep migration evidence independent from
 * the live runtime prompt so future wording/tool-example changes remain safe.
 */
export const GENERATED_TELEGRAM_TRANSPORT_INSTRUCTIONS = [
  "## Telegram Transport",
  "",
  "Plain text; ask in chat. Never use `AskUserQuestion`. Deliver: file/image [tool:{\"name\":\"send.file\",\"payload\":{\"path\":\"/absolute/path\"}}] (`send.image` same), batch fenced `tool-call` {name:\"send.batch\",payload:{message?,images?,files?}}, small text fenced `file:name.ext`.",
  "Reminders only on explicit schedule/remind requests: emit [tool:{\"name\":\"cron.add\",\"payload\":{\"in\":\"10m\",\"prompt\":\"check email\"}}] with one of `in`/`at`/`cron`, optional `description`, no `chatId`/`userId`; manage cron.list/cron.remove/cron.toggle; list first if ambiguous; `at` ISO timezone. Let bridge confirm; native schedulers only if explicitly asked.",
  "URLs/current facts: exact URLs use `web_extract`/browser first; otherwise use `web_search`; disclose fallback.",
  "",
].join("\n");
