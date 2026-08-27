import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { installNativeHost } from "./install-native-host.mjs";
import { uninstallNativeHost } from "./uninstall-native-host.mjs";

const EXTENSION_ORIGIN =
  "chrome-extension://ncpkoaiijcnacllhjjjfonmbhflmbnii/";

async function assertMissing(path) {
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
}

async function waitForPath(path, child, stderr) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    if (child.exitCode !== null) {
      throw new Error(
        `Native Host exited with code ${child.exitCode} before creating its socket: ${stderr()}`,
      );
    }
    await delay(50);
  }
  throw new Error(`Native Host did not create its socket: ${stderr()}`);
}

test("installer writes and atomically updates a stable user-level native host", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bb-native-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const appRoot = join(root, "app");
  const chromeRoot = join(root, "chrome");
  const runtimeRoot = join(root, "runtime");
  const source = join(root, "native-host.js");
  await writeFile(source, "process.exit(0);\n");

  const installed = await installNativeHost({
    appRoot,
    chromeRoot,
    runtimeRoot,
    source,
    nodePath: process.execPath,
  });

  const hostPath = join(appRoot, "native-host", "native-host.js");
  const launcherPath = join(appRoot, "native-host", "bb-browser-native-host");
  const tokenPath = join(appRoot, "auth-token");
  const manifestPath = join(
    chromeRoot,
    "NativeMessagingHosts",
    "com.pinix.bb_browser.json",
  );

  assert.deepEqual(installed, {
    appRoot,
    hostPath,
    launcherPath,
    manifestPath,
    tokenPath,
  });
  assert.equal(await readFile(hostPath, "utf8"), "process.exit(0);\n");
  const launcher = await readFile(launcherPath, "utf8");
  assert.match(launcher, /^#!\/bin\/sh\n/);
  assert.match(launcher, new RegExp(process.execPath.replaceAll("/", "\\/")));
  assert.match(launcher, new RegExp(hostPath.replaceAll("/", "\\/")));
  assert.equal((await stat(launcherPath)).mode & 0o777, 0o755);

  const firstToken = await readFile(tokenPath, "utf8");
  assert.match(firstToken, /^[a-f0-9]{64}\n$/);
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.name, "com.pinix.bb_browser");
  assert.equal(manifest.type, "stdio");
  assert.equal(isAbsolute(manifest.path), true);
  assert.equal(manifest.path, launcherPath);
  assert.deepEqual(manifest.allowed_origins, [EXTENSION_ORIGIN]);

  await writeFile(source, "process.exit(7);\n");
  await installNativeHost({
    appRoot,
    chromeRoot,
    runtimeRoot,
    source,
    nodePath: process.execPath,
  });

  assert.equal(await readFile(hostPath, "utf8"), "process.exit(7);\n");
  assert.equal(await readFile(tokenPath, "utf8"), firstToken);
  assert.deepEqual(
    (await readdir(join(appRoot, "native-host"))).sort(),
    ["bb-browser-native-host", "native-host.js"],
  );

  await mkdir(runtimeRoot, { recursive: true });
  const socketPath = join(runtimeRoot, "broker.sock");
  await writeFile(socketPath, "stale socket");
  const unrelatedPath = join(appRoot, "keep-me.txt");
  await writeFile(unrelatedPath, "unrelated\n");

  await uninstallNativeHost({ appRoot, chromeRoot, runtimeRoot });

  await assertMissing(manifestPath);
  await assertMissing(join(appRoot, "native-host"));
  await assertMissing(tokenPath);
  await assertMissing(socketPath);
  assert.equal(await readFile(unrelatedPath, "utf8"), "unrelated\n");
});

test("installed release native host starts without source-tree chunks", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bb-native-release-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const home = join(root, "home");
  const appRoot = join(home, "Library", "Application Support", "bb-browser");
  const chromeRoot = join(home, "Library", "Application Support", "Google", "Chrome");
  const runtimeRoot = join(root, "runtime");
  const source = fileURLToPath(new URL("../dist/native-host.js", import.meta.url));
  const { launcherPath } = await installNativeHost({
    appRoot,
    chromeRoot,
    runtimeRoot,
    source,
    nodePath: process.execPath,
  });
  const socketPath = join(runtimeRoot, "broker.sock");
  let stderr = "";
  const child = spawn(launcherPath, [], {
    env: {
      ...process.env,
      HOME: home,
      BB_BROWSER_SOCKET_PATH: socketPath,
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(() => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  });

  await waitForPath(socketPath, child, () => stderr);
  child.stdin.end();
  child.kill("SIGTERM");
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
});
