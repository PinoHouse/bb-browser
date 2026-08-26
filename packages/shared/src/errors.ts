export type ErrorCode =
  | "broker_unavailable"
  | "extension_disconnected"
  | "protocol_version_mismatch"
  | "session_expired"
  | "tab_not_found"
  | "tab_not_owned"
  | "tab_lease_timeout"
  | "request_deadline_exceeded"
  | "request_cancelled"
  | "browser_command_failed"
  | "adapter_execution_failed"
  | "result_unknown_after_disconnect";

export type ErrorPhase =
  | "connect"
  | "handshake"
  | "queue"
  | "dispatch"
  | "execute"
  | "adapter"
  | "cleanup";

export interface ProtocolError {
  code: ErrorCode;
  phase: ErrorPhase;
  retryable: boolean;
  error: string;
  hint: string;
  action: string | null;
}

const RETRYABLE_CODES = new Set<ErrorCode>([
  "broker_unavailable",
  "extension_disconnected",
  "tab_lease_timeout",
  "request_deadline_exceeded",
]);

export function createProtocolError(
  code: ErrorCode,
  phase: ErrorPhase,
  error: string,
  options: { retryable?: boolean; action?: string | null } = {},
): ProtocolError {
  return {
    code,
    phase,
    retryable: options.retryable ?? RETRYABLE_CODES.has(code),
    error,
    hint:
      code === "extension_disconnected"
        ? "请确认 Chrome 已运行且 bb-browser 扩展已启用"
        : "请查看 bb-browser 健康状态后重试",
    action: options.action ?? null,
  };
}
