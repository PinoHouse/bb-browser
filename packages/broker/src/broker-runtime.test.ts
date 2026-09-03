import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BrowserClient } from "@bb-browser/client";
import {
  encodeFrame,
  FrameDecoder,
  type CommandRequest,
  type ResponseData,
} from "@bb-browser/shared";
import { BrokerRuntime } from "./broker-runtime.js";

class FakeExtension {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  private readonly decoder = new FrameDecoder();
  private readonly dispatched: CommandRequest[] = [];
  private readonly resolved = new Set<string>();
  private readonly waiters: Array<() => void> = [];

  constructor() {
    this.output.on("data", (chunk) => {
      for (const value of this.decoder.push(chunk)) {
        const message = value as { kind?: string };
        if (message.kind === "command.request") {
          this.dispatched.push(value as CommandRequest);
          for (const waiter of this.waiters.splice(0)) {
            waiter();
          }
        }
      }
    });
  }

  connect(): void {
    this.input.write(
      encodeFrame({
        kind: "extension.hello",
        protocolVersion: 2,
        extensionVersion: "0.11.0",
        capabilities: [],
      }),
    );
  }

  async waitForDispatchCount(count: number): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (this.dispatched.length < count) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Expected ${count} dispatched commands`)),
          Math.max(1, deadline - Date.now()),
        );
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  dispatchedTabIds(): Array<number | string | undefined> {
    return this.dispatched.map((request) => request.tabId);
  }

  resolveNextForTab(
    tabId: number | string | undefined,
    data: ResponseData,
  ): void {
    const request = this.dispatched.find(
      (candidate) =>
        candidate.tabId === tabId && !this.resolved.has(candidate.requestId),
    );
    if (!request) {
      throw new Error(`No unresolved request for tab ${String(tabId)}`);
    }
    this.resolved.add(request.requestId);
    this.input.write(
      encodeFrame({
        kind: "command.response",
        protocolVersion: 2,
        requestId: request.requestId,
        sessionId: request.sessionId,
        success: true,
        data,
        timing: { queuedMs: 0, executionMs: 1 },
      }),
    );
  }
}

async function createBrokerFixture(options: { connectExtension?: boolean } = {}) {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "bb-broker-test-"));
  const socketPath = join(runtimeRoot, "broker.sock");
  const extension = new FakeExtension();
  const runtime = new BrokerRuntime({
    runtimeRoot,
    socketPath,
    authToken: "secret",
    extensionInput: extension.input,
    extensionOutput: extension.output,
  });
  await runtime.start();
  if (options.connectExtension !== false) {
    extension.connect();
  }
  const clients: BrowserClient[] = [];
  return {
    extension,
    runtime,
    async connectClient(name: string) {
      const client = await BrowserClient.connect({
        clientName: name,
        authToken: "secret",
        socketPath,
      });
      clients.push(client);
      return client;
    },
    async close() {
      for (const client of clients) {
        client.close();
      }
      await runtime.stop();
      await rm(runtimeRoot, { recursive: true, force: true });
    },
  };
}

test("three clients share one extension with per-tab ordering", async (t) => {
  const fixture = await createBrokerFixture();
  t.after(async () => fixture.close());
  const [clientA, clientB, clientC] = await Promise.all([
    fixture.connectClient("a"),
    fixture.connectClient("b"),
    fixture.connectClient("c"),
  ]);
  const first = clientA.command(
    { action: "snapshot", tabId: 11 },
    { timeoutMs: 1_000, idempotency: "read" },
  );
  const parallel = clientB.command(
    { action: "snapshot", tabId: 12 },
    { timeoutMs: 1_000, idempotency: "read" },
  );
  const second = clientC.command(
    { action: "get", attribute: "title", tabId: 11 },
    { timeoutMs: 1_000, idempotency: "read" },
  );

  await fixture.extension.waitForDispatchCount(2);
  assert.deepEqual(fixture.extension.dispatchedTabIds(), [11, 12]);
  fixture.extension.resolveNextForTab(12, { tabs: [] });
  await parallel;
  fixture.extension.resolveNextForTab(11, {
    snapshotData: { snapshot: "", refs: {} },
  });
  await first;
  await fixture.extension.waitForDispatchCount(3);
  assert.deepEqual(fixture.extension.dispatchedTabIds(), [11, 12, 11]);
  fixture.extension.resolveNextForTab(11, { value: "done" });
  assert.equal((await second).data?.value, "done");

  clientB.close();
  const listPromise = clientA.command(
    { action: "tab_list" },
    { timeoutMs: 1_000, idempotency: "read" },
  );
  await fixture.extension.waitForDispatchCount(4);
  fixture.extension.resolveNextForTab(undefined, { tabs: [] });
  assert.deepEqual((await listPromise).data?.tabs, []);
});

test("a missing extension returns a typed dispatch error", async (t) => {
  const fixture = await createBrokerFixture({ connectExtension: false });
  t.after(async () => fixture.close());
  const client = await fixture.connectClient("a");
  await assert.rejects(
    client.command(
      { action: "tab_list" },
      { timeoutMs: 1_000, idempotency: "read" },
    ),
    (error: { code?: string; phase?: string; retryable?: boolean }) =>
      error.code === "extension_disconnected" &&
      error.phase === "dispatch" &&
      error.retryable === true,
  );
});

test("navigating an existing tab never transfers its ownership to the session", async (t) => {
  const fixture = await createBrokerFixture();
  t.after(async () => fixture.close());
  const client = await fixture.connectClient("a");

  const navigate = client.command(
    { action: "open", url: "https://example.com", tabId: 42 },
    { timeoutMs: 1_000, idempotency: "unsafe_write" },
  );
  await fixture.extension.waitForDispatchCount(1);
  fixture.extension.resolveNextForTab(42, { tabId: 42, url: "https://example.com" });
  await navigate;

  const created = client.command(
    { action: "open", url: "https://example.org" },
    { timeoutMs: 1_000, idempotency: "safe_write" },
  );
  await fixture.extension.waitForDispatchCount(2);
  fixture.extension.resolveNextForTab(undefined, { tabId: 77, url: "https://example.org" });
  await created;

  const cleanup = client.closeOwnedTabs(1_000);
  await fixture.extension.waitForDispatchCount(3);
  assert.deepEqual(fixture.extension.dispatchedTabIds(), [42, undefined, 77]);
  fixture.extension.resolveNextForTab(77, { tabId: 77 });
  const result = (await cleanup).data?.result as { closedTabIds: number[] };
  assert.deepEqual(result.closedTabIds, [77]);
});
