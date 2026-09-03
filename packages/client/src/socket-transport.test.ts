import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { SocketTransport } from "./socket-transport.js";

test("late socket errors after transport closure cannot crash an exited MCP client", () => {
  class ClosingSocket extends EventEmitter {
    destroyed = false;
    end() {}
    destroy() {
      this.destroyed = true;
      this.emit("close");
    }
  }
  const socket = new ClosingSocket();
  const transport = new SocketTransport(socket as unknown as Socket);
  transport.close();
  assert.doesNotThrow(() => socket.emit("error", new Error("EPIPE")));
  socket.destroy();
});
