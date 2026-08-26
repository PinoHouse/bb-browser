import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  createProtocolError,
  type BrokerToClientMessage,
  type ClientToBrokerMessage,
  type CommandRequest,
  type CommandResponse,
  type ExtensionToBrokerMessage,
  type Idempotency,
  type LeaseAcquire,
  type ProtocolError,
  type RequestCancel,
  type ResponseData,
  type SessionCloseOwnedTabs,
} from "@bb-browser/shared";
import { ExtensionChannel } from "./extension-channel.js";
import { LeaseManager } from "./lease-manager.js";
import { ResourceScheduler } from "./resource-scheduler.js";
import { SessionRegistry } from "./session-registry.js";

type SendClient = (message: BrokerToClientMessage) => void;

interface RoutedJob {
  request: CommandRequest;
  send: SendClient;
  queuedAt: number;
  dispatchedAt?: number;
  state: "queued" | "dispatched";
  completed: boolean;
  overrideError?: ProtocolError;
  timer?: NodeJS.Timeout;
}

interface PendingExtensionRequest {
  job: RoutedJob;
  resolve: (response: CommandResponse) => void;
  reject: (error: ProtocolError) => void;
}

export interface RequestRouterOptions {
  sessions: SessionRegistry;
  scheduler: ResourceScheduler;
  leases: LeaseManager;
  extension: ExtensionChannel;
}

export class RequestRouter {
  private readonly jobs = new Map<string, RoutedJob>();
  private readonly pendingExtension = new Map<
    string,
    PendingExtensionRequest
  >();
  private protocolMismatch = false;

  constructor(private readonly options: RequestRouterOptions) {}

  handleClientMessage(
    connectionSessionId: string,
    message: ClientToBrokerMessage,
    send: SendClient,
  ): void {
    if (message.kind === "client.hello") {
      return;
    }
    if (message.kind === "heartbeat") {
      this.options.sessions.touch(connectionSessionId);
      return;
    }
    if (message.sessionId !== connectionSessionId) {
      const requestId = "requestId" in message ? message.requestId : randomUUID();
      this.safeSend(
        send,
        this.errorResponse(
          requestId,
          connectionSessionId,
          createProtocolError(
            "session_expired",
            "queue",
            "请求会话与连接会话不一致",
            { retryable: false },
          ),
        ),
      );
      return;
    }

    switch (message.kind) {
      case "command.request":
        this.routeCommand(message, send);
        break;
      case "lease.acquire":
        this.acquireLease(message, send);
        break;
      case "lease.release":
        this.options.leases.release(message.sessionId, message.leaseId);
        break;
      case "request.cancel":
        this.cancel(message);
        break;
      case "session.close_owned_tabs":
        void this.closeOwnedTabs(message, send);
        break;
    }
  }

  handleExtensionMessage(message: ExtensionToBrokerMessage): void {
    if (message.kind === "extension.hello") {
      this.protocolMismatch = message.protocolVersion !== PROTOCOL_VERSION;
      if (this.protocolMismatch) {
        this.rejectPendingExtension(
          createProtocolError(
            "protocol_version_mismatch",
            "handshake",
            "Chrome 扩展与 bb-browser Broker 协议版本不兼容",
            { retryable: false },
          ),
        );
      }
      return;
    }
    if (message.kind === "heartbeat") {
      return;
    }

    const pending = this.pendingExtension.get(message.requestId);
    if (!pending || message.sessionId !== pending.job.request.sessionId) {
      return;
    }
    this.pendingExtension.delete(message.requestId);
    const now = Date.now();
    const timing = {
      queuedMs:
        (pending.job.dispatchedAt ?? pending.job.queuedAt) -
        pending.job.queuedAt,
      executionMs: Math.max(0, now - (pending.job.dispatchedAt ?? now)),
    };
    if (!message.success) {
      const baseError =
        message.error ??
        createProtocolError(
          "browser_command_failed",
          "execute",
          `浏览器操作失败：${pending.job.request.action}`,
          { retryable: false, action: pending.job.request.action },
        );
      pending.reject({
        ...baseError,
        retryable:
          pending.job.request.idempotency === "unsafe_write"
            ? false
            : baseError.retryable,
        action: pending.job.request.action,
      });
      return;
    }
    pending.resolve({
      kind: "command.response",
      protocolVersion: PROTOCOL_VERSION,
      requestId: message.requestId,
      sessionId: message.sessionId,
      success: true,
      data: message.data,
      timing,
    });
  }

