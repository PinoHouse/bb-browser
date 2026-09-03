import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserClient } from "@bb-browser/client";
import { SiteService } from "@bb-browser/sites";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import {
  registerBrowserTools,
  type BrowserToolClient,
} from "./browser-tools.js";
import { registerSiteTools, type SiteToolService } from "./site-tools.js";

const MCP_VERSION = "0.11.0";

export function createMcpServer(
  client: BrowserToolClient,
  sites: SiteToolService,
): McpServer {
  const server = new McpServer(
    { name: "bb-browser", version: MCP_VERSION },
    {
      instructions: `bb-browser controls the user's real signed-in Chrome through a local Native Host.

Use explicit tab IDs when a workflow may overlap with other tasks. browser_close_all closes only tabs owned by this MCP session. Site adapters run through site_run and use a per-tab workflow lease.`,
    },
  );
  registerBrowserTools(server, client);
  registerSiteTools(server, sites);
  return server;
}

export async function startMcpServer(
  options: {
    stdin?: Readable;
    stdout?: Writable;
    signals?: EventEmitter;
    client?: BrowserClient;
  } = {},
): Promise<{
  shutdown: () => Promise<void>;
  server: McpServer;
  client: BrowserClient;
}> {
  const client =
    options.client ??
    BrowserClient.create({
      clientName: "bb-browser-mcp",
    });
  const sites = new SiteService({ client });
  const server = createMcpServer(client, sites);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const signals = options.signals ?? process;
  let stopped = false;
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (stopped) return closing ?? Promise.resolve();
    stopped = true;
    stdin.off("end", onShutdown);
    stdin.off("close", onShutdown);
    stdin.off("error", onShutdown);
    signals.off("SIGTERM", onShutdown);
    signals.off("SIGINT", onShutdown);
    client.close();
    closing = server.close();
    return closing;
  };
  const onShutdown = () => {
    void shutdown().catch(() => {
      process.stderr.write("[bb-browser] MCP shutdown failed\n");
      process.exitCode = 1;
    });
  };
  stdin.once("end", onShutdown);
  stdin.once("close", onShutdown);
  stdin.once("error", onShutdown);
  signals.once("SIGTERM", onShutdown);
  signals.once("SIGINT", onShutdown);
  server.server.onclose = onShutdown;
  try {
    await server.connect(new StdioServerTransport(stdin, stdout));
    if ("readableEnded" in stdin && stdin.readableEnded) await shutdown();
  } catch (error) {
    await shutdown();
    throw error;
  }
  return { shutdown, server, client };
}
