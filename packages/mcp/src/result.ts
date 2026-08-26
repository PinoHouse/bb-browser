import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createProtocolError,
  type ProtocolError,
} from "@bb-browser/shared";

export type McpToolResult = CallToolResult;

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
