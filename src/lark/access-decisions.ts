import type { BridgeAccessDecision } from "../runtime/bridge.js";

export const LARK_SINGLE_CHAT_LOCK_IGNORED_DETAIL = "single-chat lock owned by another Lark instance";

export function shouldSilentlyIgnoreLarkAccessDecision(
  decision: BridgeAccessDecision,
  input: { bridgeChatType: string },
): boolean {
  return input.bridgeChatType === "private" && decision.reason === "single_chat_locked";
}
