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
}

export interface ClientServerOptions {
  runtimeRoot: string;
  socketPath: string;
  authToken: string;
  sessions: SessionRegistry;
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
          if (!connection.sessionId) {
            this.authenticate(connection, value);
          } else {
            this.options.sessions.touch(connection.sessionId);
            this.emit(
              "message",
              connection,
              value as ClientToBrokerMessage,
            );
          }
        }
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => {
      socket.destroy();
    });
    socket.on("close", () => {
      this.connections.delete(connection);
      if (connection.sessionId) {
        this.options.sessions.disconnect(connection.sessionId);
        this.emit("disconnect", connection.sessionId);
      }
    });
  }

  private authenticate(connection: ClientConnection, value: unknown): void {
    const hello = value as Partial<ClientHello>;
    if (
      hello.kind !== "client.hello" ||
      hello.protocolVersion !== PROTOCOL_VERSION ||
      typeof hello.clientName !== "string" ||
      typeof hello.authToken !== "string" ||
      !tokensEqual(hello.authToken, this.options.authToken)
    ) {
      connection.socket.destroy();
      return;
    }

    let session =
      hello.resumeSessionId && hello.resumeClientId
        ? this.options.sessions.resume(
            hello.resumeSessionId,
            hello.resumeClientId,
          )
        : null;
    if (!session) {
      session = this.options.sessions.create(randomUUID());
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
    });
    this.emit("connect", connection);
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
