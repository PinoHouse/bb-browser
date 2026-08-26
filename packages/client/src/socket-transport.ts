import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "@bb-browser/shared";

export interface MessageTransport {
  send(message: unknown): void;
  close(): void;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  off(event: "message", listener: (message: unknown) => void): this;
  off(event: "close", listener: () => void): this;
  off(event: "error", listener: (error: Error) => void): this;
}

export class SocketTransport extends EventEmitter implements MessageTransport {
  private readonly decoder = new FrameDecoder();

  constructor(private readonly socket: Socket) {
    super();
    socket.on("data", (chunk) => {
      try {
        for (const message of this.decoder.push(chunk)) {
          this.emit("message", message);
        }
      } catch (error) {
        this.emit(
          "error",
          error instanceof Error ? error : new Error(String(error)),
        );
        this.socket.destroy();
      }
    });
    socket.on("close", () => this.emit("close"));
    socket.on("error", (error) => this.emit("error", error));
  }

  send(message: unknown): void {
    if (this.socket.destroyed) {
      throw new Error("Broker socket is closed");
    }
    this.socket.write(Buffer.from(encodeFrame(message)));
  }

  close(): void {
    this.socket.destroy();
  }
}

export async function connectSocketTransport(
  socketPath: string,
): Promise<MessageTransport> {
  return new Promise<MessageTransport>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const handleError = (error: Error) => {
      socket.off("connect", handleConnect);
      socket.destroy();
      reject(error);
    };
    const handleConnect = () => {
      socket.off("error", handleError);
      resolve(new SocketTransport(socket));
    };
    socket.once("error", handleError);
    socket.once("connect", handleConnect);
  });
}
