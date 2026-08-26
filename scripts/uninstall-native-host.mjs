#!/usr/bin/env node

import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  defaultInstallOptions,
  NATIVE_HOST_NAME,
} from "./install-native-host.mjs";

export async function uninstallNativeHost(overrides = {}) {
  const options = { ...defaultInstallOptions(), ...overrides };
  const appRoot = resolve(options.appRoot);
  const chromeRoot = resolve(options.chromeRoot);
  const runtimeRoot = resolve(options.runtimeRoot);
  const manifestPath = join(
    chromeRoot,
    "NativeMessagingHosts",
    `${NATIVE_HOST_NAME}.json`,
  );
  const hostDirectory = join(appRoot, "native-host");
  const tokenPath = join(appRoot, "auth-token");
  const socketPath = join(runtimeRoot, "broker.sock");

  await rm(manifestPath, { force: true });
  await rm(hostDirectory, { recursive: true, force: true });
  await rm(tokenPath, { force: true });
  await rm(socketPath, { force: true });

  return { manifestPath, hostDirectory, tokenPath, socketPath };
}

function isDirectExecution() {
  return Boolean(
    process.argv[1] &&
      import.meta.url === pathToFileURL(resolve(process.argv[1])).href,
  );
}

if (isDirectExecution()) {
  uninstallNativeHost()
    .then(() => {
      process.stdout.write("Uninstalled bb-browser Native Host\n");
    })
    .catch((error) => {
      process.stderr.write(
        `Failed to uninstall bb-browser Native Host: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exitCode = 1;
    });
}
