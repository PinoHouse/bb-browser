import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("MCP launcher resolves Node when Codex supplies a minimal PATH", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bb-mcp-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const binDir = join(root, "bin");
  const distDir = join(root, "dist");
  const launcherPath = join(binDir, "bb-browser-mcp");
  await mkdir(binDir, { recursive: true });
  await mkdir(distDir, { recursive: true });
  await copyFile(
    fileURLToPath(new URL("../bin/bb-browser-mcp", import.meta.url)),
    launcherPath,
  );
  await chmod(launcherPath, 0o755);
  await writeFile(
    join(distDir, "mcp.js"),
    'process.stdout.write("mcp-entry-ran\\n");\n',
  );

  const child = spawn(launcherPath, [], {
    env: {
      HOME: root,
      PATH: "/usr/bin:/bin",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.equal(stdout, "mcp-entry-ran\n");
});
