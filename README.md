# bb-browser

bb-browser is a Codex Plugin that lets agents use your real, signed-in Chrome through structured MCP tools and site adapters. It is maintained as an independent PinoHouse project.

The browser execution path is local and session-safe: there is no browser CLI, background TCP daemon, SSE bridge, or separate automation browser.

## What it provides

- Browser tools for tabs, snapshots, interactions, JavaScript, screenshots, and network inspection.
- Structured site adapters that run inside your authenticated Chrome context.
- Per-task sessions, explicit tab ownership, fair per-tab queues, leases, deadlines, and cancellation.
- A Chrome Native Messaging Host with a local authenticated Unix socket for multiple Codex tasks.

## Architecture

```text
Codex task
  │ Plugin MCP adapter (stdio)
  ▼
BrowserClient SDK
  │ authenticated Unix socket
  ▼
Native Broker Host
  │ Chrome Native Messaging
  ▼
bb-browser Chrome extension
  │ chrome.debugger / Chrome APIs
  ▼
Your signed-in Chrome
```

Each Codex task gets its own session. Commands targeting the same tab are serialized; independent tabs can progress concurrently. A task can close only tabs owned by its session.

## Requirements

- macOS
- Node.js 20 or newer
- pnpm 9
- Google Chrome with Developer mode enabled
- Codex desktop/CLI with Plugin support

## Quick start

Run from the repository root:

```bash
pnpm install
pnpm build
pnpm install:native-host
```

Then install the Chrome extension once:

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select `packages/extension/dist`.
4. Verify the extension ID is `ncpkoaiijcnacllhjjjfonmbhflmbnii`.

Add this repository as the PinoHouse marketplace and install the Plugin:

```bash
codex plugin marketplace add "$(pwd)" --json
codex plugin add bb-browser@pinohouse --json
```

Restart Codex once, then start a new task so the installed Skill and MCP tools are loaded.

## Using the Plugin

Agents call the Plugin-provided `mcp__bb_browser__*` tools directly. The normal workflow is:

1. List tabs or open a new tab and record its ID.
2. Pass that tab ID to snapshots, reads, and interactions.
3. Refresh the snapshot after navigation or dynamic page changes.
4. Close only tabs opened by the current task.

Tool groups:

- Diagnostics: `browser_health` reports Client/Broker/extension state without opening tabs or running page scripts.
- Browser: `browser_tab_list`, `browser_open`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_eval`, `browser_network`, `browser_screenshot`, `browser_close`.
- Frames: `browser_frame` enters an iframe by CSS selector; `browser_frame_main` returns to the top document. Re-snapshot after switching.
- Site adapters: `site_list`, `site_search`, `site_info`, `site_recommend`, `site_run`, `site_update`.

`site_run` is the only supported adapter execution path. Adapter execution is capped by an operation deadline; Radar adapters may use up to 120 seconds.

## Session recovery

Connected sessions no longer expire because browser operations are idle. Detached sessions retain their identity and tab ownership for 120 seconds. The SDK establishes connections lazily, coalesces concurrent recovery attempts, and spends at most 10 seconds of the caller's original deadline on recovery. Heartbeats run every 30 seconds with a 90-second response grace period.

Submitted operations are **never automatically replayed**, including `safe_write`, clicks, new tabs and entire adapters. An interrupted request can return `result_unknown_after_disconnect`; a later independent request can use a recovered connection. Every reconnect invalidates old leases. When resume fails, `session_reset` requires fresh page/context checks; historical tab ownership is not reconstructed from domains, and bulk cleanup will not claim those old tabs were closed.

MCP stdin EOF, transport close and termination signals shut down the client and its timers. Session teardown does not automatically close browser tabs. Broker lifecycle events on stderr contain connection/session identifiers and error codes, never credentials or browser payloads.

This requires the `session-recovery-v1` capability in the installed Native Host. Updating source files alone does not upgrade running processes: build both bundles, reinstall the Plugin and Native Host, then recreate old MCP instances and restart the old Native Host at an idle boundary. Chrome permissions and extension command protocol are unchanged. Subsequent Broker replacements can be recovered by the updated Client, subject to the state/reset rules above.

For isolated development/tests, `BB_BROWSER_SOCKET_PATH` overrides the socket and `BB_BROWSER_CONFIG_ROOT` overrides the directory containing `auth-token`. Production defaults remain unchanged.

## Runtime files

`pnpm install:native-host` installs only user-level files:

```text
~/Library/Application Support/bb-browser/
  auth-token                         mode 0600
  native-host/
    native-host.js
    bb-browser-native-host           executable launcher

~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
  com.pinix.bb_browser.json

/tmp/bb-browser-<uid>/
  broker.sock                        mode 0600 while running
```

The Native Messaging manifest accepts only the fixed extension origin shown in Quick start. Protocol logs go to stderr and do not include browser payloads or the auth token.

## Updating

After pulling changes:

```bash
pnpm install
pnpm build
pnpm install:native-host
codex plugin add bb-browser@pinohouse --json
```

Reload the unpacked extension if its files changed, then open a new Codex task. Reinstalling preserves the existing authentication token and atomically replaces the host bundle and manifest.

## Migration from 0.10

- `BB_VIA_EXTENSION` is removed; browser work always uses the Plugin MCP adapter.
- `BB_DAEMON_HOST` and `BB_DAEMON_PORT` are removed. Use `BB_BROWSER_SOCKET_PATH` only when intentionally overriding the local Unix socket for development.
- The previous fixed 60-second transport timeout is replaced by per-operation deadlines. Radar adapter calls may use 120 seconds.
- The browser CLI, OpenClaw transport, TCP port 19824, HTTP command/result routes, and SSE transport are no longer supported.

## Development

```bash
pnpm test
pnpm build
pnpm test:native-host-install
```

The main packages are:

- `packages/shared`: browser data types, v2 protocol, errors, and framing.
- `packages/client`: authenticated Broker client SDK.
- `packages/broker`: Native Host, sessions, queues, leases, and routing.
- `packages/extension`: Chrome Native Messaging client and browser command handler.
- `packages/sites`: adapter registry and runner.
- `packages/mcp`: thin Codex MCP adapter.

## Uninstall

```bash
pnpm uninstall:native-host
codex plugin remove bb-browser@pinohouse --json
```

Remove the unpacked extension from `chrome://extensions/` if it is no longer needed.

## License

[MIT](LICENSE)
