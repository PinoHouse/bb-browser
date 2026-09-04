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

## Autofilled login forms

Browser-painted credentials may not yet be committed to the page's form state.
Use snapshot metadata without reading credentials: `[value=empty|present|unknown]`,
`[autofill]` when detected, `[readonly]`, and explicit button `[enabled]`,
`[disabled]`, or `[disabled=unknown]`. `present` does not prove the intended account
or successful authentication; unknown or missing state is neither empty nor enabled.

1. Establish the task's authorized site/account scope and explicit tab; technical
   ability to log in is not authorization. If the expected authenticated page is
   already visible, continue the task without submitting a login form.
2. Hand CAPTCHA, 2FA, system unlock, account checkpoints, and account ambiguity to
   the user. If login is outside the task's authorization, ask for direction rather
   than submitting. State the concrete unresolved condition, not a guessed login
   outcome.
3. On an ordinary form that appears prefilled but not activated, click one freshly
   located non-submit control, such as the email field, **once**. Wait briefly with
   a bounded `browser_wait`, then take a fresh snapshot on the same tab. This is
   activation, not permission to submit; a diagnostic-only task stops here.
4. Submit **once**, only within an already authorized login task, with the intended
   site/account unambiguous, all required login fields `[value=present]`, and the
   submit control explicitly `[enabled]`. Empty/unknown fields or disabled/unknown
   controls do not meet that gate. If the single activation does not make the form
   ready, hand off to the user; do not repeat it.
5. Verify the expected authenticated page or result. A successful click is not a
   successful login. After a submit timeout, disconnect, or indeterminate result,
   retain **unknown** and never replay the submission. Reinspect after page or
   connection changes before deciding what is known; a new snapshot does not reset
   the one-submit budget.

Do not read, display, or log credential values, lengths, hashes, password-store
contents, cookies, tokens, or login request/response bodies. Do not use `fill`/`type`
to clear or re-enter saved passwords, inspect framework internals, blind double-click,
replay login requests, or use JavaScript submission to bypass disabled controls.
A disabled-element click error is a stop-and-reinspect signal, not an automatic retry.

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
- Frames: `browser_frame` (enter an iframe by CSS selector), `browser_frame_main` (return to the top document); re-snapshot after switching
- Advanced: `browser_eval`, `browser_network`
- Cleanup: `browser_close`, `browser_close_all`
- Adapters: `site_list`, `site_search`, `site_info`, `site_recommend`, `site_run`, `site_update`

## Common mistakes

- Omitting `tab` after opening several tabs causes work to target whichever tab Chrome considers active.
- Reusing refs after navigation causes stale-element failures; snapshot again.
- Retrying `broker_unavailable` per symbol amplifies a global outage; stop the batch once the health probe confirms it.
