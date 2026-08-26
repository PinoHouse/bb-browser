#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const NATIVE_HOST_NAME = "com.pinix.bb_browser";
export const EXTENSION_ORIGIN =
  "chrome-extension://ncpkoaiijcnacllhjjjfonmbhflmbnii/";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export function defaultInstallOptions() {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return {
    appRoot: join(
      homedir(),
      "Library",
      "Application Support",
      "bb-browser",
    ),
    chromeRoot: join(
      homedir(),
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    ),
    runtimeRoot: join(tmpdir(), `bb-browser-${uid}`),
    source: resolve(scriptDirectory, "..", "dist", "native-host.js"),
    nodePath: process.execPath,
  };
}

function temporarySibling(target) {
  return join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
}

async function atomicWrite(target, contents, mode) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = temporarySibling(target);
  try {
    await writeFile(temporary, contents, { flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function createTokenIfMissing(tokenPath) {
  await mkdir(dirname(tokenPath), { recursive: true });
  const temporary = temporarySibling(tokenPath);
  try {
    const token = `${randomBytes(32).toString("hex")}\n`;
    await writeFile(temporary, token, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    try {
      await link(temporary, tokenPath);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
  await chmod(tokenPath, 0o600);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function installNativeHost(overrides = {}) {
  const options = { ...defaultInstallOptions(), ...overrides };
  const appRoot = resolve(options.appRoot);
  const chromeRoot = resolve(options.chromeRoot);
  const runtimeRoot = resolve(options.runtimeRoot);
  const source = resolve(options.source);
  const nodePath = resolve(options.nodePath);
  const hostDirectory = join(appRoot, "native-host");
  const hostPath = join(hostDirectory, "native-host.js");
  const launcherPath = join(hostDirectory, "bb-browser-native-host");
  const tokenPath = join(appRoot, "auth-token");
  const manifestPath = join(
    chromeRoot,
    "NativeMessagingHosts",
    `${NATIVE_HOST_NAME}.json`,
  );

  const sourceStats = await stat(source);
  if (!sourceStats.isFile()) {
    throw new Error(`Native Host bundle is not a file: ${source}`);
  }
  const sourceContents = await readFile(source);

  await mkdir(appRoot, { recursive: true, mode: 0o700 });
  await chmod(appRoot, 0o700);
  await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
  await chmod(hostDirectory, 0o700);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);

  await atomicWrite(hostPath, sourceContents, 0o644);
  await atomicWrite(
    launcherPath,
    `#!/bin/sh\nset -eu\nexec ${shellQuote(nodePath)} ${shellQuote(hostPath)}\n`,
    0o755,
  );
  await createTokenIfMissing(tokenPath);

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "bb-browser native broker",
    path: launcherPath,
    type: "stdio",
    allowed_origins: [EXTENSION_ORIGIN],
  };
  await atomicWrite(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o644,
  );

  return { appRoot, hostPath, launcherPath, manifestPath, tokenPath };
}

function isDirectExecution() {
  return Boolean(
    process.argv[1] &&
      import.meta.url === pathToFileURL(resolve(process.argv[1])).href,
  );
}

if (isDirectExecution()) {
  installNativeHost()
    .then(({ launcherPath, manifestPath }) => {
      process.stdout.write(
        `Installed bb-browser Native Host\nLauncher: ${launcherPath}\nManifest: ${manifestPath}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(
        `Failed to install bb-browser Native Host: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exitCode = 1;
    });
}
