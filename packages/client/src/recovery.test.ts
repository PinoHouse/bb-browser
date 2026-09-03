import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { performance } from "node:perf_hooks";
import { BrowserClient } from "./browser-client.js";

class Peer extends EventEmitter {
  sent: Record<string, any>[] = [];
  closed = false;
  held = new Set<string>();
  constructor(
    public sessionId = "s1",
    public resumed = false,
    public capabilities = ["session-recovery-v1"],
  ) {
    super();
  }
  send(message: Record<string, any>) {
    if (this.closed) throw new Error("closed");
    this.sent.push(message);
    queueMicrotask(() => {
      if (this.closed) return;
      if (message.kind === "client.hello")
        this.emit("message", {
          kind: "session.ready",
          protocolVersion: 2,
          clientId: "c1",
          sessionId: this.sessionId,
          resumed: this.resumed,
          capabilities: this.capabilities,
          brokerInstanceId: "b1",
        });
      if (message.kind === "heartbeat") this.emit("message", message);
      if (message.kind === "lease.acquire")
        this.emit("message", {
          kind: "lease.granted",
          protocolVersion: 2,
          sessionId: this.sessionId,
          requestId: message.requestId,
          leaseId: "lease1",
          tabId: message.tabId,
        });
      if (message.kind === "command.request" && !this.held.has(message.action))
        this.emit("message", {
          kind: "command.response",
          protocolVersion: 2,
          requestId: message.requestId,
          sessionId: this.sessionId,
          success: true,
          data: { tabs: [] },
          timing: { queuedMs: 0, executionMs: 0 },
        });
    });
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.emit("close");
    }
  }
}
const query = (client: BrowserClient) =>
  client.command(
    { action: "tab_list" },
    { timeoutMs: 1000, idempotency: "read" },
  );
const errorCode = (code: string) => (error: any) => error.code === code;

test("next requests share one reconnect and preserve session identity", async () => {
  const first = new Peer(),
    second = new Peer("s1", true);
  let reconnects = 0;
  const client = await BrowserClient.fromConnectedTransport(first, {
    clientName: "test",
    authToken: "test",
    transportFactory: async () => {
      reconnects++;
      return second;
    },
  });
  first.close();
  const results = await Promise.all([
    query(client),
    query(client),
    query(client),
  ]);
  assert.equal(
    results.every((result) => result.success),
    true,
  );
  assert.equal(reconnects, 1);
  assert.equal(second.sent[0].resumeSessionId, "s1");
  first.emit("close");
  assert.equal((await query(client)).success, true);
  client.close();
});

test("a submitted click is never replayed but later requests recover", async () => {
  const first = new Peer(),
    second = new Peer("s1", true);
  first.held.add("click");
  const client = await BrowserClient.fromConnectedTransport(first, {
    clientName: "test",
    authToken: "test",
    transportFactory: async () => second,
  });
  const result = client.command(
    { action: "click", tabId: 1, ref: "e1" },
    { timeoutMs: 1000, idempotency: "unsafe_write" },
  );
  const rejected = assert.rejects(
    result,
    errorCode("result_unknown_after_disconnect"),
  );
  first.close();
  await rejected;
  await query(client);
  assert.equal(
    [...first.sent, ...second.sent].filter((item) => item.action === "click")
      .length,
    1,
  );
  client.close();
});

test("failed resume reports reset before any operation and never claims old tabs cleaned", async () => {
  const first = new Peer(),
    second = new Peer("s2", false);
  const client = await BrowserClient.fromConnectedTransport(first, {
    clientName: "test",
    authToken: "test",
    transportFactory: async () => second,
  });
  first.close();
  await assert.rejects(query(client), errorCode("session_reset"));
  assert.equal((await query(client)).success, true);
  await assert.rejects(client.closeOwnedTabs(), errorCode("session_reset"));
  assert.equal(
    second.sent.some((item) => item.kind === "session.close_owned_tabs"),
    false,
  );
  client.close();
});

