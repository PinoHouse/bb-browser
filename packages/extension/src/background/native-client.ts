import {
  PROTOCOL_VERSION,
  createProtocolError,
  type BrokerToExtensionMessage,
  type CommandRequest,
  type CommandResponse,
  type ExtensionToBrokerMessage,
  type Request,
  type ResponseData,
} from "@bb-browser/shared";

const NATIVE_HOST_NAME = "com.pinix.bb_browser";
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

interface NativeEvent<T extends (...args: never[]) => void> {
  addListener(listener: T): void;
}

export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: NativeEvent<(message: unknown) => void>;
  onDisconnect: NativeEvent<() => void>;
}

export type ExtensionCommand = Request & {
  requestId: string;
  sessionId: string;
  deadlineAt: number;
};

export interface CommandResult {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface NativeClientStatus {
  connected: boolean;
  hostName: string;
  lastConnectedAt: number | null;
  lastError: string | null;
}

export interface NativeClientOptions {
  connectNative?: () => NativePort;
  extensionVersion: string;
  handleCommand: (
    command: ExtensionCommand,
    signal?: AbortSignal,
  ) => Promise<CommandResult>;
  scheduleReconnect?: (callback: () => void, delay: number) => unknown;
}

export class NativeClient {
  private readonly connectNative: () => NativePort;
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly controllers = new Map<string, AbortController>();
  private port?: NativePort;
  private reconnectAttempt = 0;
  private reconnectScheduled = false;
  private stopped = false;
  private lastConnectedAtValue: number | null = null;
  private lastErrorValue: string | null = null;

  constructor(private readonly options: NativeClientOptions) {
    this.connectNative =
      options.connectNative ??
      (() => chrome.runtime.connectNative(NATIVE_HOST_NAME) as NativePort);
    this.schedule = options.scheduleReconnect ?? setTimeout;
  }

  connect(): void {
    this.stopped = false;
    if (this.port) {
      return;
    }
    try {
      const port = this.connectNative();
      this.port = port;
      this.reconnectAttempt = 0;
      this.reconnectScheduled = false;
      this.lastConnectedAtValue = Date.now();
      this.lastErrorValue = null;
      port.onMessage.addListener((message) => {
        void this.handleMessage(port, message as BrokerToExtensionMessage);
      });
      port.onDisconnect.addListener(() => this.handleDisconnect(port));
      port.postMessage({
        kind: "extension.hello",
        protocolVersion: PROTOCOL_VERSION,
        extensionVersion: this.options.extensionVersion,
        capabilities: ["chrome.tabs", "chrome.debugger", "chrome.history"],
      } satisfies ExtensionToBrokerMessage);
    } catch (error) {
      this.lastErrorValue =
        error instanceof Error ? error.message : String(error);
      this.scheduleNextReconnect();
    }
  }

  disconnect(): void {
    this.stopped = true;
    this.reconnectScheduled = false;
    const port = this.port;
    this.port = undefined;
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
    port?.disconnect();
  }

  status(): NativeClientStatus {
    return {
      connected: Boolean(this.port),
      hostName: NATIVE_HOST_NAME,
      lastConnectedAt: this.lastConnectedAtValue,
      lastError: this.lastErrorValue,
    };
  }

  private async handleMessage(
    port: NativePort,
    message: BrokerToExtensionMessage,
  ): Promise<void> {
    if (this.port !== port) {
      return;
    }
    if (message.kind === "heartbeat") {
      port.postMessage({
        kind: "heartbeat",
        protocolVersion: PROTOCOL_VERSION,
        sentAt: Date.now(),
      } satisfies ExtensionToBrokerMessage);
      return;
    }
    if (message.kind === "request.cancel") {
      this.controllers.get(message.requestId)?.abort();
      return;
    }
    await this.executeCommand(port, message);
  }

  private async executeCommand(
    port: NativePort,
    request: CommandRequest,
  ): Promise<void> {
    const startedAt = Date.now();
    const controller = new AbortController();
    this.controllers.set(request.requestId, controller);

    let response: CommandResponse;
    if (request.deadlineAt <= startedAt) {
      response = {
        kind: "command.response",
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        sessionId: request.sessionId,
        success: false,
        error: createProtocolError(
          "request_deadline_exceeded",
          "execute",
          `浏览器操作超过截止时间：${request.action}`,
          {
            retryable: request.idempotency !== "unsafe_write",
            action: request.action,
          },
        ),
        timing: { queuedMs: 0, executionMs: 0 },
      };
    } else {
      const command: ExtensionCommand = {
        id: request.requestId,
        requestId: request.requestId,
        sessionId: request.sessionId,
        deadlineAt: request.deadlineAt,
        action: request.action,
        tabId: request.tabId,
        ...request.payload,
      };
      try {
        const result = await this.options.handleCommand(
          command,
          controller.signal,
        );
        response = {
          kind: "command.response",
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          sessionId: request.sessionId,
          success: result.success,
          data: result.data as ResponseData | undefined,
          error: result.success
            ? undefined
            : createProtocolError(
                "browser_command_failed",
                "execute",
                result.error ?? `浏览器操作失败：${request.action}`,
                { retryable: false, action: request.action },
              ),
          timing: {
            queuedMs: 0,
            executionMs: Date.now() - startedAt,
          },
        };
      } catch (error) {
        response = {
          kind: "command.response",
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          sessionId: request.sessionId,
          success: false,
          error: createProtocolError(
            controller.signal.aborted
              ? "request_cancelled"
              : "browser_command_failed",
            "execute",
            controller.signal.aborted
              ? `浏览器操作已取消：${request.action}`
              : error instanceof Error
                ? error.message
                : String(error),
            { retryable: false, action: request.action },
          ),
          timing: {
            queuedMs: 0,
            executionMs: Date.now() - startedAt,
          },
        };
      }
    }

    this.controllers.delete(request.requestId);
    if (this.port === port) {
      port.postMessage(response);
    }
  }

  private handleDisconnect(port: NativePort): void {
    if (this.port !== port) {
      return;
    }
    this.port = undefined;
    this.lastErrorValue = "Native Host connection closed";
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
    this.scheduleNextReconnect();
  }

  private scheduleNextReconnect(): void {
    if (this.stopped || this.reconnectScheduled) {
      return;
    }
    this.reconnectScheduled = true;
    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
      ];
    this.reconnectAttempt += 1;
    this.schedule(() => {
      this.reconnectScheduled = false;
      this.connect();
    }, delay);
  }
}
