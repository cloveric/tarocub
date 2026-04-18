import { runCli } from "./commands/cli.js";
import { acquireInstanceLock } from "./state/instance-lock.js";
import { resolveConfig } from "./config.js";
import {
  createServiceDependencies,
  parseServiceInstanceName,
  pollTelegramUpdates,
  registerBotCommands,
  resolveServiceEnvForInstance,
} from "./service.js";
import { loadBusConfig } from "./bus/bus-config.js";
import { createBusServer, startBusServer, stopBusServer } from "./bus/bus-server.js";
import { createBusTalkHandler } from "./bus/bus-handler.js";
import { pruneStaleInstances, registerInstance, deregisterInstance, resolveChannelRoot } from "./bus/bus-registry.js";

async function main(): Promise<void> {
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
    const instanceLock = await acquireInstanceLock(serviceConfig.stateDir);
    const releaseLockOnExit = () => {
      instanceLock.releaseSync();
    };

    process.once("exit", releaseLockOnExit);

    const abortController = new AbortController();
    const shutdown = () => {
      abortController.abort();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    const { api, bridge, config } = await createServiceDependencies(resolvedEnv);
    await registerBotCommands(api);

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
      if (busServer) {
        await stopBusServer(busServer);
        await deregisterInstance(channelRoot, instanceName);
      }
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);
      process.removeListener("exit", releaseLockOnExit);
      await instanceLock.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

void main();
