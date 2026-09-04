import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CommandInput, CommandOptions } from "@bb-browser/client";
import { createProtocolError, type CommandResponse } from "@bb-browser/shared";
import { z } from "zod";
import {
  imageResult,
  textResult,
  toolErrorResult,
  type McpToolResult,
  currentToolSignal,
  withToolCancellation,
} from "./tool-result.js";

export interface BrowserToolClient {
  health?(timeoutMs?: number, signal?: AbortSignal): Promise<unknown>;
  command(
    input: CommandInput,
    options: CommandOptions,
  ): Promise<CommandResponse>;
  closeOwnedTabs(
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<CommandResponse>;
}

export function createBrowserToolHandlers(client: BrowserToolClient) {
  const command = async (
    input: CommandInput,
    options: CommandOptions,
  ): Promise<CommandResponse> => {
    const signal = currentToolSignal();
    const response = await client.command(
      input,
      signal ? { ...options, signal } : options,
    );
    if (!response.success) {
      throw (
        response.error ??
        createProtocolError(
          "browser_command_failed",
          "execute",
          `浏览器操作失败：${input.action}`,
          { retryable: false, action: input.action },
        )
      );
    }
    return response;
  };

  return withToolCancellation({
    browser_health: (_input: Record<string, never>) =>
      capture("health", async () => {
        if (!client.health)
          throw createProtocolError(
            "protocol_version_mismatch",
            "connect",
            "Client 不支持健康状态诊断",
            { retryable: false },
          );
        return textResult(await client.health(10_000, currentToolSignal()));
      }),
    browser_snapshot: (input: { tab?: number; interactive?: boolean }) =>
      capture("snapshot", async () => {
        const response = await command(
          {
            action: "snapshot",
            interactive: input.interactive,
            tabId: input.tab,
          },
          { timeoutMs: 60_000, idempotency: "read" },
        );
        return textResult(response.data?.snapshotData?.snapshot ?? "(empty)");
      }),

    browser_click: (input: { ref: string; tab?: number }) =>
      capture("click", async () => {
        const response = await command(
          { action: "click", ref: input.ref, tabId: input.tab },
          { timeoutMs: 60_000, idempotency: "unsafe_write" },
        );
        return textResult(response.data ?? "Clicked");
      }),

    browser_fill: (input: { ref: string; text: string; tab?: number }) =>
      capture("fill", async () => {
        const response = await command(
          {
            action: "fill",
            ref: input.ref,
            text: input.text,
            tabId: input.tab,
          },
          { timeoutMs: 60_000, idempotency: "unsafe_write" },
        );
        return textResult(response.data ?? "Filled");
      }),

    browser_type: (input: { ref: string; text: string; tab?: number }) =>
      capture("type", async () => {
        const response = await command(
          {
            action: "type",
            ref: input.ref,
            text: input.text,
            tabId: input.tab,
          },
          { timeoutMs: 60_000, idempotency: "unsafe_write" },
        );
        return textResult(response.data ?? "Typed");
      }),

    browser_open: (input: { url: string; tab?: number }) =>
      capture("open", async () => {
        const response = await command(
          { action: "open", url: input.url, tabId: input.tab },
          {
            timeoutMs: 60_000,
            idempotency:
              input.tab === undefined ? "safe_write" : "unsafe_write",
          },
        );
        return textResult(response.data ?? `Opened ${input.url}`);
      }),

    browser_tab_list: (_input: Record<string, never>) =>
      capture("tab_list", async () => {
        const response = await command(
          { action: "tab_list" },
          { timeoutMs: 60_000, idempotency: "read" },
        );
        return textResult(response.data?.tabs ?? []);
      }),

    browser_tab_new: (input: { url?: string }) =>
      capture("tab_new", async () => {
        const response = await command(
          { action: "tab_new", url: input.url },
          { timeoutMs: 60_000, idempotency: "safe_write" },
        );
        return textResult(response.data ?? "Opened new tab");
      }),

    browser_press: (input: { key: string; tab?: number }) =>
      capture("press", async () => {
        const parts = input.key.split("+");
        const modifierNames = new Set(["Control", "Alt", "Shift", "Meta"]);
        const modifiers = parts.filter((part) => modifierNames.has(part));
        const key = parts.find((part) => !modifierNames.has(part));
        if (!key) {
          throw createProtocolError(
            "browser_command_failed",
            "execute",
            "Invalid key format",
            { retryable: false, action: "press" },
          );
        }
        const response = await command(
          { action: "press", key, modifiers, tabId: input.tab },
          { timeoutMs: 60_000, idempotency: "unsafe_write" },
        );
        return textResult(response.data ?? `Pressed ${input.key}`);
      }),

    browser_scroll: (input: {
      direction: "up" | "down" | "left" | "right";
      pixels?: number;
      tab?: number;
    }) =>
      capture("scroll", async () => {
        const pixels = input.pixels ?? 500;
        const response = await command(
          {
            action: "scroll",
            direction: input.direction,
            pixels,
            tabId: input.tab,
          },
          { timeoutMs: 60_000, idempotency: "safe_write" },
        );
        return textResult(
          response.data ?? `Scrolled ${input.direction} ${pixels}px`,
        );
      }),

    browser_eval: (input: { script: string; tab?: number }) =>
      capture("eval", async () => {
        const response = await command(
          { action: "eval", script: input.script, tabId: input.tab },
          { timeoutMs: 60_000, idempotency: "unsafe_write" },
        );
        return textResult(response.data?.result ?? null);
      }),

    browser_network: (input: {
      command: "requests" | "clear";
      filter?: string;
      withBody?: boolean;
      tab?: number;
    }) =>
      capture("network", async () => {
        const response = await command(
          {
            action: "network",
            networkCommand: input.command,
            filter: input.filter,
            withBody: input.withBody,
            tabId: input.tab,
          },
          {
            timeoutMs: 60_000,
            idempotency: input.command === "requests" ? "read" : "safe_write",
          },
        );
        return textResult(
          input.command === "requests"
            ? (response.data?.networkRequests ?? [])
            : (response.data ?? "Cleared"),
        );
      }),

    browser_screenshot: (input: { tab?: number }) =>
      capture("screenshot", async () => {
        const response = await command(
          { action: "screenshot", tabId: input.tab },
          { timeoutMs: 60_000, idempotency: "read" },
        );
        if (!response.data?.dataUrl) {
          throw createProtocolError(
            "browser_command_failed",
            "execute",
            "Screenshot data missing",
            { retryable: false, action: "screenshot" },
          );
        }
        return imageResult(response.data.dataUrl);
      }),

    browser_get: (input: {
      attribute: "text" | "url" | "title" | "value" | "html";
      ref?: string;
      tab?: number;
    }) =>
      capture("get", async () => {
        const response = await command(
          {
            action: "get",
            attribute: input.attribute,
            ref: input.ref,
            tabId: input.tab,
          },
          { timeoutMs: 60_000, idempotency: "read" },
        );
        return textResult(response.data?.value ?? "");
      }),

    browser_close: (input: { tab?: number }) =>
      capture("close", async () => {
        const response = await command(
          {
            action: input.tab === undefined ? "close" : "tab_close",
            tabId: input.tab,
          },
          { timeoutMs: 60_000, idempotency: "unsafe_write" },
        );
        return textResult(response.data ?? "Closed tab");
      }),

    browser_close_all: (_input: Record<string, never>) =>
      capture("close_all", async () => {
        const response = await client.closeOwnedTabs(
          60_000,
          currentToolSignal(),
        );
        if (!response.success) {
          throw (
            response.error ??
            createProtocolError(
              "browser_command_failed",
              "cleanup",
              "关闭会话标签页失败",
              { retryable: false, action: "close_all" },
            )
          );
        }
        return textResult(response.data?.result ?? response.data ?? {});
      }),

    browser_frame: (input: { selector: string; tab?: number }) =>
      capture("frame", async () => {
        const response = await command(
          { action: "frame", selector: input.selector, tabId: input.tab },
          { timeoutMs: 60_000, idempotency: "safe_write" },
        );
        return textResult(response.data?.frameInfo ?? "Switched frame");
      }),

    browser_frame_main: (input: { tab?: number }) =>
      capture("frame_main", async () => {
        const response = await command(
          { action: "frame_main", tabId: input.tab },
          { timeoutMs: 60_000, idempotency: "safe_write" },
        );
        return textResult(response.data?.frameInfo ?? "Switched to main frame");
      }),

    browser_hover: (input: { ref: string; tab?: number }) =>
      capture("hover", async () => {
        const response = await command(
          { action: "hover", ref: input.ref, tabId: input.tab },
          { timeoutMs: 60_000, idempotency: "safe_write" },
        );
        return textResult(response.data ?? "Hovered");
      }),

    browser_wait: (input: { time: number; tab?: number }) =>
      capture("wait", async () => {
        const response = await command(
          {
            action: "wait",
            waitType: "time",
            ms: input.time,
            tabId: input.tab,
          },
          {
            timeoutMs: Math.max(60_000, input.time + 5_000),
            idempotency: "safe_write",
          },
        );
        return textResult(response.data ?? `Waited ${input.time}ms`);
      }),
  });
}

export function registerBrowserTools(
  server: McpServer,
  client: BrowserToolClient,
): void {
  const handlers = createBrowserToolHandlers(client);
  server.tool(
    "browser_health",
    "Read Client/Broker/extension health without opening tabs or running browser commands",
    {},
    handlers.browser_health,
  );
  server.tool(
    "browser_snapshot",
    "Get accessibility tree snapshot of the current page",
    {
      tab: z
        .number()
        .optional()
        .describe("Tab ID to target (omit for active tab)"),
      interactive: z
        .boolean()
        .optional()
        .describe("Only show interactive elements"),
    },
    handlers.browser_snapshot,
  );
  server.tool(
    "browser_click",
    "Click an element by ref",
    {
      ref: z.string().describe("Element ref from snapshot"),
      tab: z.number().optional().describe("Tab ID to target"),
    },
    handlers.browser_click,
  );
  server.tool(
    "browser_fill",
    "Fill text into an input",
    {
      ref: z.string().describe("Element ref from snapshot"),
      text: z.string().describe("Text to fill"),
      tab: z.number().optional().describe("Tab ID to target"),
    },
    handlers.browser_fill,
  );
  server.tool(
    "browser_type",
    "Type text into an input without clearing",
    {
      ref: z.string().describe("Element ref from snapshot"),
      text: z.string().describe("Text to type"),
      tab: z.number().optional().describe("Tab ID to target"),
    },
    handlers.browser_type,
  );
  server.tool(
    "browser_open",
    "Navigate to a URL",
    {
      url: z.string().describe("URL to open"),
      tab: z.number().optional().describe("Tab ID to target"),
    },
    handlers.browser_open,
  );
  server.tool(
    "browser_tab_list",
    "List all tabs",
    {},
    handlers.browser_tab_list,
  );
  server.tool(
    "browser_tab_new",
    "Open a new tab",
    {
      url: z.string().optional().describe("Optional URL to open"),
    },
    handlers.browser_tab_new,
  );
  server.tool(
    "browser_press",
    "Press a keyboard key",
    {
      key: z.string().describe("Key name to press, e.g. Enter or Control+a"),
      tab: z.number().optional().describe("Tab ID to target"),
    },
    handlers.browser_press,
  );
  server.tool(
    "browser_scroll",
    "Scroll the page",
    {
      direction: z.enum(["up", "down", "left", "right"]),
      pixels: z.number().optional().default(500),
      tab: z.number().optional(),
    },
    handlers.browser_scroll,
  );
  server.tool(
    "browser_eval",
    "Execute JavaScript in page context",
    {
      script: z.string().describe("JavaScript source to execute"),
      tab: z.number().optional().describe("Tab ID to target"),
    },
    handlers.browser_eval,
  );
  server.tool(
    "browser_network",
    "Inspect or clear network activity",
    {
      command: z.enum(["requests", "clear"]),
      filter: z.string().optional(),
      withBody: z.boolean().optional(),
      tab: z.number().optional(),
    },
    handlers.browser_network,
  );
  server.tool(
    "browser_screenshot",
    "Take a screenshot",
    {
      tab: z.number().optional(),
    },
    handlers.browser_screenshot,
  );
  server.tool(
    "browser_get",
    "Get element text or attribute",
    {
      attribute: z.enum(["text", "url", "title", "value", "html"]),
      ref: z.string().optional(),
      tab: z.number().optional(),
    },
    handlers.browser_get,
  );
  server.tool(
    "browser_close",
    "Close the current or specified tab",
    {
      tab: z.number().optional(),
    },
    handlers.browser_close,
  );
  server.tool(
    "browser_close_all",
    "Close tabs opened by the current bb-browser session",
    {},
    handlers.browser_close_all,
  );
  server.tool(
    "browser_frame",
    "Enter an iframe by CSS selector so snapshots and ref actions target that frame. Refresh the snapshot afterward; refs from a previous frame do not carry over.",
    {
      selector: z.string().describe("CSS selector of the iframe element to enter"),
      tab: z.number().optional().describe("Tab ID to target"),
    },
    handlers.browser_frame,
  );
  server.tool(
    "browser_frame_main",
    "Return snapshots and ref actions to the top-level document",
    {
      tab: z.number().optional().describe("Tab ID to target"),
    },
    handlers.browser_frame_main,
  );
  server.tool(
    "browser_hover",
    "Hover over an element",
    {
      ref: z.string(),
      tab: z.number().optional(),
    },
    handlers.browser_hover,
  );
  server.tool(
    "browser_wait",
    "Wait for a number of milliseconds",
    {
      time: z.number(),
      tab: z.number().optional(),
    },
    handlers.browser_wait,
  );
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
