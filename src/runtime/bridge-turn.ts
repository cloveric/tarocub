import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AdapterUsage } from "../codex/adapter.js";
import { ConfigFileSchema, formatSchemaError } from "../state/config-file-schema.js";
import type { Locale } from "../telegram/message-renderer.js";
import { UsageStore, type UsageRecord } from "../state/usage-store.js";

export interface ExhaustedBudgetState {
  budgetUsd: number;
  usage: UsageRecord;
  message: string;
}

export interface RecordedTurnUsage {
  usage: UsageRecord;
  reachedBudget: boolean;
}

export async function loadBudgetUsd(stateDir: string): Promise<number | undefined> {
  const configPath = path.join(stateDir, "config.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(
        `Failed to read ${configPath}, falling back to no budget enforcement:`,
        error instanceof Error ? error.message : error,
      );
    }
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = ConfigFileSchema.safeParse(parsed);
    if (!result.success) {
      console.error(
        `Malformed ${configPath} (${formatSchemaError(result.error)}); bus budget enforcement is disabled until this is repaired.`,
      );
      return undefined;
    }
    return result.data.budgetUsd;
  } catch (error) {
    console.error(
      `Malformed ${configPath} (${error instanceof Error ? error.message : error}); bus budget enforcement is disabled until this is repaired.`,
    );
    return undefined;
  }
}

export async function checkBudgetAvailability(
  stateDir: string,
  budgetUsd: number | undefined,
  locale: Locale,
): Promise<ExhaustedBudgetState | null> {
  if (budgetUsd === undefined) {
    return null;
  }

  const usage = await new UsageStore(stateDir).load();
  if (usage.totalCostUsd < budgetUsd) {
    return null;
  }

  const message = locale === "zh"
    ? `预算已用尽：$${usage.totalCostUsd.toFixed(4)} / $${budgetUsd.toFixed(2)}。使用 \`telegram budget set <usd>\` 提高预算或 \`telegram budget clear\` 清除。`
    : `Budget exhausted: $${usage.totalCostUsd.toFixed(4)} used of $${budgetUsd.toFixed(2)}. Raise the budget with \`telegram budget set <usd>\` or clear it with \`telegram budget clear\`.`;

  return { budgetUsd, usage, message };
}

export async function recordBridgeTurnUsage(
  stateDir: string,
  usage: AdapterUsage | undefined,
  budgetUsd: number | undefined,
): Promise<RecordedTurnUsage | null> {
  if (!usage) {
    return null;
  }

  const usageStore = new UsageStore(stateDir);
  await usageStore.record({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens,
    costUsd: usage.costUsd,
  });

  const totals = await usageStore.load();
  return {
    usage: totals,
    reachedBudget: budgetUsd !== undefined && totals.totalCostUsd >= budgetUsd,
  };
}
