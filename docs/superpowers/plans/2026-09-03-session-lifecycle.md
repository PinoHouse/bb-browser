# Session Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent idle-session eviction, recover browser connections safely, and reclaim exited MCP processes.

**Architecture:** Preserve the existing native transport and protocol-v2 extension interface. Add negotiated Client/Broker lifecycle messages, a stable reconnecting client facade, and idempotent MCP shutdown. Never replay submitted browser operations.

**Tech Stack:** TypeScript, Node.js 20+, node:test/tsx, pnpm workspaces, Unix sockets, Chrome Native Messaging.

**Spec:** `docs/superpowers/specs/2026-09-03-session-lifecycle-design.md`

## Global Constraints

- No daemon, new browser backend, extension permissions, or automatic tab closure.
- Recovery capability: `session-recovery-v1`; protocolVersion remains 2.
- Connected sessions never expire for business inactivity; detached retention 120 seconds.
- Heartbeat 30 seconds, response grace 90 seconds; recovery wait <=10 seconds and original caller deadline.
- Never replay submitted requests, including safe_write; invalidate leases across every connection generation.
- Only broker worker edits packages/broker; main worker owns shared/client/mcp/sites/docs/release.
- Run one final full verification for the integrated diff, reuse focused worker evidence. Do not push remotely.

### Task 1: Protocol and Broker lifecycle

**Files:** `packages/shared/src/{protocol-v2,errors}.ts`, `packages/broker/src/{session-registry,client-server,broker-runtime,request-router}.ts`, associated `*.test.ts`.

**Interfaces:** Implement the exact message and health shapes in the spec. Retain existing SessionRegistry methods with optional connection identity parameters. Expose health and graceful close without dispatching browser actions.

- [x] Add protocol/error and regression tests. Core expectations:
  ```ts
  const registry = new SessionRegistry({ recoveryWindowMs: 120_000 });
  const first = registry.create("a");
  registry.expire(first.lastSeenAt + 1_800_000);
  assert.equal(registry.require(first.sessionId).connected, true);
  ```
- [x] Run `pnpm --filter @bb-browser/shared test` and targeted Broker regression tests; observe idle eviction failure.
- [x] Separate disconnect time/connection ownership from activity; centralize expiration and structured disconnects. Heartbeat and health bypass the browser scheduler.
- [x] Run Broker tests; integrate protocol/Broker changes into the cohesive fix commit.

### Task 2: Recovering Client and MCP lifecycle

**Files:** `packages/client/src/browser-client.ts`, new connection-manager/test modules as needed, `socket-transport.ts`, `packages/mcp/src/server.ts`, lifecycle tests and browser health tool.

**Interfaces:** Keep command/withTabLease/closeOwnedTabs, add lazy factory and health/connection state. Use single-flight ensureConnected, bounded waits, explicit session_reset, and transport-generation fencing.

- [x] Add failing real behavior tests for recovery, no replay, stale connection callbacks, deadlines, heartbeat and close. After socket close, assert the first submitted action fails but a later tab_list succeeds with exactly one new handshake.
- [x] Run `pnpm --filter @bb-browser/client test` and focused MCP tests to observe failures.
- [x] Implement stable facade and generation-bound pending/lease state. Every handshake failure closes its temporary socket. Capture recovery identity internally; do not replace SiteService's client reference.
- [x] Add idempotent shutdown on EOF/close/signals and a read-only browser_health tool. Test with memory streams and an isolated spawned MCP process; never the live browser.
- [x] Run focused Client/MCP tests; integrate with the cohesive fix commit.

### Task 3: Workflow integration, verification and deployment

**Files:** `packages/sites/src/{runner,service}.ts` and tests, lifecycle integration test(s), README, plugin manifest via official helper.

- [x] Add tests asserting site work fails on generation changes and releases only its original lease; close_owned_tabs fails after identity reset instead of claiming old tabs were cleaned.
- [x] Preserve explicit tab/context checks and surface session reset; no retry of entire adapters. Add fake-extension integration tests for Broker restart, retained identity, released leases and repeated client start/exit.
- [x] Review integrated diff for concrete race/isolation/no-replay risks. Address supported findings with scoped tests.
- [x] Run `pnpm test`, `pnpm lint`, plugin validator, and `git diff --check`; pnpm test includes package builds and release builds. Build the confirmed marketplace source after integration. Installer tests need no equivalent rerun without changes.
- [ ] Commit verified changes; bring them to the confirmed local marketplace source without overwriting user work. Use cachebuster helper and `codex plugin add bb-browser@pinohouse`; install Native Host with the existing installer.
- [ ] Verify installed artifact hashes and safe local MCP smoke. Inspect live workload before any Host restart; report any remaining activation boundary truthfully.

## Progress

- Design approved; isolated worktree created. No remote push requested.
- Execution uses one Broker worker and main Client/MCP worker, with fixed shared protocol. No duplicate implementation or full-suite runs.
- Integrated verification on 2026-09-03: `pnpm test` exit 0 (55 package tests + 3 launcher/installer tests), `pnpm lint` exit 0, plugin validator passed, `git diff --check` exit 0.
- Review findings fixed with focused RED/GREEN coverage: SDK cancellation propagation, original site deadline preservation, and late socket errors after close. Fake-clock sleep/wake coverage also passed.
- One cohesive fix commit replaces the initially suggested per-layer commits because capability negotiation requires the Client and Broker update together.
- Plugin release version: `0.11.0+codex.20260903120717`. Live Host activation is still pending; the old Host has no in-flight health endpoint, so it must not be interrupted blindly.
