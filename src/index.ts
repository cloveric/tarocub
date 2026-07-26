import path from "node:path";

import { runCli } from "./commands/cli.js";
import { acquireInstanceLock } from "./state/instance-lock.js";
import { rotateInstanceStructuredLogs } from "./state/log-rotation.js";
import { RuntimeStateStore } from "./state/runtime-state.js";
import { recoverLastHandledUpdateIdFromAudit } from "./state/runtime-state-recovery.js";
import { FileWorkflowStore } from "./state/file-workflow-store.js";
import { resolveConfig } from "./config.js";
import {
  createServiceDependencies,
  lookupTelegramBotIdentity,
  parseServiceInstanceName,
  pollTelegramUpdates,
  registerBotCommands,
  resolveServiceEnvForInstance,
  runQueuedTelegramTurn,
} from "./service.js";
import { loadBusConfig } from "./bus/bus-config.js";
import { createBusServer, startBusServer, stopBusServer } from "./bus/bus-server.js";
import { createBusTalkHandler } from "./bus/bus-handler.js";
import { pruneStaleInstances, registerInstance, deregisterInstance, resolveChannelRoot } from "./bus/bus-registry.js";
import { appendServiceLifecycleEventSync } from "./runtime/service-lifecycle-log.js";
import { pruneStaleTelegramRuntimeDirs } from "./runtime/telegram-out.js";
import { loadInstanceConfig } from "./telegram/instance-config.js";
import { buildCronExecutor, sendCronFailureNotification } from "./runtime/cron-executor.js";
import { initializeCronRuntime, shutdownCronRuntime } from "./runtime/cron-runtime.js";
import { upgradeInstanceAgentInstructions } from "./commands/access.js";
import { runSearchMcpServer } from "./search/search-mcp-server.js";
import { applyLarkBridgeRuntimeEnv, applyLarkEnvPassthrough, loadLarkRuntimeEnv, resolveLarkStateDir } from "./lark/env-file.js";
import { runLarkService } from "./lark/service.js";

function renderLifecycleError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function hasHelpFlag(args: string[]): boolean {
  return args.some((arg) => arg === "--help" || arg === "-h");
}

