import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type BrokerHealth } from "@bb-browser/shared";
export type { BrokerHealth } from "@bb-browser/shared";
import { ClientServer, type ClientConnection } from "./client-server.js";
import { ExtensionChannel } from "./extension-channel.js";
import { LeaseManager } from "./lease-manager.js";
import { RequestRouter } from "./request-router.js";
import { ResourceScheduler } from "./resource-scheduler.js";
import { SessionRegistry } from "./session-registry.js";

export interface BrokerRuntimeOptions {
  runtimeRoot?: string;
  socketPath?: string;
  authToken: string;
  extensionInput?: NodeJS.ReadableStream;
  extensionOutput?: NodeJS.WritableStream;
}

export class BrokerRuntime extends EventEmitter {
  private readonly sessions = new SessionRegistry({
    recoveryWindowMs: 120_000,
    maxSessions: 32,
  });
  private readonly scheduler = new ResourceScheduler();
  private readonly leases = new LeaseManager();
  private readonly extension: ExtensionChannel;
  private readonly clients: ClientServer;
  private readonly router: RequestRouter;
  private runningValue = false;
  private readonly brokerInstanceId = randomUUID();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(options: BrokerRuntimeOptions) {
    super();
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const runtimeRoot =
      options.runtimeRoot ?? join(tmpdir(), `bb-browser-${uid}`);
    const socketPath = options.socketPath ?? join(runtimeRoot, "broker.sock");
    this.extension = new ExtensionChannel({
      input: options.extensionInput,
      output: options.extensionOutput,
    });
    this.clients = new ClientServer({
      runtimeRoot,
      socketPath,
      authToken: options.authToken,
      sessions: this.sessions,
      brokerInstanceId: this.brokerInstanceId,
      cleanup: () => this.cleanupExpiredSessions(),
    });
    this.router = new RequestRouter({
      sessions: this.sessions,
      scheduler: this.scheduler,
      leases: this.leases,
      extension: this.extension,
    });
    this.bindEvents();
  }

  async start(): Promise<void> {
    if (this.runningValue) {
      return;
    }
    this.extension.start();
    try {
      await this.clients.start();
      this.runningValue = true;
      this.cleanupTimer = setInterval(
        () => this.cleanupExpiredSessions(),
        10_000,
      );
      this.cleanupTimer.unref();
    } catch (error) {
      this.extension.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.runningValue) {
      this.extension.close();
      return;
    }
    this.runningValue = false;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    for (const session of this.sessions.clear()) {
      this.router.handleSessionDisconnect(session.sessionId);
    }
    await this.clients.stop();
    this.router.shutdown();
    this.extension.close();
  }

  health(): BrokerHealth {
    return {
      running: this.runningValue,
      extensionConnected: this.router.extensionReady,
      activeSessions: this.sessions.activeCount,
      detachedSessions: this.sessions.size - this.sessions.activeCount,
      connections: this.clients.connectionCount,
      pendingRequests: this.router.pendingCount,
      queuedRequests: this.scheduler.queuedCount,
      activeLeases: this.leases.activeCount,
      protocolVersion: PROTOCOL_VERSION,
      brokerInstanceId: this.brokerInstanceId,
    };
  }

  private cleanupExpiredSessions(): void {
    for (const session of this.sessions.expire()) {
      this.router.handleSessionDisconnect(session.sessionId);
    }
  }

  private bindEvents(): void {
    this.extension.on("message", (message) => {
      this.router.handleExtensionMessage(message);
    });
    this.extension.on("disconnect", () => {
      this.router.handleExtensionDisconnect();
    });
    this.extension.on("error", () => {
      this.router.handleExtensionDisconnect();
    });
    this.extension.on("closed", () => {
      this.emit("extensionClosed");
    });
    this.clients.on("message", (connection: ClientConnection, message) => {
      if (!connection.sessionId) {
        return;
      }
      if (connection.recovery && message.kind === "heartbeat") {
        this.clients.send(connection, {
          kind: "heartbeat",
          protocolVersion: PROTOCOL_VERSION,
          sentAt: message.sentAt,
        });
        return;
      }
      if (connection.recovery && message.sessionId === connection.sessionId) {
        if (message.kind === "session.end") {
          this.clients.end(connection);
          return;
        }
        if (message.kind === "session.health") {
          this.clients.send(connection, {
            kind: "session.health.result",
            protocolVersion: PROTOCOL_VERSION,
            sessionId: connection.sessionId,
            requestId: message.requestId,
            health: this.health(),
          });
          return;
        }
      }
      this.router.handleClientMessage(
        connection.sessionId,
        message,
        (response) => this.clients.send(connection, response),
      );
    });
    this.clients.on("disconnect", (sessionId: string) => {
      this.router.handleSessionDisconnect(sessionId);
    });
  }
}
