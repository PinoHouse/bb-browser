import type { ActionType, Request, ResponseData } from "./protocol.js";
import type { ProtocolError } from "./errors.js";

export const PROTOCOL_VERSION = 2 as const;
export const SESSION_RECOVERY_CAPABILITY = "session-recovery-v1";

export type Idempotency = "read" | "safe_write" | "unsafe_write";

export function isRetryableBeforeDispatch(idempotency: Idempotency): boolean {
  return idempotency !== "unsafe_write";
}

export interface ClientHello {
  kind: "client.hello";
  protocolVersion: typeof PROTOCOL_VERSION;
  clientName: string;
  authToken: string;
  resumeSessionId?: string;
  resumeClientId?: string;
  capabilities?: string[];
}

export interface SessionReady {
  kind: "session.ready";
  protocolVersion: typeof PROTOCOL_VERSION;
  clientId: string;
  sessionId: string;
  resumed: boolean;
  capabilities?: string[];
  brokerInstanceId?: string;
}

export interface ConnectionError {
  kind: "connection.error";
  protocolVersion: typeof PROTOCOL_VERSION;
  error: ProtocolError;
}

export interface SessionEnd {
  kind: "session.end";
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
}

export interface BrokerHealth {
  running: boolean;
  extensionConnected: boolean;
  activeSessions: number;
  detachedSessions: number;
  connections: number;
  pendingRequests: number;
  queuedRequests: number;
  activeLeases: number;
  protocolVersion: typeof PROTOCOL_VERSION;
  brokerInstanceId: string;
}

export interface SessionHealth {
  kind: "session.health";
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  requestId: string;
}

export interface SessionHealthResult {
  kind: "session.health.result";
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  requestId: string;
  health: BrokerHealth;
}

export interface CommandRequest {
  kind: "command.request";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  clientId: string;
  sessionId: string;
  action: ActionType;
  tabId?: number | string;
  leaseId?: string;
  deadlineAt: number;
  idempotency: Idempotency;
  payload: Omit<Request, "id" | "action" | "tabId">;
}

export interface CommandResponse {
  kind: "command.response";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  success: boolean;
  data?: ResponseData;
  error?: ProtocolError;
  timing: {
    queuedMs: number;
    executionMs: number;
  };
}

export interface LeaseAcquire {
  kind: "lease.acquire";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  tabId: number;
  deadlineAt: number;
}

export interface LeaseGranted {
  kind: "lease.granted";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  tabId: number;
  leaseId: string;
}

export interface LeaseRelease {
  kind: "lease.release";
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  leaseId: string;
}

export interface RequestCancel {
  kind: "request.cancel";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
}

export interface SessionCloseOwnedTabs {
  kind: "session.close_owned_tabs";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  deadlineAt: number;
}

export interface ExtensionHello {
  kind: "extension.hello";
  protocolVersion: typeof PROTOCOL_VERSION;
  extensionVersion: string;
  capabilities: string[];
}

export interface Heartbeat {
  kind: "heartbeat";
  protocolVersion?: typeof PROTOCOL_VERSION;
  sentAt: number;
}

export type ClientToBrokerMessage =
  | ClientHello
  | CommandRequest
  | LeaseAcquire
  | LeaseRelease
  | RequestCancel
  | SessionCloseOwnedTabs
  | SessionEnd
  | SessionHealth
  | Heartbeat;

export type BrokerToClientMessage =
  | SessionReady
  | CommandResponse
  | LeaseGranted
  | ConnectionError
  | SessionHealthResult
  | Heartbeat;

export type ExtensionToBrokerMessage =
  | ExtensionHello
  | CommandResponse
  | Heartbeat;

export type BrokerToExtensionMessage =
  | CommandRequest
  | RequestCancel
  | Heartbeat;
