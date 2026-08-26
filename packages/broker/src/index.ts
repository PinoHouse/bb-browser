import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { getRuntimePaths } from "@bb-browser/client";
import { BrokerRuntime } from "./broker-runtime.js";

export {
  BrokerRuntime,
  type BrokerHealth,
  type BrokerRuntimeOptions,
} from "./broker-runtime.js";
export {
  ClientServer,
  type ClientConnection,
  type ClientServerOptions,
} from "./client-server.js";
export { ExtensionChannel } from "./extension-channel.js";
export { LeaseManager } from "./lease-manager.js";
export { RequestRouter, type RequestRouterOptions } from "./request-router.js";
export { ResourceScheduler } from "./resource-scheduler.js";
export {
  SessionRegistry,
  type SessionRecord,
  type SessionRegistryOptions,
} from "./session-registry.js";

async function main(): Promise<void> {
  const paths = getRuntimePaths();
  const authToken = (await readFile(paths.tokenPath, "utf8")).trim();
  const runtime = new BrokerRuntime({
    runtimeRoot: paths.runtimeRoot,
    socketPath: paths.socketPath,
    authToken,
  });
  await runtime.start();

  let stopping = false;
  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    await runtime.stop();
  };
  runtime.once("extensionClosed", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(
      `[bb-browser] Native Host startup failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
