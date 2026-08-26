import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "./session-registry.js";

test("closeOwnedTabs returns only tabs created by the session", () => {
  const registry = new SessionRegistry({ recoveryWindowMs: 30_000 });
  const first = registry.create("client-a");
  const second = registry.create("client-b");
  registry.recordOwnedTab(first.sessionId, 101);
  registry.recordReference(first.sessionId, 202);
  registry.recordOwnedTab(second.sessionId, 303);
  assert.deepEqual(registry.ownedTabs(first.sessionId), [101]);
  assert.deepEqual(registry.ownedTabs(second.sessionId), [303]);
});

test("only the same disconnected client can resume inside the recovery window", () => {
  const registry = new SessionRegistry({ recoveryWindowMs: 30_000 });
  const session = registry.create("client-a");
  assert.equal(registry.resume(session.sessionId, "client-a"), null);
  registry.disconnect(session.sessionId);
  assert.equal(registry.resume(session.sessionId, "client-b"), null);
  assert.equal(
    registry.resume(session.sessionId, "client-a")?.sessionId,
    session.sessionId,
  );
});
