import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { BrowserClient } from "@bb-browser/client";
import { startMcpServer } from "./server.js";

test("MCP stdin EOF closes its BrowserClient and removes lifecycle listeners", async (t) => {
  t.mock.method(BrowserClient, "connect", async () => {
    throw new Error("MCP must not eagerly connect to a live Broker");
  });
  const input = new PassThrough(),
    output = new PassThrough(),
    signals = new EventEmitter();
  const client = BrowserClient.create({
    clientName: "test",
    authToken: "test",
  });
  const runtime = await startMcpServer({
    stdin: input,
    stdout: output,
    signals,
    client,
  });
  assert.equal(typeof runtime?.shutdown, "function");
  input.end();
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.shutdown();
  await assert.rejects(
    client.command(
      { action: "tab_list" },
      { timeoutMs: 20, idempotency: "read" },
    ),
    (error: any) => error.code === "request_cancelled",
  );
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(input.listenerCount("end"), 0);
  output.destroy();
});

test("shutdown is idempotent across signals and transport closure", async (t) => {
  t.mock.method(BrowserClient, "connect", async () => {
    throw new Error("MCP must not eagerly connect to a live Broker");
  });
  const input = new PassThrough(),
    output = new PassThrough(),
    signals = new EventEmitter();
  const client = BrowserClient.create({
    clientName: "test",
    authToken: "test",
  });
  const runtime = await startMcpServer({
    stdin: input,
    stdout: output,
    signals,
    client,
  });
  signals.emit("SIGTERM");
  signals.emit("SIGINT");
  await runtime.shutdown();
  await runtime.shutdown();
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  input.destroy();
  output.destroy();
});
