import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SiteMeta } from "@bb-browser/sites";
import { z } from "zod";
import {
  textResult,
  toolErrorResult,
  type McpToolResult,
  withToolCancellation,
  currentToolSignal,
} from "./tool-result.js";

export interface SiteToolService {
  list(): unknown[];
  search(query: string): unknown[];
  info(name: string): unknown;
  recommend(days?: number, signal?: AbortSignal): Promise<unknown>;
  run(input: {
    name: string;
    args?: string[];
    namedArgs?: Record<string, string>;
    tabId?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<unknown>;
  update(): Promise<unknown>;
}

export function createSiteToolHandlers(service: SiteToolService) {
  return withToolCancellation({
    site_list: (_input: Record<string, never>) =>
      capture("site_list", async () =>
        textResult(service.list().map(publicSiteMeta)),
      ),

    site_search: (input: { query: string }) =>
      capture("site_search", async () =>
        textResult(service.search(input.query).map(publicSiteMeta)),
      ),

    site_info: (input: { name: string }) =>
      capture("site_info", async () =>
        textResult(publicSiteMeta(service.info(input.name))),
      ),

    site_recommend: (input: { days?: number }) =>
      capture("site_recommend", async () =>
        textResult(await service.recommend(input.days, currentToolSignal())),
      ),

    site_run: (input: {
      name: string;
      args?: string[];
      namedArgs?: Record<string, string>;
      tab?: number;
      timeoutMs?: number;
    }) =>
      capture("site_run", async () =>
        textResult(
          await service.run({
            name: input.name,
            args: input.args,
            namedArgs: input.namedArgs,
            tabId: input.tab,
            timeoutMs: input.timeoutMs,
            ...(currentToolSignal() ? { signal: currentToolSignal() } : {}),
          }),
        ),
      ),

    site_update: (_input: Record<string, never>) =>
      capture("site_update", async () => textResult(await service.update())),
  });
}

export function registerSiteTools(
  server: McpServer,
  service: SiteToolService,
): void {
  const handlers = createSiteToolHandlers(service);
  server.tool(
    "site_list",
    "List installed site adapters",
    {},
    handlers.site_list,
  );
  server.tool(
    "site_search",
    "Search installed site adapters by name, description, or domain",
    { query: z.string().describe("Search query") },
    handlers.site_search,
  );
  server.tool(
    "site_info",
    "Get adapter metadata including args, example, and domain",
    { name: z.string().describe("Adapter name, e.g. twitter/search") },
    handlers.site_info,
  );
  server.tool(
    "site_recommend",
    "Recommend adapters based on recent browsing history",
    {
      days: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("How many recent days of history to inspect"),
    },
    handlers.site_recommend,
  );
  server.tool(
    "site_run",
    "Run a site adapter and return its structured data",
    {
      name: z.string().describe("Adapter name, e.g. twitter/search"),
      args: z
        .array(z.string())
        .optional()
        .describe("Positional arguments in adapter-defined order"),
      namedArgs: z
        .record(z.string())
        .optional()
        .describe("Named adapter arguments"),
      tab: z.number().optional().describe("Optional tab ID to target"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional lower operation deadline"),
    },
    handlers.site_run,
  );
  server.tool(
    "site_update",
    "Pull or clone the community adapter repository",
    {},
    handlers.site_update,
  );
}

function publicSiteMeta(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("filePath" in value)) {
    return value;
  }
  const { filePath: _filePath, ...meta } = value as SiteMeta;
  return meta;
}

async function capture(
  action: string,
  work: () => Promise<McpToolResult>,
): Promise<McpToolResult> {
  try {
    return await work();
  } catch (error) {
    return toolErrorResult(error, action);
  }
}
