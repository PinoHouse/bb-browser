/**
 * @bb-browser/shared
 * 共享类型和工具函数
 */

export {
  type ActionType,
  type DaemonStatus,
  type Request,
  type Response,
  type ResponseData,
  type SSEEvent,
  type SSEEventType,
  type TabInfo,
  type TraceEvent,
  type TraceStatus,
  generateId,
} from "./protocol.js";

export {
  COMMAND_TIMEOUT,
  DAEMON_BASE_URL,
  DAEMON_HOST,
  DAEMON_PORT,
  SSE_HEARTBEAT_INTERVAL,
  SSE_MAX_RECONNECT_ATTEMPTS,
  SSE_RECONNECT_DELAY,
} from "./constants.js";

export {
  createProtocolError,
  type ErrorCode,
  type ErrorPhase,
  type ProtocolError,
} from "./errors.js";

export {
  PROTOCOL_VERSION,
  isRetryableBeforeDispatch,
  type BrokerToClientMessage,
  type BrokerToExtensionMessage,
  type ClientHello,
  type ClientToBrokerMessage,
  type CommandRequest,
  type CommandResponse,
  type ExtensionHello,
  type ExtensionToBrokerMessage,
  type Heartbeat,
  type Idempotency,
  type LeaseAcquire,
  type LeaseGranted,
  type LeaseRelease,
  type RequestCancel,
  type SessionCloseOwnedTabs,
  type SessionReady,
} from "./protocol-v2.js";

export { encodeFrame, FrameDecoder } from "./frame-codec.js";
