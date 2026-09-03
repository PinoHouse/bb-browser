import { randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, rm } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import {
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  SESSION_RECOVERY_CAPABILITY,
  createProtocolError,
  type ProtocolError,
  type BrokerToClientMessage,
  type ClientHello,
  type ClientToBrokerMessage,
} from "@bb-browser/shared";
import { SessionRegistry } from "./session-registry.js";

export interface ClientConnection {
  connectionId: string;
  socket: Socket;
  clientId?: string;
  sessionId?: string;
  recovery?: boolean;
  ending?: boolean;
}

export interface ClientServerOptions {
  runtimeRoot: string;
  socketPath: string;
  authToken: string;
  sessions: SessionRegistry;
  brokerInstanceId: string;
  cleanup: () => void;
}

export class ClientServer extends EventEmitter {
  private readonly connections = new Set<ClientConnection>();
  private server?: Server;
  private stopping = false;

  constructor(private readonly options: ClientServerOptions) {
    super();
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    await mkdir(this.options.runtimeRoot, { recursive: true, mode: 0o700 });
    await chmod(this.options.runtimeRoot, 0o700);
    if (await socketAcceptsConnections(this.options.socketPath)) {
      throw new Error("A bb-browser Broker is already using this socket");
    }
    await rm(this.options.socketPath, { force: true });

    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        server.off("listening", handleListening);
        reject(error);
      };
      const handleListening = () => {
        server.off("error", handleError);
        resolve();
      };
      server.once("error", handleError);
      server.once("listening", handleListening);
      server.listen(this.options.socketPath);
    });
    await chmod(this.options.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    for (const connection of this.connections) {
      connection.socket.destroy();
    }
    this.connections.clear();
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await rm(this.options.socketPath, { force: true });
  }

  send(connection: ClientConnection, message: BrokerToClientMessage): void {
    if (connection.socket.destroyed) {
      return;
    }
    connection.socket.write(Buffer.from(encodeFrame(message)));
  }

  end(connection: ClientConnection): void {
    connection.ending = true;
    if (
      connection.sessionId &&
      this.options.sessions.end(connection.sessionId, connection.connectionId)
    ) {
      this.emit("disconnect", connection.sessionId);
    }
    connection.socket.end();
  }

  private reject(connection: ClientConnection, error: ProtocolError): void {
    this.trace("connection_rejected", connection, error.code);
    connection.ending = true;
    if (connection.recovery) {
      this.send(connection, {
        kind: "connection.error",
        protocolVersion: PROTOCOL_VERSION,
        error,
      });
      connection.socket.end();
    } else {
      connection.socket.destroy();
    }
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    const connection: ClientConnection = {
      connectionId: randomUUID(),
      socket,
    };
    const decoder = new FrameDecoder();
    this.connections.add(connection);

    socket.on("data", (chunk) => {
      try {
        for (const value of decoder.push(chunk)) {
          if (connection.ending) {
            break;
          }
          if (!connection.sessionId) {
            this.authenticate(connection, value);
          } else {
            if (
              !this.options.sessions.ownsConnection(
                connection.sessionId,
                connection.connectionId,
              )
            ) {
              const error = createProtocolError(
                "session_expired",
                "queue",
                "连接会话已过期",
                { retryable: false },
              );
              const message = value as Partial<ClientToBrokerMessage>;
              if (
                "requestId" in message &&
                typeof message.requestId === "string"
              ) {
                this.send(connection, {
                  kind: "command.response",
                  protocolVersion: PROTOCOL_VERSION,
                  sessionId: connection.sessionId,
                  requestId: message.requestId,
                  success: false,
                  error,
                  timing: { queuedMs: 0, executionMs: 0 },
                });
              }
              this.reject(connection, error);
              break;
            }
            this.options.sessions.touch(connection.sessionId);
            this.emit("message", connection, value as ClientToBrokerMessage);
          }
        }
      } catch (error) {
        this.reject(
          connection,
          typeof error === "object" && error !== null && "code" in error
            ? (error as ProtocolError)
            : createProtocolError(
                "protocol_version_mismatch",
                "handshake",
                "无效的客户端消息",
                { retryable: false },
              ),
        );
      }
    });
    socket.on("error", () => {
      socket.destroy();
    });
    socket.on("close", () => {
      this.connections.delete(connection);
      if (
        connection.sessionId &&
        this.options.sessions.disconnect(
          connection.sessionId,
          connection.connectionId,
        )
      ) {
        this.trace("session_detached", connection);
        this.emit("disconnect", connection.sessionId);
      }
    });
  }

  private authenticate(connection: ClientConnection, value: unknown): void {
    const hello = value as Partial<ClientHello>;
    connection.recovery =
      Array.isArray(hello?.capabilities) &&
      hello.capabilities.includes(SESSION_RECOVERY_CAPABILITY);
    if (
      hello.kind !== "client.hello" ||
      hello.protocolVersion !== PROTOCOL_VERSION ||
      typeof hello.clientName !== "string" ||
      typeof hello.authToken !== "string" ||
      !tokensEqual(hello.authToken, this.options.authToken)
    ) {
      this.reject(
        connection,
        createProtocolError(
          hello.protocolVersion !== PROTOCOL_VERSION
            ? "protocol_version_mismatch"
            : "authentication_failed",
          "handshake",
          "客户端握手认证失败",
          { retryable: false },
        ),
      );
      return;
    }

    this.options.cleanup();
    let session =
      hello.resumeSessionId && hello.resumeClientId
        ? this.options.sessions.resume(
            hello.resumeSessionId,
            hello.resumeClientId,
            connection.connectionId,
          )
        : null;
    if (!session) {
      session = this.options.sessions.create(
        randomUUID(),
        connection.connectionId,
      );
    }
    connection.clientId = session.clientId;
    connection.sessionId = session.sessionId;
    this.send(connection, {
      kind: "session.ready",
      protocolVersion: PROTOCOL_VERSION,
      clientId: session.clientId,
      sessionId: session.sessionId,
      resumed: Boolean(
        hello.resumeSessionId && hello.resumeSessionId === session.sessionId,
      ),
      capabilities: [SESSION_RECOVERY_CAPABILITY],
      brokerInstanceId: this.options.brokerInstanceId,
    });
    this.emit("connect", connection);
    this.trace("session_connected", connection);
  }

  private trace(
    event: string,
    connection: ClientConnection,
    code?: string,
  ): void {
    process.stderr.write(
      JSON.stringify({
        event,
        at: new Date().toISOString(),
        brokerInstanceId: this.options.brokerInstanceId,
        connectionId: connection.connectionId,
        sessionId: connection.sessionId,
        code,
      }) + "\n",
    );
  }
}

function tokensEqual(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), 200);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
