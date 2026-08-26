# bb-browser Agent Guidelines

## Architecture

```text
Codex Plugin MCP Adapter (packages/mcp)
  │ authenticated Unix socket
  ▼
Native Broker Host (packages/broker)
  │ Chrome Native Messaging
  ▼
Chrome Extension (packages/extension)
  │ chrome.debugger / Chrome APIs
  ▼
User's signed-in Chrome
```

Supporting packages:

- `packages/shared`: browser request/response types, protocol v2, structured errors, and frame codec.
- `packages/client`: session-aware BrowserClient SDK.
- `packages/sites`: adapter registry, argument mapping, diagnostics, and leased runner.

There is no browser CLI, TCP daemon, HTTP command/result endpoint, SSE transport, OpenClaw transport, or alternate browser backend. Do not reintroduce one as a fallback.

## Adding a browser action

Most actions require changes in three layers:

1. `packages/shared/src/protocol.ts` — action and browser data types.
2. `packages/extension/src/background/command-handler.ts` — Chrome implementation and abort behavior.
3. `packages/mcp/src/browser-tools.ts` — MCP schema, deadline, idempotency, and result mapping.

Add focused tests in the changed packages. The Broker router is action-agnostic; change it only when ownership, scheduling, lease, cancellation, or retry semantics change.

## Site adapters

- Adapter metadata and execution belong in `packages/sites`.
- `site_run` is the only normal adapter execution path.
- Use explicit tab IDs and a per-tab lease for multi-step adapter work.
- Local adapter overrides must remain diagnostics-visible and must not silently shadow a broken community adapter.
- Radar execution may use a 120-second deadline; do not increase the global browser deadline to accommodate it.

## Session and tab safety

- Every MCP process owns one Broker session.
- Pass explicit tab IDs whenever tasks may overlap.
- Record tabs created by the session and close only those tabs.
- Never close a pre-existing tab because its domain matches an adapter.
- Keep same-tab operations serialized; preserve cross-tab concurrency and round-robin fairness between sessions.
- Propagate cancellation and check deadlines before queueing and again before extension dispatch.

## Error contract

All execution failures use a structured `ProtocolError` with `code`, `phase`, `message`, `retryable`, and optional details.

- `broker_unavailable` and `extension_disconnected` are global infrastructure failures.
- `adapter_execution_failed` and `request_deadline_exceeded` are item-scoped unless a lightweight browser health probe also fails.
- After a confirmed global failure, stop the batch and mark later items skipped rather than fabricating per-item failures.
- Never expose auth tokens or full browser payloads in logs.

## Plugin and Native Host

- `.codex-plugin/plugin.json` and `.mcp.json` define the Codex Plugin.
- `.agents/plugins/marketplace.json` defines the repository-local PinoHouse marketplace.
- `scripts/install-native-host.mjs` installs atomically under the user's Application Support directory.
- The Native Messaging host name is `com.pinix.bb_browser`.
- The fixed unpacked extension ID is `ncpkoaiijcnacllhjjjfonmbhflmbnii`.
- Keep the application directory at mode 0700, auth token/socket at 0600, and launcher at 0755.

## Verification

Run from the repository root:

```bash
pnpm test
pnpm build
pnpm test:native-host-install
python3 /Users/lawrance/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
git diff --check
```

Tests must mock external websites and Chrome where possible. Real Chrome acceptance belongs in the explicit smoke scripts and must use the installed bb-browser Plugin path.

## Code conventions

- Commit messages: `<type>(<scope>): <summary>` in English.
- TypeScript comments and identifiers in English; concise Chinese user-facing errors are acceptable.
- Preserve protocol compatibility tests whenever message shapes change.
- Do not log to stdout from the Native Host; stdout is reserved for Chrome Native Messaging frames.
