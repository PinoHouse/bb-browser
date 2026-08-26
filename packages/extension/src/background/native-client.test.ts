import test from "node:test";
import assert from "node:assert/strict";
import type { ActionType, CommandRequest } from "@bb-browser/shared";
import { NativeClient } from "./native-client.js";

class Listener<T extends (...args: never[]) => void> {
  private readonly handlers: T[] = [];

  addListener(handler: T): void {
    this.handlers.push(handler);
  }

  emit(...args: Parameters<T>): void {
    for (const handler of this.handlers) {
      handler(...args);
    }
  }
}

class FakeNativePort {
  sent: unknown[] = [];
  onMessage = new Listener<(message: unknown) => void>();
  onDisconnect = new Listener<() => void>();

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  disconnect(): void {
    this.onDisconnect.emit();
  }

  receive(message: unknown): void {
    this.onMessage.emit(message);
  }

  async flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function commandRequest(
  requestId: string,
  action: ActionType,
): CommandRequest {
  return {
    kind: "command.request",
    protocolVersion: 2,
    requestId,
    clientId: "client-1",
    sessionId: "session-1",
    action,
    deadlineAt: Date.now() + 1_000,
    idempotency: "read",
    payload: {},
  };
}

test("NativeClient sends hello and returns command results", async () => {
  const port = new FakeNativePort();
  const client = new NativeClient({
    connectNative: () => port,
    extensionVersion: "0.11.0",
    handleCommand: async (command) => ({
      id: command.requestId,
      success: true,
      data: { title: "ok" },
    }),
  });
  client.connect();
  assert.equal((port.sent[0] as { kind: string }).kind, "extension.hello");
  port.receive(commandRequest("request-1", "tab_list"));
  await port.flush();
  assert.equal((port.sent[1] as { kind: string }).kind, "command.response");
  assert.equal(
    (port.sent[1] as { requestId: string }).requestId,
    "request-1",
  );
});

test("disconnect schedules one reconnect and connect is idempotent", () => {
  const ports: FakeNativePort[] = [];
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const client = new NativeClient({
    connectNative: () => {
      const port = new FakeNativePort();
      ports.push(port);
      return port;
    },
    extensionVersion: "0.11.0",
    handleCommand: async (command) => ({
      id: command.requestId,
      success: true,
    }),
    scheduleReconnect: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
  });
  client.connect();
  client.connect();
  assert.equal(ports.length, 1);
  ports[0].disconnect();
  ports[0].disconnect();
  assert.deepEqual(scheduled.map((item) => item.delay), [1_000]);
  scheduled[0].callback();
  assert.equal(ports.length, 2);
});
