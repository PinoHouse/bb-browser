import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createProtocolError, type ProtocolError } from "@bb-browser/shared";

export type McpToolResult = CallToolResult;

const toolCancellation = new AsyncLocalStorage<AbortSignal | undefined>();
export const currentToolSignal = () => toolCancellation.getStore();

/** Preserve the SDK cancellation signal independently for concurrent tool calls. */
export function withToolCancellation<
  T extends Record<string, (input: never) => Promise<McpToolResult>>,
>(
  handlers: T,
): {
  [K in keyof T]: (
    input: Parameters<T[K]>[0],
    extra?: { signal?: AbortSignal },
  ) => Promise<McpToolResult>;
} {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      (input: never, extra?: { signal?: AbortSignal }) =>
        toolCancellation.run(extra?.signal, () => {
          if (extra?.signal?.aborted)
            return Promise.resolve(
              protocolErrorResult(
                createProtocolError(
                  "request_cancelled",
                  "dispatch",
                  "MCP 操作已取消",
                  { retryable: false, action: name },
                ),
              ),
            );
          return handler(input);
        }),
    ]),
  ) as {
    [K in keyof T]: (
      input: Parameters<T[K]>[0],
      extra?: { signal?: AbortSignal },
    ) => Promise<McpToolResult>;
  };
}

export function textResult(value: unknown): McpToolResult {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

export function imageResult(dataUrl: string): McpToolResult {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
  return {
    content: [
      {
        type: "image",
        data: match?.[2] ?? dataUrl,
        mimeType: match?.[1] ?? "image/png",
      },
    ],
  };
}

export function protocolErrorResult(error: ProtocolError): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(error, null, 2) }],
    isError: true,
  };
}

export function toolErrorResult(
  error: unknown,
  action: string | null = null,
): McpToolResult {
  if (isProtocolError(error)) {
    return protocolErrorResult(error);
  }
  return protocolErrorResult(
    createProtocolError(
      "browser_command_failed",
      "execute",
      error instanceof Error ? error.message : String(error),
      { retryable: false, action },
    ),
  );
}

export function isProtocolError(error: unknown): error is ProtocolError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "phase" in error &&
    "retryable" in error &&
    "error" in error &&
    "hint" in error &&
    "action" in error
  );
}
