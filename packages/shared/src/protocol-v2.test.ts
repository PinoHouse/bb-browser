import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  createProtocolError,
  isRetryableBeforeDispatch,
} from "./index.js";

test("protocol exposes stable version and typed error shape", () => {
  assert.equal(PROTOCOL_VERSION, 2);
  assert.deepEqual(
    createProtocolError("extension_disconnected", "dispatch", "Chrome 扩展未连接"),
    {
      code: "extension_disconnected",
      phase: "dispatch",
      retryable: true,
      error: "Chrome 扩展未连接",
      hint: "请确认 Chrome 已运行且 bb-browser 扩展已启用",
      action: null,
    },
  );
});

test("only undispatched idempotent operations are automatically retryable", () => {
  assert.equal(isRetryableBeforeDispatch("read"), true);
  assert.equal(isRetryableBeforeDispatch("safe_write"), true);
  assert.equal(isRetryableBeforeDispatch("unsafe_write"), false);
});
