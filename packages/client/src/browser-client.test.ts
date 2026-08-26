import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserClient } from "./browser-client.js";

class FakeTransport extends EventEmitter {
  sent: unknown[] = [];

  send(message: unknown): void {
    this.sent.push(message);
  }

  close(): void {
    this.emit("close");
  }
}

async function connectClient(transport: FakeTransport): Promise<BrowserClient> {
  const clientPromise = BrowserClient.fromConnectedTransport(transport, {
    clientName: "test",
    authToken: "secret",
  });
  transport.emit("message", {
    kind: "session.ready",
    protocolVersion: 2,
    clientId: "client-1",
    sessionId: "session-1",
    resumed: false,
  });
  return clientPromise;
}

test("command uses session identity and resolves matching response", async () => {
  const transport = new FakeTransport();
  const clientPromise = BrowserClient.fromConnectedTransport(transport, {
    clientName: "test",
    authToken: "secret",
  });
  const hello = transport.sent[0] as { kind: string };
  assert.equal(hello.kind, "client.hello");
  transport.emit("message", {
    kind: "session.ready",
    protocolVersion: 2,
    clientId: "client-1",
    sessionId: "session-1",
    resumed: false,
  });
  const client = await clientPromise;
  const resultPromise = client.command(
    { action: "tab_list" },
    { timeoutMs: 1_000, idempotency: "read" },
  );
  const request = transport.sent[1] as {
    requestId: string;
    sessionId: string;
  };
  assert.equal(request.sessionId, "session-1");
  transport.emit("message", {
    kind: "command.response",
    protocolVersion: 2,
    requestId: request.requestId,
    sessionId: "session-1",
    success: true,
    data: { tabs: [] },
    timing: { queuedMs: 0, executionMs: 1 },
  });
  assert.deepEqual((await resultPromise).data, { tabs: [] });
});

test("aborting a command sends exactly one cancellation", async () => {
  const transport = new FakeTransport();
  const client = await connectClient(transport);
  const controller = new AbortController();
  const resultPromise = client.command(
    { action: "snapshot", tabId: 11 },
    { timeoutMs: 1_000, idempotency: "read", signal: controller.signal },
  );
  controller.abort();
  controller.abort();
  await assert.rejects(
    resultPromise,
    (error: { code?: string }) => error.code === "request_cancelled",
  );
  assert.equal(
    transport.sent.filter(
      (message) => (message as { kind?: string }).kind === "request.cancel",
    ).length,
    1,
  );
});

test("withTabLease releases the lease after work completes", async () => {
  const transport = new FakeTransport();
  const client = await connectClient(transport);
  const resultPromise = client.withTabLease(9, 1_000, async (leaseId) => {
    assert.equal(leaseId, "lease-1");
    return "done";
  });
  const acquire = transport.sent.at(-1) as { requestId: string };
  transport.emit("message", {
    kind: "lease.granted",
    protocolVersion: 2,
    requestId: acquire.requestId,
    sessionId: "session-1",
    tabId: 9,
    leaseId: "lease-1",
  });
  assert.equal(await resultPromise, "done");
  assert.equal(
    (transport.sent.at(-1) as { kind: string }).kind,
    "lease.release",
  );
});

test("transport disconnect makes a dispatched result unknown", async () => {
  const transport = new FakeTransport();
  const client = await connectClient(transport);
  const resultPromise = client.command(
    { action: "click", ref: "e1" },
    { timeoutMs: 1_000, idempotency: "unsafe_write" },
  );
  transport.close();
  await assert.rejects(
    resultPromise,
    (error: { code?: string; retryable?: boolean }) =>
      error.code === "result_unknown_after_disconnect" &&
      error.retryable === false,
  );
});