test("a lease cannot cross a recovered transport and cleanup preserves the original error", async () => {
  const first = new Peer(),
    second = new Peer("s1", true);
  const client = await BrowserClient.fromConnectedTransport(first, {
    clientName: "test",
    authToken: "test",
    transportFactory: async () => second,
  });
  await assert.rejects(
    client.withTabLease(1, 1000, async (leaseId) => {
      first.close();
      await query(client);
      return client.command(
        { action: "eval", tabId: 1, script: "1" },
        { timeoutMs: 1000, idempotency: "read", leaseId },
      );
    }),
    errorCode("session_reset"),
  );
  assert.equal(
    second.sent.some(
      (item) => item.action === "eval" || item.kind === "lease.release",
    ),
    false,
  );
  client.close();
});

test("incompatible handshakes close the temporary transport", async () => {
  const peer = new Peer("s1", false, []);
  await assert.rejects(
    BrowserClient.fromConnectedTransport(peer, {
      clientName: "test",
      authToken: "test",
    }),
    errorCode("protocol_version_mismatch"),
  );
  assert.equal(peer.closed, true);
});

test("lazy clients enforce caller cancellation and can be shut down without connecting", async () => {
  assert.equal(typeof BrowserClient.create, "function");
  let connects = 0;
  const client = BrowserClient.create({
    clientName: "test",
    authToken: "test",
    transportFactory: async () => {
      connects++;
      return new Peer();
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.command(
      { action: "tab_list" },
      { timeoutMs: 1000, idempotency: "read", signal: controller.signal },
    ),
    errorCode("request_cancelled"),
  );
  client.close();
  await assert.rejects(query(client), errorCode("request_cancelled"));
  assert.equal(connects, 0);
});

test("a caller deadline bounds a stalled handshake and closes its transport", async () => {
  assert.equal(typeof BrowserClient.create, "function");
  const peer = new Peer();
  peer.send = (message) => {
    peer.sent.push(message);
  };
  const client = BrowserClient.create({
    clientName: "test",
    authToken: "test",
    transportFactory: async () => peer,
  });
  await assert.rejects(
    client.command(
      { action: "tab_list" },
      { timeoutMs: 25, idempotency: "read" },
    ),
    errorCode("request_deadline_exceeded"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peer.closed, true);
  client.close();
});

test("heartbeat acknowledgement keeps idle transport alive and close stops probes", async () => {
  const peer = new Peer();
  const client = await BrowserClient.fromConnectedTransport(peer, {
    clientName: "test",
    authToken: "test",
    heartbeatIntervalMs: 5,
    heartbeatTimeoutMs: 15,
  });
  const probe = new Promise<void>((resolve) => {
    const original = peer.send.bind(peer);
    peer.send = (message) => {
      original(message);
      if (message.kind === "heartbeat") resolve();
    };
  });
  await Promise.race([
    probe,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("no heartbeat")), 100),
    ),
  ]);
  assert.equal(peer.closed, false);
  client.close();
  const count = peer.sent.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(peer.sent.length, count);
});

test("unanswered heartbeat disconnects without closing the client permanently", async () => {
  const peer = new Peer();
  const client = await BrowserClient.fromConnectedTransport(peer, {
    clientName: "test",
    authToken: "test",
    heartbeatIntervalMs: 5,
    heartbeatTimeoutMs: 10,
  });
  const original = peer.send.bind(peer);
  peer.send = (message) => {
    if (message.kind === "heartbeat") peer.sent.push(message);
    else original(message);
  };
  const closed = once(peer, "close");
  await Promise.race([
    closed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("no heartbeat timeout")), 100),
    ),
  ]);
  client.close();
});

test("waking from a suspended timer starts a fresh heartbeat grace period", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const peer = new Peer();
  const client = await BrowserClient.fromConnectedTransport(peer, {
    clientName: "test",
    authToken: "test",
    heartbeatIntervalMs: 30,
    heartbeatTimeoutMs: 90,
  });
  const send = peer.send.bind(peer);
  peer.send = (message) => {
    if (message.kind === "heartbeat") peer.sent.push(message);
    else send(message);
  };
  now = 30;
  t.mock.timers.tick(30);
  now = 10_000;
  t.mock.timers.tick(30);
  assert.equal(peer.closed, false);
  assert.equal(
    peer.sent.filter((message) => message.kind === "heartbeat").length,
    2,
  );
  for (let n = 0; n < 3; n++) {
    now += 30;
    t.mock.timers.tick(30);
  }
  assert.equal(peer.closed, true);
  client.close();
});
