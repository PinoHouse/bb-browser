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
  private closing = false;

  constructor(private readonly socket: Socket) {
    super();
    socket.on("data", (chunk) => {
      if (this.closing) return;
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
    socket.on("error", (error) => {
      if (!this.closing) this.emit("error", error);
    });
  }

  send(message: unknown): void {
    if (this.closing || this.socket.destroyed) {
      throw new Error("Broker socket is closed");
    }
    this.socket.write(Buffer.from(encodeFrame(message)));
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.socket.end();
    const timer = setTimeout(() => this.socket.destroy(), 100);
    timer.unref();
    this.socket.once("close", () => clearTimeout(timer));
  }
}

export async function connectSocketTransport(
  socketPath: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MessageTransport> {
  return new Promise<MessageTransport>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const handleError = (error: Error) => {
      socket.off("connect", handleConnect);
      cleanup();
      socket.destroy();
      reject(error);
    };
    const handleConnect = () => {
      socket.off("error", handleError);
      cleanup();
      resolve(new SocketTransport(socket));
    };
    socket.once("error", handleError);
    socket.once("connect", handleConnect);
    const abort = () => handleError(new Error("Connection cancelled"));
    const timer = setTimeout(
      () => handleError(new Error("Socket connection timed out")),
      options.timeoutMs ?? 5_000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
