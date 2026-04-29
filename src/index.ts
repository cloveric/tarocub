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

function renderLifecycleError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

async function main(): Promise<void> {
  let logLifecycleEvent: (input: Parameters<typeof appendServiceLifecycleEventSync>[1]) => void = () => {};
  let removeUncaughtExceptionMonitor: (() => void) | undefined;

  try {
    const argv = process.argv.slice(2);

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
        CODEX_TELEGRAM_STATE_DIR: process.env.CODEX_TELEGRAM_STATE_DIR,
        CODEX_EXECUTABLE: process.env.CODEX_EXECUTABLE,
        CLAUDE_EXECUTABLE: process.env.CLAUDE_EXECUTABLE,
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
    removeUncaughtExceptionMonitor = () => {
      process.removeListener("uncaughtExceptionMonitor", uncaughtExceptionMonitor);
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
    // bots in sync with new dispatch rules (e.g. Scheduled Tasks added in
    // v4.5.6) without requiring the operator to run `telegram instructions
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
      await pollTelegramUpdates(api, bridge, config.inboxDir, console, abortController.signal);
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
