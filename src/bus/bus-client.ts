import { isPeerAllowed, loadBusConfig } from "./bus-config.js";
import { lookupInstance, resolveChannelRoot } from "./bus-registry.js";
import type { BusTalkResponse } from "./bus-server.js";

export interface BusDelegateInput {
  fromInstance: string;
  targetInstance: string;
  prompt: string;
  depth: number;
  stateDir: string;
}

export async function delegateToInstance(input: BusDelegateInput): Promise<BusTalkResponse> {
  const busConfig = await loadBusConfig(input.stateDir);
  if (!busConfig) {
    throw new Error("Bus is not enabled on this instance");
  }

  if (!isPeerAllowed(busConfig, input.targetInstance)) {
    throw new Error(`Instance "${input.targetInstance}" is not in the peer list`);
  }

  if (input.depth >= busConfig.maxDepth) {
    throw new Error(`Max delegation depth (${busConfig.maxDepth}) exceeded`);
  }

  const channelRoot = resolveChannelRoot(input.stateDir);
  // lookupInstance now probes the bus port, so a returned entry means the
  // server is actually reachable. A redundant PID check here would only
  // add false positives (PID alive but bus dead) — ECONNREFUSED from the
  // fetch() below gives us a more accurate error anyway.
  const target = await lookupInstance(channelRoot, input.targetInstance);
  if (!target) {
    throw new Error(
      `Instance "${input.targetInstance}" is not running or not registered on the bus`,
    );
  }

  const body = JSON.stringify({
    fromInstance: input.fromInstance,
    prompt: input.prompt,
    depth: input.depth + 1,
  });

  const url = `http://127.0.0.1:${target.port}/api/talk`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60 * 1000);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (target.secret) {
    headers.Authorization = `Bearer ${target.secret}`;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    const result = (await res.json()) as BusTalkResponse;

    if (!result.success) {
      throw new Error(result.error ?? `Delegation to "${input.targetInstance}" failed`);
    }

    return result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Delegation to "${input.targetInstance}" timed out after 60 seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
