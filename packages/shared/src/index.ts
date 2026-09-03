/**
 * @bb-browser/shared
 * 共享类型和工具函数
 */

export {
  type ActionType,
  type Request,
  type Response,
  type ResponseData,
  type TabInfo,
  type TraceEvent,
  type TraceStatus,
  generateId,
} from "./protocol.js";

export {
  createProtocolError,
  type ErrorCode,
  type ErrorPhase,
  type ProtocolError,
} from "./errors.js";

export {
  PROTOCOL_VERSION,
  SESSION_RECOVERY_CAPABILITY,
  type ConnectionError,
  type SessionEnd,
  type SessionHealth,
  type SessionHealthResult,
  type BrokerHealth,
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
