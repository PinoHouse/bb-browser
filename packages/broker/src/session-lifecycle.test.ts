import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
import {
  encodeFrame,
  FrameDecoder,
  type BrokerToClientMessage,
  type BrokerToExtensionMessage,
  type SessionReady,
} from "@bb-browser/shared";
import { BrokerRuntime } from "./broker-runtime.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "bb-life-"));
  const socketPath = join(root, "broker.sock");
  const input = new PassThrough();
  const output = new PassThrough();
  const commands: BrokerToExtensionMessage[] = [];
  const decoder = new FrameDecoder();
  output.on("data", (chunk) =>
    commands.push(...(decoder.push(chunk) as BrokerToExtensionMessage[])),
  );
  const runtime = new BrokerRuntime({
    runtimeRoot: root,
    socketPath,
    authToken: "secret",
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
  const sockets: ReturnType<typeof createConnection>[] = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.destroy());
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });
  function connect(hello: Record<string, unknown> = {}) {
    const socket = createConnection(socketPath);
    sockets.push(socket);
    const messages: BrokerToClientMessage[] = [];
    const frameDecoder = new FrameDecoder();
    socket.on("data", (chunk) =>
      messages.push(...(frameDecoder.push(chunk) as BrokerToClientMessage[])),
    );
    socket.on("error", () => {});
    socket.on("connect", () =>
      socket.write(
        encodeFrame({
          kind: "client.hello",
          protocolVersion: 2,
          clientName: "test",
          authToken: "secret",
          capabilities: ["session-recovery-v1"],
          ...hello,
        }),
      ),
    );
    return {
      socket,
      messages,
      send(message: unknown) {
        socket.write(encodeFrame(message));
      },
      async next<K extends BrokerToClientMessage["kind"]>(kind: K) {
        await until(() => messages.some((message) => message.kind === kind));
        return messages.splice(
          messages.findIndex((message) => message.kind === kind),
          1,
        )[0] as Extract<BrokerToClientMessage, { kind: K }>;
      },
    };
  }
  return { runtime, connect, commands, input };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true");
}

test("recovery handshake, health and heartbeat bypass an occupied browser queue", async (t) => {
  const f = await fixture(t);
  const c = f.connect();
  const ready = await c.next("session.ready");
  assert.deepEqual(ready.capabilities, ["session-recovery-v1"]);
  assert.equal(typeof ready.brokerInstanceId, "string");
  c.send({
    kind: "command.request",
    protocolVersion: 2,
    clientId: ready.clientId,
    sessionId: ready.sessionId,
    requestId: "busy",
    action: "snapshot",
    tabId: 1,
    deadlineAt: Date.now() + 60_000,
    idempotency: "read",
    payload: {},
  });
  await until(() => f.commands.length === 1);
  c.send({
    kind: "session.health",
    protocolVersion: 2,
    sessionId: ready.sessionId,
    requestId: "health",
  });
  assert.deepEqual((await c.next("session.health.result")).health, {
    running: true,
    extensionConnected: true,
    activeSessions: 1,
    detachedSessions: 0,
    connections: 1,
    pendingRequests: 1,
    queuedRequests: 0,
    activeLeases: 0,
    protocolVersion: 2,
    brokerInstanceId: ready.brokerInstanceId,
  });
  c.send({ kind: "heartbeat", protocolVersion: 2, sentAt: 42 });
  assert.equal((await c.next("heartbeat")).sentAt, 42);
  assert.equal(f.commands.length, 1);
});

test("capacity and authentication rejection preserve structured failure reasons", async (t) => {
  const f = await fixture(t);
  const denied = f.connect({ authToken: "wrong" });
  assert.equal(
    (await denied.next("connection.error")).error.code,
    "authentication_failed",
  );
  for (let i = 0; i < 32; i++) await f.connect().next("session.ready");
  assert.equal(
    (await f.connect().next("connection.error")).error.code,
    "broker_capacity_exceeded",
  );
  assert.equal(f.runtime.health().activeSessions, 32);
});

test("session.end removes only its caller without closing browser tabs", async (t) => {
  const f = await fixture(t);
  const c = f.connect();
  const ready = await c.next("session.ready");
  await f.connect().next("session.ready");
  c.send({
    kind: "session.end",
    protocolVersion: 2,
    sessionId: ready.sessionId,
  });
  await until(() => f.runtime.health().activeSessions === 1);
  assert.equal(f.runtime.health().detachedSessions, 0);
  assert.deepEqual(f.commands, []);
});

