import test from "node:test";
import assert from "node:assert/strict";
import {
  createProtocolError,
  type CommandResponse,
  type Idempotency,
  type Request,
} from "@bb-browser/shared";
import { createBrowserToolHandlers } from "./browser-tools.js";
import { createSiteToolHandlers } from "./site-tools.js";
import { BrowserClient } from "@bb-browser/client";

class FakeBrowserClient {
  calls: Array<{
    input: Omit<Request, "id">;
    options: { timeoutMs: number; idempotency: Idempotency };
  }> = [];
  closeOwnedTabsCalls = 0;
  errorToThrow?: unknown;

  async command(
    input: Omit<Request, "id">,
    options: { timeoutMs: number; idempotency: Idempotency },
  ): Promise<CommandResponse> {
    this.calls.push({ input, options });
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }
    return {
      kind: "command.response",
      protocolVersion: 2,
      requestId: "request-1",
      sessionId: "session-1",
      success: true,
      data: { tabId: 11 },
      timing: { queuedMs: 0, executionMs: 1 },
    };
  }

  async closeOwnedTabs(): Promise<CommandResponse> {
    this.closeOwnedTabsCalls += 1;
    return {
      kind: "command.response",
      protocolVersion: 2,
      requestId: "close-1",
      sessionId: "session-1",
      success: true,
      data: { result: { closedTabIds: [11] } },
      timing: { queuedMs: 0, executionMs: 1 },
    };
  }
}

class FakeSiteService {
  runCalls: unknown[] = [];

  list(): unknown[] {
    return [];
  }

  search(): unknown[] {
    return [];
  }

  info(): unknown {
    return {};
  }

  recommend(): Promise<unknown> {
    return Promise.resolve({});
  }

  run(input: unknown): Promise<unknown> {
    this.runCalls.push(input);
    return Promise.resolve({ status: "ok" });
  }

  update(): Promise<unknown> {
    return Promise.resolve({ success: true });
  }
}

test("browser handlers map open and close_all to the client SDK", async () => {
  const client = new FakeBrowserClient();
  const handlers = createBrowserToolHandlers(client);
  await handlers.browser_open({ url: "https://example.com" });
  assert.deepEqual(client.calls[0], {
    input: { action: "open", url: "https://example.com", tabId: undefined },
    options: { timeoutMs: 60_000, idempotency: "safe_write" },
  });
  await handlers.browser_close_all({});
  assert.equal(client.closeOwnedTabsCalls, 1);
});

test("site_run delegates directly to SiteService", async () => {
  const service = new FakeSiteService();
  const handlers = createSiteToolHandlers(service);
  await handlers.site_run({
    name: "twitter/radar",
    namedArgs: { query: "NVDA" },
  });
  assert.deepEqual(service.runCalls, [
    {
      name: "twitter/radar",
      args: undefined,
      namedArgs: { query: "NVDA" },
      tabId: undefined,
      timeoutMs: undefined,
    },
  ]);
});

test("protocol errors keep every structured field", async () => {
  const client = new FakeBrowserClient();
  client.errorToThrow = createProtocolError(
    "extension_disconnected",
    "dispatch",
    "Chrome 扩展未连接",
    { action: "snapshot" },
  );
  const result = await createBrowserToolHandlers(client).browser_snapshot({});
  assert.equal(result.isError, true);
  const parsed = JSON.parse(
    result.content[0].type === "text" ? result.content[0].text : "{}",
  );
  assert.deepEqual(Object.keys(parsed).sort(), [
    "action",
    "code",
    "error",
    "hint",
    "phase",
    "retryable",
  ]);
});

test("MCP cancellation prevents a browser command from reconnecting or dispatching", async () => {
  let connects = 0;
  const client = BrowserClient.create({
    clientName: "test",
    authToken: "test",
    transportFactory: async () => {
      connects++;
      throw createProtocolError("authentication_failed", "connect", "test");
    },
  });
  const controller = new AbortController();
  controller.abort();
  const result = await createBrowserToolHandlers(client).browser_click(
    { tab: 1, ref: "e1" },
    { signal: controller.signal },
  );
  assert.equal(result.isError, true);
  assert.equal(
    JSON.parse((result.content[0] as { text: string }).text).code,
    "request_cancelled",
  );
  assert.equal(connects, 0);
  client.close();
});

test("MCP cancellation prevents a site adapter from starting", async () => {
  const service = new FakeSiteService();
  const controller = new AbortController();
  controller.abort();
  const result = await createSiteToolHandlers(service).site_run(
    { name: "twitter/radar" },
    { signal: controller.signal },
  );
  assert.equal(result.isError, true);
  assert.equal(service.runCalls.length, 0);
});
