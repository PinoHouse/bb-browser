#!/usr/bin/env node

import assert from "node:assert/strict";

import { BrowserClient } from "../packages/client/dist/index.js";

const clients = [];
const disconnected = new Set();

async function createClient(name) {
  const client = await BrowserClient.connect({ clientName: name });
  clients.push(client);
  return client;
}

async function run(client, input, options, label) {
  const startedAt = Date.now();
  const response = await client.command(input, options);
  const elapsedMs = Date.now() - startedAt;
  process.stdout.write(
    `${JSON.stringify({
      label,
      requestId: response.requestId,
      sessionId: response.sessionId,
      tabId: response.data?.tabId ?? input.tabId ?? null,
      queuedMs: response.timing.queuedMs,
      executionMs: response.timing.executionMs,
      elapsedMs,
    })}\n`,
  );
  if (!response.success) {
    throw new Error(`${label} failed: ${JSON.stringify(response.error)}`);
  }
  return response;
}

async function closeOwned(client) {
  const response = await client.closeOwnedTabs(60_000);
  if (!response.success) {
    throw new Error(
      `closeOwnedTabs failed for ${client.sessionId}: ${JSON.stringify(response.error)}`,
    );
  }
}

const readOptions = { timeoutMs: 60_000, idempotency: "read" };
const writeOptions = { timeoutMs: 60_000, idempotency: "unsafe_write" };

try {
  const [clientA, clientB, clientC] = await Promise.all([
    createClient("bb-browser-concurrency-a"),
    createClient("bb-browser-concurrency-b"),
    createClient("bb-browser-concurrency-c"),
  ]);
  assert.equal(new Set(clients.map((client) => client.sessionId)).size, 3);

  const [openedA, openedB, openedC] = await Promise.all([
    run(
      clientA,
      { action: "open", url: "https://example.com" },
      writeOptions,
      "open-a",
    ),
    run(
      clientB,
      { action: "open", url: "https://x.com/i/radar" },
      writeOptions,
      "open-b",
    ),
    run(
      clientC,
      { action: "open", url: "https://example.org" },
      writeOptions,
      "open-c",
    ),
  ]);
  const tabs = [openedA.data?.tabId, openedB.data?.tabId, openedC.data?.tabId];
  assert.equal(tabs.every((tabId) => typeof tabId === "number"), true);
  assert.equal(new Set(tabs).size, 3);
  const [tabA, tabB, tabC] = tabs;

  await Promise.all([
    run(
      clientA,
      { action: "snapshot", tabId: tabA, interactive: true },
      readOptions,
      "snapshot-a",
    ),
    run(
      clientB,
      { action: "snapshot", tabId: tabB, interactive: true },
      readOptions,
      "snapshot-b",
    ),
    run(
      clientC,
      { action: "snapshot", tabId: tabC, interactive: true },
      readOptions,
      "snapshot-c",
    ),
  ]);

  await run(
    clientA,
    { action: "eval", tabId: tabA, script: "window.__bb_order = []; true" },
    writeOptions,
    "order-init",
  );
  const first = run(
    clientA,
    {
      action: "eval",
      tabId: tabA,
      script:
        "(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); window.__bb_order.push('A'); return window.__bb_order; })()",
    },
    writeOptions,
    "order-a",
  );
  const second = run(
    clientC,
    {
      action: "eval",
      tabId: tabA,
      script: "window.__bb_order.push('C'); window.__bb_order",
    },
    writeOptions,
    "order-c",
  );
  await first;
  const ordered = await second;
  assert.deepEqual(ordered.data?.result, ["A", "C"]);

  await closeOwned(clientB);
  clientB.close();
  disconnected.add(clientB);
  await Promise.all([
    run(clientA, { action: "tab_list" }, readOptions, "post-disconnect-a"),
    run(clientC, { action: "tab_list" }, readOptions, "post-disconnect-c"),
  ]);

  process.stdout.write(
    `${JSON.stringify({
      status: "PASS",
      sessionIds: clients.map((client) => client.sessionId),
      tabIds: tabs,
      sameTabOrder: ordered.data?.result,
    })}\n`,
  );
} finally {
  await Promise.allSettled(
    clients
      .filter((client) => !disconnected.has(client))
      .map((client) => closeOwned(client)),
  );
  for (const client of clients) {
    if (!disconnected.has(client)) {
      client.close();
    }
  }
}
