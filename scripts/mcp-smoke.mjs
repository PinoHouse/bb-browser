#!/usr/bin/env node

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = resolve(repositoryRoot, "bin", "bb-browser-mcp");

function requireSuccess(name, result) {
  if (result.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  }
  return result;
}

function parseText(result) {
  const block = result.content.find((item) => item.type === "text");
  if (!block || typeof block.text !== "string") {
    throw new Error("MCP response did not contain a text result");
  }
  try {
    return JSON.parse(block.text);
  } catch {
    return block.text;
  }
}

const transport = new StdioClientTransport({
  command: launcher,
  args: [],
  cwd: repositoryRoot,
  stderr: "pipe",
});
const client = new Client({ name: "bb-browser-smoke", version: "1.0.0" });
let openedTabId;
let connected = false;

try {
  await client.connect(transport);
  connected = true;

  const before = parseText(
    requireSuccess(
      "browser_tab_list",
      await client.callTool({ name: "browser_tab_list", arguments: {} }),
    ),
  );
  assert.equal(Array.isArray(before), true);

  const opened = parseText(
    requireSuccess(
      "browser_open",
      await client.callTool({
        name: "browser_open",
        arguments: { url: "https://example.com" },
      }),
    ),
  );
  assert.equal(typeof opened?.tabId, "number");
  openedTabId = opened.tabId;

  requireSuccess(
    "browser_snapshot",
    await client.callTool({
      name: "browser_snapshot",
      arguments: { tab: openedTabId, interactive: true },
    }),
  );

  requireSuccess(
    "browser_close_all",
    await client.callTool({ name: "browser_close_all", arguments: {} }),
  );
  const after = parseText(
    requireSuccess(
      "browser_tab_list",
      await client.callTool({ name: "browser_tab_list", arguments: {} }),
    ),
  );
  assert.equal(
    after.some((tab) => tab.tabId === openedTabId),
    false,
    "browser_close_all must close the smoke session tab",
  );

  process.stdout.write(
    `${JSON.stringify({
      status: "PASS",
      extensionConnected: true,
      openedTabId,
      preExistingTabCount: before.length,
    })}\n`,
  );
} finally {
  if (openedTabId !== undefined) {
    try {
      await client.callTool({ name: "browser_close_all", arguments: {} });
    } catch {
      // Best-effort cleanup after an earlier smoke failure.
    }
  }
  if (connected) {
    await client.close();
  } else {
    await transport.close();
  }
}
