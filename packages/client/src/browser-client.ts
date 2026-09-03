import {
  createProtocolError,
  type BrokerHealth,
  type CommandResponse,
  type ProtocolError,
  type SessionReady,
} from "@bb-browser/shared";
import {
  BrowserConnection,
  type BrowserClientOptions,
  type CommandInput,
  type CommandOptions,
} from "./browser-connection.js";
import type { MessageTransport } from "./socket-transport.js";

export type {
  BrowserClientOptions,
  CommandInput,
  CommandOptions,
} from "./browser-connection.js";

export interface ConnectionStatus {
  connected: boolean;
  generation: number;
  clientId?: string;
  sessionId?: string;
  brokerInstanceId?: string;
  resumed?: boolean;
  reconnectAttempts: number;
  lastError?: ProtocolError;
  contextLost: boolean;
}

/** Stable process-scoped facade. Recovery never replays a submitted operation. */
export class BrowserClient {
  private connection?: BrowserConnection;
  private identity?: SessionReady;
  private attempt?: {
    promise: Promise<BrowserConnection>;
    controller: AbortController;
  };
  private waiters = 0;
  private closed = false;
  private generation = 0;
  private revision = 0;
  private contextLost = false;
  private reconnectAttempts = 0;
  private lastError?: ProtocolError;
  private readonly leases = new Map<string, number>();

  private constructor(private readonly options: BrowserClientOptions) {}

  static create(
    options: BrowserClientOptions = { clientName: "bb-browser-client" },
  ): BrowserClient {
    return new BrowserClient(options);
  }

