import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import {
  PROTOCOL_VERSION,
  SESSION_RECOVERY_CAPABILITY,
  createProtocolError,
  type BrokerToClientMessage,
  type CommandRequest,
  type CommandResponse,
  type Idempotency,
  type LeaseGranted,
  type ProtocolError,
  type Request,
  type SessionReady,
  type SessionHealthResult,
  type BrokerHealth,
} from "@bb-browser/shared";
import { getRuntimePaths } from "./runtime-paths.js";
import {
  connectSocketTransport,
  type MessageTransport,
} from "./socket-transport.js";

export type CommandInput = Omit<Request, "id">;

export interface CommandOptions {
  timeoutMs: number;
  idempotency: Idempotency;
  signal?: AbortSignal;
  leaseId?: string;
  connectionGeneration?: number;
}

export interface BrowserClientOptions {
  clientName: string;
  authToken?: string;
  socketPath?: string;
  connectTimeoutMs?: number;
  resumeSessionId?: string;
  resumeClientId?: string;
  transportFactory?: (signal?: AbortSignal) => Promise<MessageTransport>;
  recoveryTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  signal?: AbortSignal;
}

interface PendingRequest<T> {
  action: string | null;
  idempotency: Idempotency;
  dispatched: boolean;
  cancelSent: boolean;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve: (value: T) => void;
  reject: (error: ProtocolError) => void;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export class BrowserConnection extends EventEmitter {
  private readonly pending = new Map<
    string,
    PendingRequest<CommandResponse | LeaseGranted | SessionHealthResult>
  >();
  private disconnected = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private probe?: { sentAt: number; startedAt: number };
  private lastHeartbeatTick = performance.now();
  private disconnectReason?: ProtocolError;

  private constructor(
    private readonly transport: MessageTransport,
    public readonly clientId: string,
    public readonly sessionId: string,
    public readonly ready: SessionReady,
    private readonly options: BrowserClientOptions,
  ) {
    super();
    transport.on("message", this.handleMessage);
    transport.on("close", this.handleDisconnect);
    transport.on("error", this.handleTransportError);
    const interval = options.heartbeatIntervalMs ?? 30_000;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), interval);
    this.heartbeatTimer.unref();
  }

  get connected(): boolean {
    return !this.disconnected;
  }

  static async connect(
    options: BrowserClientOptions = { clientName: "bb-browser-client" },
  ): Promise<BrowserConnection> {
    const paths = getRuntimePaths();
    let authToken = options.authToken;
    if (!authToken) {
      try {
        authToken = (await readFile(paths.tokenPath, "utf8")).trim();
      } catch {
        throw createProtocolError(
          "broker_unavailable",
          "connect",
          "无法读取 bb-browser 认证令牌",
        );
      }
    }

    let transport: MessageTransport;
    try {
      transport = options.transportFactory
        ? await options.transportFactory(options.signal)
        : await connectSocketTransport(options.socketPath ?? paths.socketPath, {
            signal: options.signal,
            timeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
          });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const detail =
        code === "ENOENT" || code === "ECONNREFUSED"
          ? "bb-browser Broker 尚未运行"
          : `无法连接 bb-browser Broker：${String(error)}`;
      throw createProtocolError("broker_unavailable", "connect", detail);
    }

    return BrowserConnection.fromConnectedTransport(transport, {
      ...options,
      authToken,
    });
  }

  static async fromConnectedTransport(
    transport: MessageTransport,
    options: BrowserClientOptions,
  ): Promise<BrowserConnection> {
    return new Promise<BrowserConnection>((resolve, reject) => {
      let settled = false;
      const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

      const cleanup = () => {
        clearTimeout(timer);
        transport.off("message", handleMessage);
        transport.off("close", handleClose);
        transport.off("error", handleError);
        options.signal?.removeEventListener("abort", handleAbort);
      };
      const fail = (error: ProtocolError) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        transport.close();
        reject(error);
      };
      const handleMessage = (value: unknown) => {
        const message = value as SessionReady;
        if ((value as BrokerToClientMessage).kind === "connection.error") {
          fail((value as { error: ProtocolError }).error);
          return;
        }
        if (message.kind !== "session.ready") {
          return;
        }
        if (
          message.protocolVersion !== PROTOCOL_VERSION ||
          !message.capabilities?.includes(SESSION_RECOVERY_CAPABILITY)
        ) {
          fail(
            createProtocolError(
              "protocol_version_mismatch",
              "handshake",
              "bb-browser Broker 不支持会话恢复，请升级 Native Host",
              { retryable: false },
            ),
          );
          return;
        }
        if (!message.clientId || !message.sessionId) {
          fail(
            createProtocolError(
              "protocol_version_mismatch",
              "handshake",
              "bb-browser Broker 握手响应不完整",
              { retryable: false },
            ),
          );
          return;
        }
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(
          new BrowserConnection(
            transport,
            message.clientId,
            message.sessionId,
            message,
            options,
          ),
        );
      };
      const handleClose = () => {
        fail(
          createProtocolError(
            "broker_unavailable",
            "handshake",
            "bb-browser 连接在握手期间中断",
          ),
        );
      };
      const handleError = (error: Error) => {
        fail(
          createProtocolError(
            "broker_unavailable",
            "handshake",
            `bb-browser Broker 握手失败：${error.message}`,
          ),
        );
      };
      const handleAbort = () =>
        fail(
          createProtocolError("request_cancelled", "connect", "连接已取消", {
            retryable: false,
          }),
        );
      const timer = setTimeout(() => {
        fail(
          createProtocolError(
            "broker_unavailable",
            "handshake",
            "bb-browser Broker 握手超时",
          ),
        );
      }, timeoutMs);

      transport.on("message", handleMessage);
      transport.on("close", handleClose);
      transport.on("error", handleError);
      if (options.signal?.aborted) {
        handleAbort();
        return;
      }
      options.signal?.addEventListener("abort", handleAbort, { once: true });
      try {
        transport.send({
          kind: "client.hello",
          protocolVersion: PROTOCOL_VERSION,
          clientName: options.clientName,
          authToken: options.authToken ?? "",
          resumeSessionId: options.resumeSessionId,
          resumeClientId: options.resumeClientId,
          capabilities: [SESSION_RECOVERY_CAPABILITY],
        });
      } catch (error) {
        handleError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  command(
    input: CommandInput,
    options: CommandOptions,
  ): Promise<CommandResponse> {
    const requestId = randomUUID();
    const { action, tabId, ...payload } = input;
    const message: CommandRequest = {
      kind: "command.request",
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      clientId: this.clientId,
      sessionId: this.sessionId,
      action,
      tabId,
      leaseId: options.leaseId,
      deadlineAt: Date.now() + options.timeoutMs,
      idempotency: options.idempotency,
      payload,
    };

    return this.sendPending<CommandResponse>(requestId, message, {
      action,
      timeoutMs: options.timeoutMs,
      idempotency: options.idempotency,
      signal: options.signal,
    });
  }

  async withTabLease<T>(
    tabId: number,
    timeoutMs: number,
    work: (leaseId: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const requestId = randomUUID();
    const granted = await this.sendPending<LeaseGranted>(
      requestId,
      {
        kind: "lease.acquire",
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        sessionId: this.sessionId,
        tabId,
        deadlineAt: Date.now() + timeoutMs,
      },
      {
        action: "lease.acquire",
        timeoutMs,
        idempotency: "safe_write",
        signal,
      },
    );

    try {
      return await work(granted.leaseId);
    } finally {
      if (!this.disconnected)
        try {
          this.transport.send({
            kind: "lease.release",
            protocolVersion: PROTOCOL_VERSION,
            sessionId: this.sessionId,
            leaseId: granted.leaseId,
          });
        } catch {
          /* Lease cleanup must not mask the original result. */
        }
    }
  }

  closeOwnedTabs(
    timeoutMs = 60_000,
    signal?: AbortSignal,
  ): Promise<CommandResponse> {
    const requestId = randomUUID();
    return this.sendPending<CommandResponse>(
      requestId,
      {
        kind: "session.close_owned_tabs",
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        sessionId: this.sessionId,
        deadlineAt: Date.now() + timeoutMs,
      },
      {
        action: "close_all",
        timeoutMs,
        idempotency: "unsafe_write",
        signal,
      },
    );
  }

  close(): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.stopHeartbeat();
    this.rejectAll(
      createProtocolError(
        "request_cancelled",
        "cleanup",
        "bb-browser Client 已关闭",
        { retryable: false },
      ),
    );
    try {
      this.transport.send({
        kind: "session.end",
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
      });
    } catch {
      /* Best effort on shutdown. */
    }
    this.transport.close();
    this.unbind();
  }

  async health(timeoutMs: number, signal?: AbortSignal): Promise<BrokerHealth> {
    const requestId = randomUUID();
    const result = await this.sendPending<SessionHealthResult>(
      requestId,
      {
        kind: "session.health",
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        requestId,
      },
      { action: "health", timeoutMs, idempotency: "read", signal },
    );
    return result.health;
  }

  private sendPending<
    T extends CommandResponse | LeaseGranted | SessionHealthResult,
  >(
    requestId: string,
    message: unknown,
    options: {
      action: string | null;
      timeoutMs: number;
      idempotency: Idempotency;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    if (this.disconnected) {
      return Promise.reject(
        createProtocolError(
          "broker_unavailable",
          "connect",
          "bb-browser Client 已断开",
        ),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cancelRequest(requestId);
        this.rejectPending(
          requestId,
          createProtocolError(
            "request_deadline_exceeded",
            "execute",
            `bb-browser 操作超时：${options.action ?? "unknown"}`,
            {
              retryable: options.idempotency !== "unsafe_write",
              action: options.action,
            },
          ),
        );
      }, options.timeoutMs);
      const pending: PendingRequest<T> = {
        action: options.action,
        idempotency: options.idempotency,
        dispatched: false,
        cancelSent: false,
        timer,
        signal: options.signal,
        resolve,
        reject,
      };
      if (options.signal) {
        pending.abortListener = () => {
          this.cancelRequest(requestId);
          this.rejectPending(
            requestId,
            createProtocolError(
              "request_cancelled",
              "execute",
              `bb-browser 操作已取消：${options.action ?? "unknown"}`,
              { retryable: false, action: options.action },
            ),
          );
        };
        if (options.signal.aborted) {
          clearTimeout(timer);
          reject(
            createProtocolError(
              "request_cancelled",
              "execute",
              `bb-browser 操作已取消：${options.action ?? "unknown"}`,
              { retryable: false, action: options.action },
            ),
          );
          return;
        }
        options.signal.addEventListener("abort", pending.abortListener, {
          once: true,
        });
      }

      this.pending.set(
        requestId,
        pending as PendingRequest<
          CommandResponse | LeaseGranted | SessionHealthResult
        >,
      );
      try {
        pending.dispatched = true;
        this.transport.send(message);
      } catch {
        this.rejectPending(
          requestId,
          createProtocolError(
            "broker_unavailable",
            "dispatch",
            "无法向 bb-browser Broker 发送请求",
            { action: options.action },
          ),
        );
      }
    });
  }

  private readonly handleMessage = (value: unknown): void => {
    const message = value as BrokerToClientMessage;
    if (message.kind === "connection.error") {
      this.disconnectReason = message.error;
      this.rejectAll(message.error);
      this.handleDisconnect();
      return;
    }
    if (message.kind === "heartbeat") {
      if (message.sentAt === this.probe?.sentAt) this.probe = undefined;
      return;
    }
    if (message.kind === "session.ready") {
      return;
    }
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      this.rejectAll(
        createProtocolError(
          "protocol_version_mismatch",
          "handshake",
          "bb-browser Broker 返回了不兼容的协议版本",
          { retryable: false },
        ),
      );
      return;
    }
    if (message.sessionId !== this.sessionId) {
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return;
    }
    this.finishPending(message.requestId, pending);
    if (message.kind === "command.response" && !message.success) {
      pending.reject(
        message.error ??
          createProtocolError(
            "browser_command_failed",
            "execute",
            `浏览器操作失败：${pending.action ?? "unknown"}`,
            {
              retryable: false,
              action: pending.action,
            },
          ),
      );
      return;
    }
    pending.resolve(message);
  };

  private readonly handleDisconnect = (): void => {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.stopHeartbeat();
    for (const [requestId, pending] of this.pending) {
      const error = pending.dispatched
        ? createProtocolError(
            "result_unknown_after_disconnect",
            "execute",
            `连接中断，无法确认操作结果：${pending.action ?? "unknown"}`,
            { retryable: false, action: pending.action },
          )
        : createProtocolError(
            "extension_disconnected",
            "dispatch",
            "浏览器扩展连接已中断",
            { action: pending.action },
          );
      this.finishPending(requestId, pending);
      pending.reject(error);
    }
    this.unbind();
    this.transport.close();
    this.emit(
      "disconnect",
      this.disconnectReason ??
        createProtocolError(
          "broker_unavailable",
          "connect",
          "Broker 连接已断开",
        ),
    );
  };

  private readonly handleTransportError = (): void => {
    this.handleDisconnect();
  };

  private heartbeat(): void {
    if (this.disconnected) return;
    const now = performance.now();
    const interval = this.options.heartbeatIntervalMs ?? 30_000;
    // A suspended event loop must probe afresh after waking.
    if (now - this.lastHeartbeatTick > interval * 2) this.probe = undefined;
    this.lastHeartbeatTick = now;
    if (this.probe) {
      if (
        now - this.probe.startedAt >=
        (this.options.heartbeatTimeoutMs ?? 90_000)
      ) {
        this.disconnectReason = createProtocolError(
          "broker_unavailable",
          "connect",
          "Broker 心跳响应超时",
        );
        this.handleDisconnect();
      }
      return;
    }
    this.probe = { sentAt: Date.now(), startedAt: now };
    try {
      this.transport.send({
        kind: "heartbeat",
        protocolVersion: PROTOCOL_VERSION,
        sentAt: this.probe.sentAt,
      });
    } catch {
      this.handleDisconnect();
    }
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    this.probe = undefined;
  }
  private unbind(): void {
    this.transport.off("message", this.handleMessage);
    this.transport.off("close", this.handleDisconnect);
    this.transport.off("error", this.handleTransportError);
  }

  private cancelRequest(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.cancelSent) {
      return;
    }
    pending.cancelSent = true;
    try {
      this.transport.send({
        kind: "request.cancel",
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        sessionId: this.sessionId,
      });
    } catch {
      // The original request error remains authoritative.
    }
  }

  private rejectPending(requestId: string, error: ProtocolError): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    this.finishPending(requestId, pending);
    pending.reject(error);
  }

  private finishPending(
    requestId: string,
    pending: PendingRequest<
      CommandResponse | LeaseGranted | SessionHealthResult
    >,
  ): void {
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }

  private rejectAll(error: ProtocolError): void {
    for (const [requestId, pending] of this.pending) {
      this.finishPending(requestId, pending);
      pending.reject({ ...error, action: pending.action });
    }
  }
}
