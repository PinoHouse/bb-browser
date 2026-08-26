import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@bb-browser/shared";
import {
  ClientServer,
  type ClientConnection,
} from "./client-server.js";
import { ExtensionChannel } from "./extension-channel.js";
import { LeaseManager } from "./lease-manager.js";
import { RequestRouter } from "./request-router.js";
import { ResourceScheduler } from "./resource-scheduler.js";
import { SessionRegistry } from "./session-registry.js";

export interface BrokerHealth {
  running: boolean;
  extensionConnected: boolean;
  activeSessions: number;
  pendingRequests: number;
  queuedRequests: number;
  activeLeases: number;
  protocolVersion: 2;
}

export interface BrokerRuntimeOptions {
  runtimeRoot?: string;
  socketPath?: string;
  authToken: string;
  extensionInput?: NodeJS.ReadableStream;
  extensionOutput?: NodeJS.WritableStream;
}

export class BrokerRuntime extends EventEmitter {
  private readonly sessions = new SessionRegistry({
    recoveryWindowMs: 30_000,
    idleTimeoutMs: 300_000,
    maxSessions: 32,
  });
  private readonly scheduler = new ResourceScheduler();
  private readonly leases = new LeaseManager();
  private readonly extension: ExtensionChannel;
  private readonly clients: ClientServer;
  private readonly router: RequestRouter;
  private runningValue = false;

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
    await this.clients.stop();
    this.extension.close();
  }

  health(): BrokerHealth {
    return {
      running: this.runningValue,
      extensionConnected: this.router.extensionReady,
      activeSessions: this.sessions.activeCount,
      pendingRequests: this.router.pendingCount,
      queuedRequests: this.scheduler.queuedCount,
      activeLeases: this.leases.activeCount,
      protocolVersion: PROTOCOL_VERSION,
    };
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
    this.clients.on(
      "message",
      (connection: ClientConnection, message) => {
        if (!connection.sessionId) {
          return;
        }
        this.router.handleClientMessage(
          connection.sessionId,
          message,
          (response) => this.clients.send(connection, response),
        );
      },
    );
    this.clients.on("disconnect", (sessionId: string) => {
      this.router.handleSessionDisconnect(sessionId);
    });
  }
}
