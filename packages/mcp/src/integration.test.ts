import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { BrowserClient } from "@bb-browser/client";
import { FrameDecoder, encodeFrame } from "@bb-browser/shared";
import { BrokerRuntime } from "../../broker/src/broker-runtime.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "bb-mcp-life-"));
  const socketPath = join(root, "broker.sock");
  await writeFile(join(root, "auth-token"), "isolated-test-token\n", {
    mode: 0o600,
  });
  let runtime: BrokerRuntime;
  const commands: string[] = [];
  const start = async () => {
    const input = new PassThrough(),
      output = new PassThrough(),
      decoder = new FrameDecoder();
    output.on("data", (chunk) => {
      for (const message of decoder.push(chunk) as any[]) {
        if (message.kind !== "command.request") continue;
        commands.push(message.action);
        input.write(
          encodeFrame({
            kind: "command.response",
            protocolVersion: 2,
            requestId: message.requestId,
            sessionId: message.sessionId,
            success: true,
            data: { tabs: [] },
            timing: { queuedMs: 0, executionMs: 0 },
          }),
        );
      }
    });
    runtime = new BrokerRuntime({
      runtimeRoot: root,
      socketPath,
      authToken: "isolated-test-token",
      extensionInput: input,
      extensionOutput: output,
    });
    await runtime.start();
    input.write(
      encodeFrame({
        kind: "extension.hello",
        protocolVersion: 2,
        extensionVersion: "test",
        capabilities: [],
      }),
    );
    return runtime;
  };
  await start();
  t.after(async () => {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { root, socketPath, start, runtime: () => runtime, commands };
}

async function until(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not settle");
}

test("a real Client survives Broker replacement without replaying the interrupted call", async (t) => {
  const f = await fixture(t);
  const client = await BrowserClient.connect({
    clientName: "integration",
    authToken: "isolated-test-token",
    socketPath: f.socketPath,
  });
  t.after(() => client.close());
  await client.command(
    { action: "tab_list" },
    { timeoutMs: 500, idempotency: "read" },
  );
  const oldSession = client.sessionId;
  await f.runtime().stop();
  await until(() => !client.status().connected);
  await f.start();
  await assert.rejects(
    client.command(
      { action: "tab_list" },
      { timeoutMs: 500, idempotency: "read" },
    ),
    (error: any) => error.code === "session_reset",
  );
  assert.notEqual(client.sessionId, oldSession);
  assert.equal(f.commands.length, 1);
  assert.equal(
    (
      await client.command(
        { action: "tab_list" },
        { timeoutMs: 500, idempotency: "read" },
      )
    ).success,
    true,
  );
  assert.equal(f.commands.length, 2);
});

test(
  "real MCP children exit on stdin EOF and leave no sessions or connections",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    for (let n = 0; n < 3; n++) {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
        {
          env: {
            ...process.env,
            BB_BROWSER_SOCKET_PATH: f.socketPath,
            BB_BROWSER_CONFIG_ROOT: f.root,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      t.after(() => {
        if (child.exitCode === null) child.kill();
      });
      const exit = once(child, "exit");
      const responses = new Map<number, any>();
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id) responses.set(message.id, message);
      });
      let errors = "";
      child.stderr.on("data", (chunk) => {
        errors += chunk.toString();
      });
      const send = (message: unknown) =>
        child.stdin.write(JSON.stringify(message) + "\n");
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      });
      await until(() => responses.has(1));
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "browser_health", arguments: {} },
      });
      await until(() => responses.has(2));
      const health = JSON.parse(responses.get(2).result.content[0].text);
      assert.equal(health.broker?.activeSessions, 1, JSON.stringify(health));
      child.stdin.end();
      const [code] = await exit;
      assert.equal(code, 0, errors);
      await until(() => f.runtime().health().connections === 0);
      assert.equal(f.runtime().health().activeSessions, 0);
      assert.equal(f.runtime().health().detachedSessions, 0);
      lines.close();
    }
    assert.deepEqual(f.commands, []);
  },
);
