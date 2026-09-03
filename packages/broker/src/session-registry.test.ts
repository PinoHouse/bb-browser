import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "./session-registry.js";

test("connected sessions survive 30 minutes idle and new admission", () => {
  const registry = new SessionRegistry({ recoveryWindowMs: 120_000 });
  const session = registry.create("client-a");
  session.lastSeenAt -= 30 * 60_000;
  registry.create("client-b");
  assert.equal(registry.require(session.sessionId), session);
});

test("an obsolete connection cannot detach its replacement", () => {
  const registry = new SessionRegistry({ recoveryWindowMs: 120_000 });
  const session = registry.create("client-a", "old");
  registry.disconnect(session.sessionId, "old");
  assert.equal(registry.resume(session.sessionId, "client-a", "new"), session);
  assert.equal(registry.disconnect(session.sessionId, "old"), false);
  assert.equal(session.connected, true);
});

test("detached expiry starts at disconnect, not the last business request", () => {
  const registry = new SessionRegistry({ recoveryWindowMs: 120_000 });
  const session = registry.create("client-a");
  session.lastSeenAt -= 30 * 60_000;
  registry.disconnect(session.sessionId);
  assert.deepEqual(registry.expire(session.lastSeenAt + 119_999), []);
  assert.deepEqual(registry.expire(session.lastSeenAt + 120_000), [session]);
});

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
