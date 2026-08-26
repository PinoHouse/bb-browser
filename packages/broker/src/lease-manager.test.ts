import test from "node:test";
import assert from "node:assert/strict";
import type { ProtocolError } from "@bb-browser/shared";
import { LeaseManager } from "./lease-manager.js";

test("lease blocks other sessions and honors the deadline", async () => {
  const leases = new LeaseManager();
  const first = await leases.acquire("session-a", 9, Date.now() + 1_000);
  const waiting = leases.acquire("session-b", 9, Date.now() + 1_000);
  let resolved = false;
  void waiting.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, false);
  leases.release("session-a", first.leaseId);
  assert.equal((await waiting).tabId, 9);

  await assert.rejects(
    leases.acquire("session-c", 9, Date.now() - 1),
    (error: ProtocolError) => error.code === "tab_lease_timeout",
  );
});

test("an active lease requires the matching session and lease id", async () => {
  const leases = new LeaseManager();
  const lease = await leases.acquire("session-a", 9, Date.now() + 1_000);
  assert.doesNotThrow(() =>
    leases.assertAccess("session-a", 9, lease.leaseId),
  );
  assert.throws(
    () => leases.assertAccess("session-b", 9),
    (error: ProtocolError) => error.code === "tab_lease_timeout",
  );
});
