import test from "node:test";
import assert from "node:assert/strict";
import { quadCenter } from "./cdp-dom-service.js";

test("quadCenter averages the four corners of a content quad", () => {
  // A 100x40 box at (10,20): corners (10,20)(110,20)(110,60)(10,60).
  assert.deepEqual(quadCenter([10, 20, 110, 20, 110, 60, 10, 60]), { x: 60, y: 40 });
  assert.equal(quadCenter(undefined), null);
  assert.equal(quadCenter([1, 2, 3]), null);
});