  handleExtensionDisconnect(): void {
    this.protocolMismatch = false;
    this.rejectPendingExtension(
      createProtocolError(
        "result_unknown_after_disconnect",
        "execute",
        "Chrome 扩展连接中断，无法确认操作结果",
        { retryable: false },
      ),
    );
  }

  handleSessionDisconnect(sessionId: string): void {
    this.options.leases.releaseSession(sessionId);
    for (const job of [...this.jobs.values()]) {
      if (job.request.sessionId !== sessionId) {
        continue;
      }
      const cancellation: RequestCancel = {
        kind: "request.cancel",
        protocolVersion: PROTOCOL_VERSION,
        requestId: job.request.requestId,
        sessionId,
      };
      this.cancel(cancellation);
    }
  }

  get pendingCount(): number {
    return this.jobs.size;
  }

  get extensionReady(): boolean {
    return this.options.extension.connected && !this.protocolMismatch;
  }

  private routeCommand(request: CommandRequest, send: SendClient): void {
    let session;
    try {
      session = this.options.sessions.require(request.sessionId);
      if (session.clientId !== request.clientId) {
        throw createProtocolError(
          "session_expired",
          "queue",
          "请求客户端与会话不一致",
          { retryable: false, action: request.action },
        );
      }
      if (request.deadlineAt <= Date.now()) {
        throw this.deadlineError(request, "queue");
      }
      const tabId = this.resolveTabId(request);
      if (tabId !== undefined) {
        this.options.leases.assertAccess(
          request.sessionId,
          tabId,
          request.leaseId,
        );
      }
    } catch (error) {
      this.safeSend(
        send,
        this.errorResponse(
          request.requestId,
          request.sessionId,
          this.normalizeError(error, request.action),
        ),
      );
      return;
    }

    const job: RoutedJob = {
      request,
      send,
      queuedAt: Date.now(),
      state: "queued",
      completed: false,
    };
    this.jobs.set(request.requestId, job);
    job.timer = setTimeout(
      () => this.expireJob(job),
      Math.max(1, request.deadlineAt - Date.now()),
    );
    const resourceKey = this.resourceKey(request);
    void this.options.scheduler
      .run(
        request.sessionId,
        resourceKey,
        () => this.dispatch(job),
        { requestId: request.requestId },
      )
      .then(
        (response) => this.completeJob(job, response),
        (error) => {
          const protocolError =
            job.overrideError ?? this.normalizeError(error, request.action);
          this.completeJob(
            job,
            this.errorResponse(
              request.requestId,
              request.sessionId,
              protocolError,
              job,
            ),
          );
        },
      );
  }

  private dispatch(job: RoutedJob): Promise<CommandResponse> {
    if (job.completed) {
      return Promise.reject(
        job.overrideError ??
          createProtocolError(
            "request_cancelled",
            "queue",
            "请求已取消",
            { retryable: false, action: job.request.action },
          ),
      );
    }
    try {
      this.options.sessions.require(job.request.sessionId);
      if (job.request.deadlineAt <= Date.now()) {
        throw this.deadlineError(job.request, "queue");
      }
      const tabId = this.resolveTabId(job.request);
      if (tabId !== undefined) {
        this.options.leases.assertAccess(
          job.request.sessionId,
          tabId,
          job.request.leaseId,
        );
      }
      if (this.protocolMismatch) {
        throw createProtocolError(
          "protocol_version_mismatch",
          "handshake",
          "Chrome 扩展与 bb-browser Broker 协议版本不兼容",
          { retryable: false, action: job.request.action },
        );
      }
      if (!this.options.extension.connected) {
        throw createProtocolError(
          "extension_disconnected",
          "dispatch",
          "Chrome 扩展尚未连接 bb-browser Native Host",
          { action: job.request.action },
        );
      }
    } catch (error) {
      return Promise.reject(this.normalizeError(error, job.request.action));
    }

    return new Promise<CommandResponse>((resolve, reject) => {
      this.pendingExtension.set(job.request.requestId, {
        job,
        resolve,
        reject,
      });
      try {
        this.options.extension.send(job.request);
        job.state = "dispatched";
        job.dispatchedAt = Date.now();
      } catch {
        this.pendingExtension.delete(job.request.requestId);
        job.state = "queued";
        job.dispatchedAt = undefined;
        reject(
          createProtocolError(
            "extension_disconnected",
            "dispatch",
            "无法向 Chrome 扩展发送浏览器请求",
            { action: job.request.action },
          ),
        );
      }
    });
  }