async function main(): Promise<void> {
  let logLifecycleEvent: (input: Parameters<typeof appendServiceLifecycleEventSync>[1]) => void = () => {};
  let removeUncaughtExceptionMonitor: (() => void) | undefined;

  try {
    const argv = process.argv.slice(2);

    if (argv[0] === "search-mcp") {
      await runSearchMcpServer();
      return;
    }

    if (argv[0] === "lark" && argv[1] === "run" && !hasHelpFlag(argv.slice(2))) {
      const larkEnv = await loadLarkRuntimeEnv(process.env);
      // Whitelisted bridge config the BRIDGE itself acts on (cloud-ASR routing +
      // the subprocess it spawns). These deliberately do NOT ride the extras
      // passthrough — TINGWU_/ASR_ are reserved there precisely so a lark.env
      // extra can never redirect what the bridge executes. loadLarkRuntimeEnv
      // read them from the whitelisted parse, so exporting them here is the one
      // sanctioned channel; an existing process.env value still wins.
      applyLarkBridgeRuntimeEnv(larkEnv);
      // Pass per-instance lark.env extras (e.g. MCP API tokens like IFIND_TOKEN) into
      // process.env so the spawned engine (claude/codex) inherits them. Names only.
      const passthroughKeys = await applyLarkEnvPassthrough(larkEnv);
      if (passthroughKeys.length > 0) {
        console.error(`[lark] lark.env passthrough → engine env: ${passthroughKeys.join(", ")}`);
      }
      // Mirror the Telegram service boot: rotate the structured instance logs so
      // Lark instances don't grow audit/timeline logs without bound across restarts.
      try {
        await rotateInstanceStructuredLogs(resolveLarkStateDir(larkEnv));
      } catch (error) {
        console.error(`[lark] structured log rotation failed: ${renderLifecycleError(error)}`);
      }
      // Parity with the Telegram boot path below: a service crash/restart can
      // leak file-workflow records stuck in "preparing"/"processing" — without
      // this they count against the active-file-task cap forever on Lark.
      try {
        await new FileWorkflowStore(resolveLarkStateDir(larkEnv)).failInterruptedProcessing();
      } catch (error) {
        console.error(`[lark] file-workflow recovery failed: ${renderLifecycleError(error)}`);
      }
      const abortController = new AbortController();
      const shutdownSigterm = () => abortController.abort("SIGTERM");
      const shutdownSigint = () => abortController.abort("SIGINT");
      const shutdownSighup = () => abortController.abort("SIGHUP");
      process.once("SIGTERM", shutdownSigterm);
      process.once("SIGINT", shutdownSigint);
      process.once("SIGHUP", shutdownSighup);
      try {
        await runLarkService(larkEnv, { signal: abortController.signal });
      } finally {
        process.removeListener("SIGTERM", shutdownSigterm);
        process.removeListener("SIGINT", shutdownSigint);
        process.removeListener("SIGHUP", shutdownSighup);
      }
      return;
    }

    if (await runCli(argv)) {
      return;
    }

    const instanceName = parseServiceInstanceName(argv);
    const resolvedEnv = await resolveServiceEnvForInstance(
      {
        HOME: process.env.HOME,
        APPDATA: process.env.APPDATA,
        USERPROFILE: process.env.USERPROFILE,
        CODEX_HOME: process.env.CODEX_HOME,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        TAROCUB_INSTANCE: process.env.TAROCUB_INSTANCE,
        CODEX_TELEGRAM_STATE_DIR: process.env.CODEX_TELEGRAM_STATE_DIR,
        CODEX_EXECUTABLE: process.env.CODEX_EXECUTABLE,
        CLAUDE_EXECUTABLE: process.env.CLAUDE_EXECUTABLE,
        ANTIGRAVITY_EXECUTABLE: process.env.ANTIGRAVITY_EXECUTABLE,
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      },
      instanceName,
    );

    const serviceConfig = resolveConfig(resolvedEnv);
    logLifecycleEvent = (event) => appendServiceLifecycleEventSync(serviceConfig.stateDir, event);
    logLifecycleEvent({
      type: "service.starting",
      instanceName,
      metadata: {
        argv: process.argv.slice(2),
      },
    });

    const uncaughtExceptionMonitor = (error: Error, origin: string) => {
      logLifecycleEvent({
        type: "process.uncaught_exception",
        instanceName,
        outcome: "error",
        detail: error.message,
        metadata: {
          origin,
          stack: error.stack,
        },
      });
    };
    process.on("uncaughtExceptionMonitor", uncaughtExceptionMonitor);
    // A stray promise rejection would otherwise terminate the long-running
    // service (Node's default) with only an "exit" event recorded. Log it and
    // keep running — losing one background task beats the whole bot dying,
    // especially with no autostart to respawn it.
    const unhandledRejectionHandler = (reason: unknown) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      logLifecycleEvent({
        type: "process.unhandled_rejection",
        instanceName,
        outcome: "error",
        detail: error.message,
        metadata: { stack: error.stack },
      });
    };
    process.on("unhandledRejection", unhandledRejectionHandler);
    removeUncaughtExceptionMonitor = () => {
      process.removeListener("uncaughtExceptionMonitor", uncaughtExceptionMonitor);
      process.removeListener("unhandledRejection", unhandledRejectionHandler);
    };

    const instanceLock = await acquireInstanceLock(serviceConfig.stateDir);
    const releaseLockOnExit = (code: number) => {
      logLifecycleEvent({
        type: "process.exit",
        instanceName,
        metadata: { code },
      });
      instanceLock.releaseSync();
    };

    process.once("exit", releaseLockOnExit);

    const abortController = new AbortController();
    const shutdown = (signal: "SIGTERM" | "SIGINT") => {
      logLifecycleEvent({
        type: "process.signal",
        instanceName,
        detail: signal,
      });
      abortController.abort();
    };
    const shutdownSigterm = () => shutdown("SIGTERM");
    const shutdownSigint = () => shutdown("SIGINT");
    process.once("SIGTERM", shutdownSigterm);
    process.once("SIGINT", shutdownSigint);

    await rotateInstanceStructuredLogs(serviceConfig.stateDir);
    try {
      await recoverLastHandledUpdateIdFromAudit(serviceConfig.stateDir);
    } catch (error) {
      logLifecycleEvent({
        type: "service.startup_maintenance",
        instanceName,
        outcome: "error",
        detail: `recover update watermark: ${renderLifecycleError(error)}`,
      });
    }

    // Auto-upgrade agent.md to the current generated template if the user
    // hasn't customized the Telegram Transport section. This keeps existing
    // bots in sync with new dispatch rules (e.g. the tool-layer transport
    // updates in v4.5.7) without requiring the operator to run `telegram instructions
    // upgrade` manually. force:false leaves custom-transport content alone.
    try {
      const result = await upgradeInstanceAgentInstructions(
        {
          HOME: resolvedEnv.HOME,
          USERPROFILE: resolvedEnv.USERPROFILE,
          CODEX_TELEGRAM_STATE_DIR: resolvedEnv.CODEX_TELEGRAM_STATE_DIR,
        },
        instanceName,
        { force: false },
      );
      if (result.changed) {
        logLifecycleEvent({
          type: "service.startup_maintenance",
          instanceName,
          outcome: "success",
          detail: `agent.md ${result.status}`,
        });
      }
    } catch (error) {
      logLifecycleEvent({
        type: "service.startup_maintenance",
        instanceName,
        outcome: "error",
        detail: `agent.md upgrade: ${renderLifecycleError(error)}`,
      });
    }
    await new RuntimeStateStore(path.join(serviceConfig.stateDir, "runtime-state.json")).resetActiveTurns();
    try {
      await new FileWorkflowStore(serviceConfig.stateDir).failInterruptedProcessing();
    } catch (error) {
      logLifecycleEvent({
        type: "service.startup_maintenance",
        instanceName,
        outcome: "error",
        detail: renderLifecycleError(error),
      });
    }

    const { api, bridge, config } = await createServiceDependencies(resolvedEnv);
    const instanceConfig = await loadInstanceConfig(config.stateDir);
    try {
      await pruneStaleTelegramRuntimeDirs(config.stateDir, instanceConfig.resume?.workspacePath);
    } catch (error) {
      logLifecycleEvent({
        type: "service.startup_maintenance",
        instanceName,
        outcome: "error",
        detail: renderLifecycleError(error),
      });
    }
    await registerBotCommands(api);
    let botUsername: string | undefined;
    try {
      botUsername = (await lookupTelegramBotIdentity(api)).username;
    } catch (error) {
      logLifecycleEvent({
        type: "service.startup_maintenance",
        instanceName,
        outcome: "error",
        detail: `bot identity lookup: ${renderLifecycleError(error)}`,
      });
    }

    try {
      const cronExecutor = buildCronExecutor({
        api,
        bridge,
        inboxDir: config.inboxDir,
        instanceName,
        handler: runQueuedTelegramTurn,
      });
      await initializeCronRuntime({
        stateDir: config.stateDir,
        executor: cronExecutor,
        instanceName,
        defaultTimezone: instanceConfig.timezone,
        onJobFailure: (job, detail) => sendCronFailureNotification(api, job, detail),
      });
    } catch (error) {
      logLifecycleEvent({
        type: "service.startup_maintenance",
        instanceName,
        outcome: "error",
        detail: `cron runtime init: ${renderLifecycleError(error)}`,
      });
    }

    logLifecycleEvent({
      type: "service.started",
      instanceName,
      outcome: "success",
    });

    let busServer: ReturnType<typeof createBusServer> | null = null;
    const channelRoot = resolveChannelRoot(config.stateDir);
    const busConfig = await loadBusConfig(config.stateDir);

    if (busConfig) {
      // Clear out entries for instances that have exited (PID no longer
      // alive). Keeps cross-instance /ask from connecting to dead ports.
      await pruneStaleInstances(channelRoot);

      const handler = createBusTalkHandler({
        bridge,
        stateDir: config.stateDir,
        instanceName,
      });

      busServer = createBusServer(instanceName, config.stateDir, handler, busConfig.secret);
      const boundPort = await startBusServer(busServer, busConfig.port);
      await registerInstance(channelRoot, instanceName, boundPort, busConfig.secret);
      console.log(`Bus server listening on 127.0.0.1:${boundPort}`);
    }

    try {
      await pollTelegramUpdates(api, bridge, config.inboxDir, console, abortController.signal, { botUsername });
    } finally {
      try {
        await shutdownCronRuntime();
      } catch (error) {
        logLifecycleEvent({
          type: "service.startup_maintenance",
          instanceName,
          outcome: "error",
          detail: `cron runtime shutdown: ${renderLifecycleError(error)}`,
        });
      }
      if (busServer) {
        await stopBusServer(busServer);
        await deregisterInstance(channelRoot, instanceName);
      }
      logLifecycleEvent({
        type: "service.stopped",
        instanceName,
        outcome: "success",
      });
      process.removeListener("SIGTERM", shutdownSigterm);
      process.removeListener("SIGINT", shutdownSigint);
      process.removeListener("exit", releaseLockOnExit);
      removeUncaughtExceptionMonitor?.();
      await instanceLock.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLifecycleEvent({
      type: "service.fatal",
      instanceName: parseServiceInstanceName(process.argv.slice(2)),
      outcome: "error",
      detail: message,
      metadata: {
        error: renderLifecycleError(error),
      },
    });
    removeUncaughtExceptionMonitor?.();
    console.error(message);
    process.exitCode = 1;
  }
}

void main();