test("disconnect retains same-tab exclusion until extension cancellation finishes", async (t) => {
  const f = await fixture(t);
  const a = f.connect();
  const first = await a.next("session.ready");
  const b = f.connect();
  const second = await b.next("session.ready");
  const request = (ready: SessionReady, requestId: string) => ({
    kind: "command.request",
    protocolVersion: 2,
    clientId: ready.clientId,
    sessionId: ready.sessionId,
    requestId,
    action: "click",
    tabId: 1,
    deadlineAt: Date.now() + 60_000,
    idempotency: "unsafe_write",
    payload: {},
  });
  a.send(request(first, "first"));
  await until(() => f.commands.length === 1);
  a.socket.destroy();
  await until(() =>
    f.commands.some((message) => message.kind === "request.cancel"),
  );
  b.send(request(second, "second"));
  await until(() => f.runtime.health().pendingRequests === 2);
  assert.equal(
    f.commands.filter((message) => message.kind === "command.request").length,
    1,
  );
  f.input.write(
    encodeFrame({
      kind: "command.response",
      protocolVersion: 2,
      requestId: "first",
      sessionId: first.sessionId,
      success: true,
      data: {},
      timing: { queuedMs: 0, executionMs: 1 },
    }),
  );
  await until(
    () =>
      f.commands.filter((message) => message.kind === "command.request")
        .length === 2,
  );
});

test("connected idle sessions survive admission, detached sessions expire periodically", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await fixture(t);
  const a = f.connect();
  const ready = await a.next("session.ready");
  const originalNow = Date.now;
  let now = originalNow();
  t.mock.method(Date, "now", () => now);
  now += 30 * 60_000;
  await f.connect().next("session.ready");
  a.send({
    kind: "session.health",
    protocolVersion: 2,
    sessionId: ready.sessionId,
    requestId: "idle",
  });
  assert.equal(
    (await a.next("session.health.result")).health.activeSessions,
    2,
  );
  a.socket.destroy();
  await until(() => f.runtime.health().detachedSessions === 1);
  now += 120_000;
  t.mock.timers.tick(10_000);
  assert.equal(f.runtime.health().detachedSessions, 0);
  assert.equal(f.runtime.health().activeSessions, 1);
  assert.deepEqual(f.commands, []);
});

test("a detached session resumes its original identity", async (t) => {
  const f = await fixture(t);
  const a = f.connect();
  const ready = await a.next("session.ready");
  a.socket.destroy();
  await until(() => f.runtime.health().detachedSessions === 1);
  const b = f.connect({
    resumeSessionId: ready.sessionId,
    resumeClientId: ready.clientId,
  });
  const resumed = await b.next("session.ready");
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.sessionId, ready.sessionId);
  assert.equal(f.runtime.health().activeSessions, 1);
  assert.equal(f.runtime.health().detachedSessions, 0);
});

test("shutdown releases all sessions and pending resources without closing tabs", async (t) => {
  const f = await fixture(t);
  const c = f.connect();
  const ready = await c.next("session.ready");
  c.send({
    kind: "command.request",
    protocolVersion: 2,
    clientId: ready.clientId,
    sessionId: ready.sessionId,
    requestId: "shutdown-busy",
    action: "snapshot",
    tabId: 1,
    deadlineAt: Date.now() + 60_000,
    idempotency: "read",
    payload: {},
  });
  await until(() => f.runtime.health().pendingRequests === 1);
  await f.runtime.stop();
  assert.equal(f.runtime.health().connections, 0);
  assert.equal(f.runtime.health().activeSessions, 0);
  assert.equal(f.runtime.health().detachedSessions, 0);
  assert.equal(f.runtime.health().pendingRequests, 0);
  assert.equal(
    f.commands.filter((message) => message.kind === "command.request").length,
    1,
  );
  assert.equal(
    f.commands.some(
      (message) =>
        message.kind === "command.request" && message.action === "close",
    ),
    false,
  );
});

test("connection lifecycle logs identify the failure without logging credentials", async (t) => {
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  const f = await fixture(t);
  const c = f.connect();
  const ready = await c.next("session.ready");
  const denied = f.connect({ authToken: "private-test-credential" });
  await denied.next("connection.error");
  const events = lines.map((line) => JSON.parse(line));
  assert.ok(
    events.some(
      (event) =>
        event.event === "session_connected" &&
        event.sessionId === ready.sessionId,
    ),
  );
  assert.ok(events.some((event) => event.code === "authentication_failed"));
  assert.equal(lines.join("").includes("private-test-credential"), false);
});