  private acquireLease(message: LeaseAcquire, send: SendClient): void {
    try {
      this.options.sessions.require(message.sessionId);
    } catch (error) {
      this.safeSend(
        send,
        this.errorResponse(
          message.requestId,
          message.sessionId,
          this.normalizeError(error, "lease.acquire"),
        ),
      );
      return;
    }
    void this.options.leases
      .acquire(
        message.sessionId,
        message.tabId,
        Math.min(message.deadlineAt, Date.now() + 120_000),
      )
      .then(
        (lease) => {
          this.safeSend(send, {
            kind: "lease.granted",
            protocolVersion: PROTOCOL_VERSION,
            requestId: message.requestId,
            sessionId: message.sessionId,
            tabId: lease.tabId,
            leaseId: lease.leaseId,
          });
        },
        (error) => {
          this.safeSend(
            send,
            this.errorResponse(
              message.requestId,
              message.sessionId,
              this.normalizeError(error, "lease.acquire"),
            ),
          );
        },
      );
  }

  private cancel(message: RequestCancel): void {
    const job = this.jobs.get(message.requestId);
    if (!job || job.request.sessionId !== message.sessionId || job.completed) {
      return;
    }
    const error = createProtocolError(
      "request_cancelled",
      job.state === "queued" ? "queue" : "execute",
      `浏览器操作已取消：${job.request.action}`,
      { retryable: false, action: job.request.action },
    );
    job.overrideError = error;
    if (
      job.state === "queued" &&
      this.options.scheduler.cancelQueued(
        job.request.sessionId,
        job.request.requestId,
      )
    ) {
      return;
    }
    const pending = this.pendingExtension.get(job.request.requestId);
    if (pending) {
      this.pendingExtension.delete(job.request.requestId);
      try {
        this.options.extension.send(message);
      } catch {
        // The cancellation result remains authoritative.
      }
      pending.reject(error);
      return;
    }
    this.completeJob(
      job,
      this.errorResponse(
        job.request.requestId,
        job.request.sessionId,
        error,
        job,
      ),
    );
  }

  private expireJob(job: RoutedJob): void {
    if (job.completed) {
      return;
    }
    const error = this.deadlineError(
      job.request,
      job.state === "queued" ? "queue" : "execute",
    );
    job.overrideError = error;
    if (
      job.state === "queued" &&
      this.options.scheduler.cancelQueued(
        job.request.sessionId,
        job.request.requestId,
      )
    ) {
      return;
    }
    const pending = this.pendingExtension.get(job.request.requestId);
    if (pending) {
      this.pendingExtension.delete(job.request.requestId);
      try {
        this.options.extension.send({
          kind: "request.cancel",
          protocolVersion: PROTOCOL_VERSION,
          requestId: job.request.requestId,
          sessionId: job.request.sessionId,
        });
      } catch {
        // The deadline result remains authoritative.
      }
      pending.reject(error);
      return;
    }
    this.completeJob(
      job,
      this.errorResponse(
        job.request.requestId,
        job.request.sessionId,
        error,
        job,
      ),
    );
  }

  private async closeOwnedTabs(
    message: SessionCloseOwnedTabs,
    send: SendClient,
  ): Promise<void> {
    const startedAt = Date.now();
    let session;
    try {
      session = this.options.sessions.require(message.sessionId);
    } catch (error) {
      this.safeSend(
        send,
        this.errorResponse(
          message.requestId,
          message.sessionId,
          this.normalizeError(error, "close_all"),
        ),
      );
      return;
    }

    const closedTabIds: number[] = [];
    const failures: ProtocolError[] = [];
    for (const tabId of this.options.sessions.ownedTabs(message.sessionId)) {
      if (Date.now() >= message.deadlineAt) {
        failures.push(
          createProtocolError(
            "request_deadline_exceeded",
            "cleanup",
            "关闭会话标签页超时",
            { retryable: false, action: "close_all" },
          ),
        );
        break;
      }
      const request: CommandRequest = {
        kind: "command.request",
        protocolVersion: PROTOCOL_VERSION,
        requestId: `${message.requestId}:${randomUUID()}`,
        clientId: session.clientId,
        sessionId: message.sessionId,
        action: "close",
        tabId,
        deadlineAt: message.deadlineAt,
        idempotency: "unsafe_write",
        payload: {},
      };
      const response = await new Promise<CommandResponse>((resolve) => {
        this.routeCommand(request, (value) =>
          resolve(value as CommandResponse),
        );
      });
      if (response.success) {
        closedTabIds.push(tabId);
      } else if (response.error) {
        failures.push(response.error);
      }
    }

    const timing = {
      queuedMs: 0,
      executionMs: Date.now() - startedAt,
    };
    if (failures.length > 0) {
      this.safeSend(send, {
        kind: "command.response",
        protocolVersion: PROTOCOL_VERSION,
        requestId: message.requestId,
        sessionId: message.sessionId,
        success: false,
        data: { result: { closedTabIds, failureCount: failures.length } },
        error: { ...failures[0], action: "close_all" },
        timing,
      });
      return;
    }
    this.safeSend(send, {
      kind: "command.response",
      protocolVersion: PROTOCOL_VERSION,
      requestId: message.requestId,
      sessionId: message.sessionId,
      success: true,
      data: { result: { closedTabIds, failureCount: 0 } },
      timing,
    });
  }

