import { EventEmitter } from "node:events";
import {
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  type BrokerToExtensionMessage,
  type ExtensionToBrokerMessage,
} from "@bb-browser/shared";

export class ExtensionChannel extends EventEmitter {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly decoder = new FrameDecoder();
  private started = false;
  private connectedValue = false;

  constructor(options: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  } = {}) {
    super();
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.input.on("data", this.handleData);
    this.input.on("end", this.handleClosed);
    this.input.on("close", this.handleClosed);
    this.input.on("error", this.handleError);
  }

  send(message: BrokerToExtensionMessage): void {
    if (!this.started) {
      throw new Error("Extension channel has not started");
    }
    this.output.write(Buffer.from(encodeFrame(message)));
  }

  close(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.input.off("data", this.handleData);
    this.input.off("end", this.handleClosed);
    this.input.off("close", this.handleClosed);
    this.input.off("error", this.handleError);
    this.markDisconnected();
  }

  get connected(): boolean {
    return this.connectedValue;
  }

  private readonly handleData = (chunk: Uint8Array): void => {
    try {
      for (const value of this.decoder.push(chunk)) {
        const message = value as ExtensionToBrokerMessage;
        if (
          message.kind === "extension.hello" &&
          message.protocolVersion === PROTOCOL_VERSION
        ) {
          this.connectedValue = true;
        }
        this.emit("message", message);
      }
    } catch (error) {
      this.emit(
        "error",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };

  private readonly handleClosed = (): void => {
    this.markDisconnected();
    this.emit("closed");
  };

  private readonly handleError = (error: Error): void => {
    this.emit("error", error);
  };

  private markDisconnected(): void {
    if (!this.connectedValue) {
      return;
    }
    this.connectedValue = false;
    this.emit("disconnect");
  }
}
