---
name: bb-browser
description: Use when a task requires the user's real signed-in Chrome, authenticated pages, browser interaction, screenshots, browser-context fetches, or structured site adapters.
---

# bb-browser

## Overview

Use the installed bb-browser Plugin MCP to control the user's existing Chrome session. Keep every operation bound to an explicit tab and preserve tabs that belong to the user or another task.

## Tool boundary

- Use only `mcp__bb_browser__*` tools for browser work.
- Never run the `bb-browser` CLI, `bb-browser daemon`, `npx bb-browser`, Playwright, CDP scripts, or another browser MCP as a fallback.
- Do not start a background service or change global Codex/Chrome configuration during a browser task.
- If the Plugin tools are unavailable, report that the bb-browser Plugin is unavailable; do not substitute another transport.

## Browser workflow

1. Call `browser_tab_list` and identify the target tab, or call `browser_open`/`browser_tab_new` and record the returned tab ID.
2. Pass `tab` on snapshots, reads, interactions, JavaScript, network inspection, screenshots, waits, and closes whenever a workflow can overlap another task.
3. After navigation or dynamic changes, take a fresh `browser_snapshot`; element refs are temporary.
4. Close only tabs created by this session. Prefer `browser_close` with the recorded tab ID. `browser_close_all` closes only this MCP session's owned tabs.

Never close a pre-existing tab merely because it matches the requested domain.

## Site adapters

Use `site_search` or `site_info` to discover arguments, then use `site_run` for normal adapter execution. Do not translate a site adapter call into a CLI command. Pass `tab` when reusing an explicitly selected tab; the Plugin holds a per-tab lease during the adapter run.

`site_list` proves only that local adapter metadata can be read. It is not a browser-transport health check.

## Error contract

| Error code | Scope | Action |
|---|---|---|
| `broker_unavailable` | Global infrastructure | Stop browser work and report the Broker failure. |
| `extension_disconnected` | Global infrastructure | Stop browser work and ask for the installed Chrome extension connection to be restored. |
| `broker_capacity_exceeded` | Current session | The session limit or this session's queue is full. Wait for in-flight requests, then retry; do not stop the batch. |
| `adapter_execution_failed` | Current adapter item | Record the item failure and continue independent items. |
| `request_deadline_exceeded` | Current request | Record the timeout and continue independent items. |

Treat an item-scoped error as global only when a lightweight `browser_tab_list` probe also returns an infrastructure error. Do not mark unattempted items as failed: if infrastructure is globally unavailable, mark them skipped after the global failure.

## Quick reference

- Inspect: `browser_tab_list`, `browser_snapshot`, `browser_get`, `browser_screenshot`
- Act: `browser_open`, `browser_click`, `browser_fill`, `browser_type`, `browser_press`, `browser_scroll`, `browser_hover`, `browser_wait`
- Advanced: `browser_eval`, `browser_network`
- Cleanup: `browser_close`, `browser_close_all`
- Adapters: `site_list`, `site_search`, `site_info`, `site_recommend`, `site_run`, `site_update`

## Common mistakes

- Omitting `tab` after opening several tabs causes work to target whichever tab Chrome considers active.
- Reusing refs after navigation causes stale-element failures; snapshot again.
- Retrying `broker_unavailable` per symbol amplifies a global outage; stop the batch once the health probe confirms it.
