import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserClient } from "@bb-browser/client";
import { SiteService } from "@bb-browser/sites";
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

export async function startMcpServer(): Promise<void> {
  const client = await BrowserClient.connect({
    clientName: "bb-browser-mcp",
  });
  const sites = new SiteService({ client });
  const server = createMcpServer(client, sites);
  await server.connect(new StdioServerTransport());
}