  static async connect(
    options: BrowserClientOptions = { clientName: "bb-browser-client" },
  ): Promise<BrowserClient> {
    const client = BrowserClient.create(options);
    try {
      await client.ensureConnected(
        options.recoveryTimeoutMs ?? 10_000,
        options.signal,
      );
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  static async fromConnectedTransport(
    transport: MessageTransport,
    options: BrowserClientOptions,
  ): Promise<BrowserClient> {
    const client = BrowserClient.create(options);
    client.adopt(
      await BrowserConnection.fromConnectedTransport(transport, options),
    );
    return client;
  }

  get clientId(): string {
    return this.identity?.clientId ?? "";
  }
  get sessionId(): string {
    return this.identity?.sessionId ?? "";
  }
  get connectionGeneration(): number {
    return this.generation;
  }

  status(): ConnectionStatus {
    return {
      connected: this.connection?.connected ?? false,
      generation: this.generation,
      clientId: this.identity?.clientId,
      sessionId: this.identity?.sessionId,
      brokerInstanceId: this.identity?.brokerInstanceId,
      resumed: this.identity?.resumed,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
      contextLost: this.contextLost,
    };
  }

  async ensureConnected(
    timeoutMs = 10_000,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.acquire(Date.now() + timeoutMs, signal);
  }

  command(
    input: CommandInput,
    options: CommandOptions,
  ): Promise<CommandResponse> {
    const deadline = Date.now() + options.timeoutMs;
    const dispatch = (connection: BrowserConnection) => {
      this.checkContext(options.connectionGeneration, options.leaseId);
      if (
        this.contextLost &&
        input.tabId === undefined &&
        !["tab_list", "history", "tab_new", "open"].includes(input.action)
      )
        throw this.resetError();
      return connection.command(input, {
        ...options,
        timeoutMs: Math.max(0, deadline - Date.now()),
      });
    };
    try {
      this.checkAvailable(deadline, options.signal);
      this.checkContext(options.connectionGeneration, options.leaseId);
      if (this.connection?.connected) return dispatch(this.connection);
      return this.acquire(deadline, options.signal).then(dispatch);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async withTabLease<T>(
    tabId: number,
    timeoutMs: number,
    work: (leaseId: string) => Promise<T>,
    options: { signal?: AbortSignal; connectionGeneration?: number } = {},
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    this.checkContext(options.connectionGeneration);
    const connection = this.connection?.connected
      ? this.connection
      : await this.acquire(deadline, options.signal);
    this.checkAvailable(deadline, options.signal);
    this.checkContext(options.connectionGeneration);
    const generation = this.generation;
    return connection.withTabLease(
      tabId,
      deadline - Date.now(),
      async (leaseId) => {
        this.leases.set(leaseId, generation);
        try {
          this.checkContext(generation);
          const result = await work(leaseId);
          this.checkContext(generation);
          if (!connection.connected) throw this.resetError();
          return result;
        } finally {
          this.leases.delete(leaseId);
        }
      },
      options.signal,
    );
  }

  async closeOwnedTabs(
    timeoutMs = 60_000,
    signal?: AbortSignal,
  ): Promise<CommandResponse> {
    const deadline = Date.now() + timeoutMs;
    const connection = await this.acquire(deadline, signal);
    if (this.contextLost) throw this.resetError();
    return connection.closeOwnedTabs(
      Math.max(0, deadline - Date.now()),
      signal,
    );
  }

  async health(
    timeoutMs = 10_000,
    signal?: AbortSignal,
  ): Promise<{ client: ConnectionStatus; broker?: BrokerHealth }> {
    const deadline = Date.now() + timeoutMs;
    try {
      const connection = await this.acquire(deadline, signal);
      return {
        client: this.status(),
        broker: await connection.health(
          Math.max(1, deadline - Date.now()),
          signal,
        ),
      };
    } catch (error) {
      this.lastError = normalize(error);
      return { client: this.status() };
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.attempt?.controller.abort();
    this.connection?.close();
    this.connection = undefined;
    this.leases.clear();
  }

  private checkAvailable(deadline: number, signal?: AbortSignal): void {
    if (this.closed || signal?.aborted)
      throw createProtocolError(
        "request_cancelled",
        "connect",
        "bb-browser 请求已取消",
        { retryable: false },
      );
    if (deadline <= Date.now())
      throw createProtocolError(
        "request_deadline_exceeded",
        "connect",
        "等待浏览器连接超过请求截止时间",
        { retryable: false },
      );
  }

  private checkContext(generation?: number, leaseId?: string): void {
    if (generation !== undefined && generation !== this.generation)
      throw this.resetError();
    if (
      leaseId &&
      (this.leases.get(leaseId) !== this.generation ||
        !this.connection?.connected)
    )
      throw this.resetError();
  }

  private resetError(): ProtocolError {
    return createProtocolError(
      "session_reset",
      "connect",
      "浏览器连接或会话已变化，请重新确认页面；旧租约和历史标签归属不可沿用",
      { retryable: false },
    );
  }

  private adopt(connection: BrowserConnection): BrowserConnection {
    if (this.closed) {
      connection.close();
      throw createProtocolError(
        "request_cancelled",
        "connect",
        "Client 已关闭",
      );
    }
    const previousSession =
      this.identity?.sessionId ?? this.options.resumeSessionId;
    if (
      previousSession &&
      (!connection.ready.resumed ||
        previousSession !== connection.sessionId ||
        (this.identity?.brokerInstanceId &&
          this.identity.brokerInstanceId !== connection.ready.brokerInstanceId))
    ) {
      this.revision++;
      this.contextLost = true;
      this.lastError = this.resetError();
    }
    this.identity = connection.ready;
    this.connection = connection;
    this.generation++;
    connection.on("disconnect", (error: ProtocolError) => {
      if (this.connection !== connection) return;
      this.lastError = error;
      this.leases.clear();
    });
    return connection;
  }

  private async acquire(
    deadline: number,
    signal?: AbortSignal,
  ): Promise<BrowserConnection> {
    this.checkAvailable(deadline, signal);
    if (this.connection?.connected) return this.connection;
    const revision = this.revision;
    // Drop a cancelled flight before accepting a new independent caller.
    if (this.attempt?.controller.signal.aborted) this.attempt = undefined;
    if (!this.attempt) {
      const controller = new AbortController();
      const attempt = {
        controller,
        promise: Promise.resolve(undefined as unknown as BrowserConnection),
      };
      attempt.promise = this.recover(controller.signal).finally(() => {
        if (this.attempt === attempt) this.attempt = undefined;
      });
      this.attempt = attempt;
    }
    const attempt = this.attempt;
    this.waiters++;
    try {
      const remaining = Math.min(
        deadline - Date.now(),
        this.options.recoveryTimeoutMs ?? 10_000,
      );
      const connection = await waitFor(
        attempt.promise,
        remaining,
        signal,
        attempt.controller.signal,
      );
      this.checkAvailable(deadline, signal);
      if (revision !== this.revision) throw this.resetError();
      return connection;
    } finally {
      this.waiters--;
      if (this.waiters === 0 && this.attempt === attempt)
        attempt.controller.abort();
    }
  }

  private async recover(signal: AbortSignal): Promise<BrowserConnection> {
    const deadline = Date.now() + (this.options.recoveryTimeoutMs ?? 10_000);
    let retry = 0;
    while (true) {
      this.checkAvailable(deadline, signal);
      try {
        if (this.identity) this.reconnectAttempts++;
        const connection = await BrowserConnection.connect({
          ...this.options,
          signal,
          connectTimeoutMs: Math.min(
            this.options.connectTimeoutMs ?? 5_000,
            Math.max(1, deadline - Date.now()),
          ),
          resumeSessionId:
            this.identity?.sessionId ?? this.options.resumeSessionId,
          resumeClientId:
            this.identity?.clientId ?? this.options.resumeClientId,
        });
        if (signal.aborted) {
          connection.close();
          this.checkAvailable(deadline, signal);
        }
        return this.adopt(connection);
      } catch (error) {
        const failure = normalize(error);
        this.lastError = failure;
        if (!failure.retryable || signal.aborted || this.closed) throw failure;
        const delay =
          Math.min(4_000, 500 * 2 ** retry++) * (0.8 + Math.random() * 0.4);
        if (Date.now() + delay >= deadline) throw failure;
        await delayFor(delay, signal);
      }
    }
  }
}

function normalize(error: unknown): ProtocolError {
  if (error && typeof error === "object" && "code" in error && "phase" in error)
    return error as ProtocolError;
  return createProtocolError(
    "broker_unavailable",
    "connect",
    "无法建立 bb-browser 连接",
  );
}

function waitFor<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  shutdown?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      finish(() =>
        reject(
          createProtocolError(
            "request_cancelled",
            "connect",
            "连接等待已取消",
            { retryable: false },
          ),
        ),
      );
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            createProtocolError(
              "request_deadline_exceeded",
              "connect",
              "连接恢复等待超时",
              { retryable: false },
            ),
          ),
        ),
      Math.max(0, timeoutMs),
    );
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      shutdown?.removeEventListener("abort", abort);
      work();
    };
    signal?.addEventListener("abort", abort, { once: true });
    shutdown?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || shutdown?.aborted) abort();
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function delayFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(createProtocolError("request_cancelled", "connect", "重连已取消"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
