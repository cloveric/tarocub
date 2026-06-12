// Live probe for the element-stream fast path against real Feishu.
// Sends ONE managed run card to the given chat using the production renderer
// (so it carries the real streaming_mode + streaming_config), then pushes
// cumulative text through the CardKit element-content endpoint at the
// production tick rate, and finally lands the terminal full patch.
//
// Usage: node scripts/live-element-stream-probe.mjs <instance> <chat_id> <tick_ms> <chars_per_tick> <total_chars> [label]
// Reads LARK_APP_ID / LARK_APP_SECRET / LARK_DOMAIN from ~/.cctb/<instance>/lark.env.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client, Domain } from "@larksuiteoapi/node-sdk";

import {
  applyLarkEngineEvent,
  initialLarkRunState,
  liveRunCardStreamElement,
  renderLarkRunCard,
  trimToStreamSafeBoundary,
} from "../dist/src/lark/card-renderer.js";
import { sendManagedCard, updateManagedCard } from "../dist/src/lark/managed-card.js";

const [instance, chatId, tickMsArg, charsPerTickArg, totalCharsArg, label = "probe"] = process.argv.slice(2);
if (!instance || !chatId) {
  console.error("usage: node scripts/live-element-stream-probe.mjs <instance> <chat_id> <tick_ms> <chars_per_tick> <total_chars> [label]");
  process.exit(1);
}
const tickMs = Number(tickMsArg ?? 150);
const charsPerTick = Number(charsPerTickArg ?? 10);
const totalChars = Number(totalCharsArg ?? 600);

const env = Object.fromEntries(
  readFileSync(path.join(os.homedir(), ".cctb", instance, "lark.env"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const eq = line.indexOf("=");
      return [line.slice(0, eq), line.slice(eq + 1).replace(/^"(.*)"$/, "$1")];
    }),
);

const client = new Client({
  appId: env.LARK_APP_ID,
  appSecret: env.LARK_APP_SECRET,
  domain: env.LARK_DOMAIN === "lark" ? Domain.Lark : Domain.Feishu,
});
const channel = { rawClient: client };

// A long Chinese passage so the typewriter has real CJK work to do.
const SENTENCE =
  "这是一次元素级流式更新的真机测试。打字机此刻渲染的每一个字,都来自卡片组件内容接口按生产节流推送的全量文本,飞书客户端负责对比增量并逐字输出。";
let answer = "";
while (answer.length < totalChars) {
  answer += SENTENCE;
}
answer = `【${label}】` + answer.slice(0, totalChars);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. Build the real running card (carries streaming_mode + streaming_config).
let state = initialLarkRunState("lark:probe");
const firstSlice = answer.slice(0, charsPerTick);
state = applyLarkEngineEvent(state, { type: "assistant_text", text: firstSlice });
const runningCard = renderLarkRunCard(state);
const config = runningCard.config;
console.log("card config:", JSON.stringify(config));
if (!config.streaming_mode || !config.streaming_config) {
  console.error("FATAL: running card is missing streaming_mode/streaming_config");
  process.exit(1);
}

const live = liveRunCardStreamElement(state);
if (!live) {
  console.error("FATAL: no live stream element on the running card");
  process.exit(1);
}
console.log("live element:", live.elementId);

// 2. Send it for real.
const handle = await sendManagedCard(channel, chatId, runningCard);
if (!handle) {
  console.error("FATAL: sendManagedCard failed (CardKit unavailable?)");
  process.exit(1);
}
console.log("card sent: message", handle.messageId, "card", handle.cardId);

// 3. Stream ticks: cumulative text through the element endpoint, raw call so
// errors stay visible (the production wrapper intentionally swallows them).
let sent = firstSlice.length;
let ok = 0;
let failed = 0;
const latencies = [];
const startedAt = Date.now();
while (sent < answer.length) {
  const tickStart = Date.now();
  sent = Math.min(sent + charsPerTick, answer.length);
  // Same boundary trim production uses, against the same growing text.
  const content = trimToStreamSafeBoundary(answer.slice(0, sent)) || answer.slice(0, sent);
  const sequence = (handle.sequence += 1);
  try {
    await client.cardkit.v1.cardElement.content({
      path: { card_id: handle.cardId, element_id: live.elementId },
      data: { content, sequence, uuid: `e_${handle.cardId}_${sequence}` },
    });
    ok += 1;
  } catch (error) {
    failed += 1;
    console.error("tick FAILED:", error?.response?.data ?? error?.message ?? error);
  }
  latencies.push(Date.now() - tickStart);
  const elapsed = Date.now() - tickStart;
  if (elapsed < tickMs) {
    await sleep(tickMs - elapsed);
  }
}

// 4. Terminal full patch through the production path (streaming_mode -> false).
state = applyLarkEngineEvent(state, { type: "assistant_text", text: answer.slice(firstSlice.length), delta: true });
state = applyLarkEngineEvent(state, { type: "result", text: answer });
const finalized = await updateManagedCard(channel, handle, renderLarkRunCard(state));

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))];
console.log(
  JSON.stringify({
    label,
    tickMs,
    charsPerTick,
    totalChars,
    ticks: ok + failed,
    ok,
    failed,
    finalized,
    wallSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    apiLatencyMs: { p50: pct(50), p90: pct(90), max: latencies[latencies.length - 1] },
  }),
);
