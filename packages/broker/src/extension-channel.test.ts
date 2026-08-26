import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { encodeFrame, FrameDecoder } from "@bb-browser/shared";
import { ExtensionChannel } from "./extension-channel.js";

test("ExtensionChannel decodes split input and writes one native frame", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const channel = new ExtensionChannel({ input, output });
  channel.start();

  const hello = {
    kind: "extension.hello",
    protocolVersion: 2,
    extensionVersion: "0.11.0",
    capabilities: [],
  };
  const messagePromise = once(channel, "message");
  const frame = encodeFrame(hello);
  input.write(frame.slice(0, 2));
  input.write(frame.slice(2));
  assert.deepEqual((await messagePromise)[0], hello);
  assert.equal(channel.connected, true);

  const outputPromise = once(output, "data");
  channel.send({ kind: "heartbeat", protocolVersion: 2, sentAt: 1 });
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push((await outputPromise)[0]), [
    { kind: "heartbeat", protocolVersion: 2, sentAt: 1 },
  ]);
  channel.close();
});
