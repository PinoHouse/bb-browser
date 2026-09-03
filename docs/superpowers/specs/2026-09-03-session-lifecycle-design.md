# Recoverable browser sessions

Approved in conversation on 2026-09-03. Keep Plugin -> Client -> Native Broker -> Chrome; no daemon or additional extension permission.

## Invariants

- Connected sessions do not expire from business inactivity. Detached sessions expire 120 seconds after disconnection. Periodic cleanup uses the same path as admission cleanup. Capacity exhaustion is explicit, never eviction of a live session.
- Socket ownership is connection-scoped. An obsolete socket cannot detach a replacement. Cleanup removes pending queue work and lease waiters, but never automatically closes browser tabs. In-flight work retains scheduler exclusion until cancellation completes or the execution deadline.
- Each MCP process owns one stable BrowserClient facade. It connects lazily, coalesces concurrent reconnect attempts, and resumes the prior identity where possible. New sessions are surfaced as session_reset, not silent continuity.
- A request waits at most 10 seconds for recovery and never past its original deadline or cancellation. Reconnect delays start immediately, then 500/1000/2000/4000 ms with bounded jitter. Requests already handed to transport are never automatically replayed, including safe_write.
- Leases are bound to a connection generation. Disconnection invalidates them even if session resume succeeds. A site workflow interrupted between steps cannot continue under a replaced connection.
- Heartbeats are Client/Broker control messages every 30 seconds. A sent probe without acknowledgement for 90 seconds closes the connection. A delayed timer after sleep starts a fresh probe, rather than declaring failure from an old scheduling timestamp.
- stdin EOF/close, MCP transport close, SIGTERM and SIGINT share idempotent shutdown: cancel reconnect, clear heartbeat/deadline resources, fail pending requests, close socket. No automatic browser tab closure.
- No full browser payloads, auth tokens, URLs or titles in lifecycle logs. Diagnostics expose connection state, last failure, reconnect count, identities, counts and Broker instance/version only.

## Client/Broker protocol extensions (protocol v2 retained)

`ClientHello.capabilities?: string[]`; `SessionReady.capabilities?: string[]`, `brokerInstanceId?: string`. Capability `session-recovery-v1` enables structured connection errors, heartbeat replies, graceful session end and health. Old extension command messages remain unchanged. New recovery clients reject Brokers lacking this capability with protocol_version_mismatch; old clients may still use the upgraded Broker.

`connection.error {kind, protocolVersion, error: ProtocolError}` preserves the disconnect reason, including authentication, expired session and capacity errors. Valid rejected requests receive command.response before orderly closure where applicable.

`session.end {kind, protocolVersion, sessionId}` expires only the caller's session and closes its socket. `session.health {kind, protocolVersion, sessionId, requestId}` returns `session.health.result {kind, protocolVersion, sessionId, requestId, health}`. Health contains running, extensionConnected, activeSessions, detachedSessions, connections, pendingRequests, queuedRequests, activeLeases, protocolVersion and brokerInstanceId. Heartbeat replies echo sentAt.

## Scope and release

Update packages/shared, broker, client, mcp, sites and focused tests; preserve extension operations and external tools. Add browser_health diagnostics. Release via the existing local pinohouse marketplace cachebuster helper, build/install Native Host, then verify installed hashes. No remote push is implied. Never interrupt unrelated active browser work for installation; first deployment may require rebuilding old MCP instances.

## Acceptance

Fake-clock 30-minute idle plus new clients preserves old sessions; EOF ends real MCP children; concurrent recovery makes one connection; old-close race cannot detach a resumed session; response loss does not repeat clicks or tab creation; lease generation/reset protection holds; Broker restart recovers later calls; sleep-like clock jumps do not misclassify a fresh probe; incompatible Broker and capacity errors are explicit; repeated start/exit leaves no connection growth.