  private completeJob(job: RoutedJob, response: CommandResponse): void {
    if (job.completed) {
      return;
    }
    job.completed = true;
    if (job.timer) {
      clearTimeout(job.timer);
    }
    this.jobs.delete(job.request.requestId);
    if (response.success) {
      this.updateSessionState(job.request, response.data);
    }
    this.safeSend(job.send, response);
  }

  private updateSessionState(
    request: CommandRequest,
    data?: ResponseData,
  ): void {
    const responseTabId = data?.tabId;
    if (
      (request.action === "open" || request.action === "tab_new") &&
      responseTabId !== undefined
    ) {
      this.options.sessions.recordOwnedTab(request.sessionId, responseTabId);
      return;
    }
    if (request.action === "close" || request.action === "tab_close") {
      const closedTabId = this.numericTabId(request.tabId) ?? responseTabId;
      if (closedTabId !== undefined) {
        this.options.sessions.forgetTab(closedTabId);
      }
      return;
    }
    const referencedTabId = this.numericTabId(request.tabId) ?? responseTabId;
    if (referencedTabId !== undefined) {
      this.options.sessions.recordReference(
        request.sessionId,
        referencedTabId,
      );
      this.options.sessions.setDefaultTab(
        request.sessionId,
        referencedTabId,
      );
    }
  }

  private rejectPendingExtension(baseError: ProtocolError): void {
    for (const [requestId, pending] of this.pendingExtension) {
      this.pendingExtension.delete(requestId);
      pending.reject({
        ...baseError,
        retryable:
          pending.job.request.idempotency === "unsafe_write"
            ? false
            : baseError.retryable,
        action: pending.job.request.action,
      });
    }
  }

  private resourceKey(request: CommandRequest): string {
    if (
      request.action === "tab_list" ||
      request.action === "history" ||
      request.action === "open" ||
      request.action === "tab_new" ||
      request.action === "tab_select"
    ) {
      return "global:browser";
    }
    const tabId = this.resolveTabId(request);
    return tabId === undefined ? "global:active-tab" : `tab:${tabId}`;
  }

  private resolveTabId(request: CommandRequest): number | undefined {
    return (
      this.numericTabId(request.tabId) ??
      this.options.sessions.defaultTab(request.sessionId)
    );
  }

  private numericTabId(tabId: number | string | undefined): number | undefined {
    if (typeof tabId === "number" && Number.isInteger(tabId)) {
      return tabId;
    }
    if (typeof tabId === "string" && /^\d+$/.test(tabId)) {
      return Number(tabId);
    }
    return undefined;
  }

  private deadlineError(
    request: CommandRequest,
    phase: "queue" | "execute",
  ): ProtocolError {
    return createProtocolError(
      "request_deadline_exceeded",
      phase,
      `浏览器操作超过截止时间：${request.action}`,
      {
        retryable: request.idempotency !== "unsafe_write",
        action: request.action,
      },
    );
  }

  private normalizeError(error: unknown, action: string): ProtocolError {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      "phase" in error &&
      "retryable" in error &&
      "error" in error &&
      "hint" in error
    ) {
      return { ...(error as ProtocolError), action };
    }
    return createProtocolError(
      "browser_command_failed",
      "execute",
      error instanceof Error ? error.message : String(error),
      { retryable: false, action },
    );
  }

  private errorResponse(
    requestId: string,
    sessionId: string,
    error: ProtocolError,
    job?: RoutedJob,
  ): CommandResponse {
    const now = Date.now();
    return {
      kind: "command.response",
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      sessionId,
      success: false,
      error,
      timing: {
        queuedMs: job
          ? (job.dispatchedAt ?? now) - job.queuedAt
          : 0,
        executionMs: job?.dispatchedAt
          ? Math.max(0, now - job.dispatchedAt)
          : 0,
      },
    };
  }

  private safeSend(send: SendClient, message: BrokerToClientMessage): void {
    try {
      send(message);
    } catch {
      // A disconnected client must not affect other sessions.
    }
  }
}
