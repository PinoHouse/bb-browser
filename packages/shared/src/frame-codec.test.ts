import test from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FrameDecoder } from "./index.js";

test("FrameDecoder handles split and coalesced frames", () => {
  const first = encodeFrame({ kind: "heartbeat", sentAt: 1 });
  const second = encodeFrame({ kind: "heartbeat", sentAt: 2 });
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(first.slice(0, 3)), []);
  assert.deepEqual(
    decoder.push(new Uint8Array([...first.slice(3), ...second])),
    [
      { kind: "heartbeat", sentAt: 1 },
      { kind: "heartbeat", sentAt: 2 },
    ],
  );
});
