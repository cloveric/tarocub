export type RuntimeTimeoutEngine = "codex" | "claude" | "antigravity" | "kimi" | "deepseek";
export type RuntimeTimeoutAction = "status" | "on" | "off";

export function renderRuntimeTimeoutMessage(
  engine: RuntimeTimeoutEngine | undefined,
  enabled: boolean,
  action: RuntimeTimeoutAction,
  locale: "en" | "zh",
): string {
  const name = engine === "deepseek"
    ? "DeepSeek Harness"
    : engine === "claude"
      ? "Claude"
      : engine === "kimi"
        ? "Kimi ACP"
        : engine === "antigravity"
          ? "Antigravity"
          : "Codex";
  const safeguards = engine === "claude"
    ? (locale === "zh" ? "30 分钟静默看门狗（本身无硬上限）" : "30-minute inactivity watchdog (no hard cap)")
    : engine === "deepseek" || engine === "antigravity"
      ? (locale === "zh" ? "6 小时硬上限和 30 分钟静默看门狗" : "6-hour hard cap and 30-minute inactivity watchdog")
      : engine === "kimi"
        ? (locale === "zh" ? "60 分钟硬上限和 30 分钟静默看门狗" : "60-minute hard cap and 30-minute inactivity watchdog")
        : (locale === "zh" ? "运行时硬上限和 30 分钟静默看门狗" : "runtime hard cap and 30-minute inactivity watchdog");

  if (locale === "zh") {
    if (action === "status") {
      if (!enabled && engine === "antigravity") {
        return `${name} bridge 运行时保护当前已放开；6 小时硬上限和 30 分钟静默看门狗已关闭，但 agy 仍保留 7 天原生安全上限。用 /timeout on 恢复。`;
      }
      return `${name} 运行时保护当前${enabled ? `已启用：${safeguards}` : "已放开（硬上限和静默看门狗均已关闭）"}。用 /timeout on 或 /timeout off 调整。`;
    }
    if (enabled) {
      return `已恢复 ${name} 运行时保护：${safeguards}。下一轮生效。`;
    }
    if (engine === "claude") {
      return "已放开 Claude 运行时限制，已关闭 30 分钟静默看门狗（Claude 本身无硬上限）；真卡死的任务不会自动恢复。下一轮生效。";
    }
    if (engine === "antigravity") {
      return "已关闭 Antigravity 的 6 小时 bridge 硬上限和 30 分钟静默看门狗；agy 仍保留 7 天原生安全上限。下一轮生效。";
    }
    return `已放开 ${name} 运行时限制，已关闭硬上限和静默看门狗；真卡死的任务不会自动恢复。下一轮生效。`;
  }

  if (action === "status") {
    if (!enabled && engine === "antigravity") {
      return `${name} bridge runtime safeguards are disabled; the 6-hour cap and 30-minute inactivity watchdog do not apply, but agy's 7-day native safety ceiling remains. Use /timeout on to restore them.`;
    }
    return `${name} runtime safeguards are currently ${enabled ? `enabled: ${safeguards}` : "disabled; neither the hard cap nor inactivity watchdog applies"}. Use /timeout on or /timeout off.`;
  }
  if (enabled) {
    return `Restored ${name} runtime safeguards: ${safeguards}. Takes effect from the next turn.`;
  }
  if (engine === "claude") {
    return "Disabled the Claude 30-minute inactivity watchdog (Claude has no hard cap); a truly stalled task will not auto-recover. Takes effect from the next turn.";
  }
  if (engine === "antigravity") {
    return "Disabled the Antigravity 6-hour bridge cap and 30-minute inactivity watchdog; agy's 7-day native safety ceiling remains. Takes effect from the next turn.";
  }
  return `Disabled the ${name} hard cap and inactivity watchdog; a truly stalled task will not auto-recover. Takes effect from the next turn.`;
}
