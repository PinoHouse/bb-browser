import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import { installNativeHost } from "./install-native-host.mjs";
import { uninstallNativeHost } from "./uninstall-native-host.mjs";

const EXTENSION_ORIGIN =
  "chrome-extension://ncpkoaiijcnacllhjjjfonmbhflmbnii/";

async function assertMissing(path) {
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
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
