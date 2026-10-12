# GS Code Debugger: design notes

Goal: a Tag Assistant–style debugger inside VS Code for web and server GTM containers, that an AI agent
can drive (reproduce → trace to the mirror file → edit → push to the workspace → re-test).
Hard constraint: **free**. No paid APIs, no billing-enabled Google Cloud features, no hosted servers,
no LLM calls from the extension (agents bring their own model through MCP / VS Code language-model tools).

## Web containers

Verified building blocks:
- **Draft preview without publishing.** Tag Manager API v2 environments have `type: workspace` with
  `authorizationCode` + `environmentId` (+ `workspaceId`). `workspaces.quick_preview` compiles the
  workspace (also a free compile check: `compilerError`). The draft loads with
  `gtm.js?id=GTM-XXX&gtm_auth=<authorizationCode>&gtm_preview=env-<N>`.
- **Forcing a live site onto the draft:** CDP `Fetch.enable` on the gtm.js URL pattern, then
  `Fetch.continueRequest` with the rewritten URL (not observable by the page). Custom loaders (e.g. Stape)
  serve gtm.js from first-party paths, so the pattern is configurable.
- **No Tag Assistant / `gtm_debug`.** Its postMessage protocol is undocumented; we never depend on it.
- **Runtime introspection** (injected with `Page.addScriptToEvaluateOnNewDocument`, reported back through
  `Runtime.addBinding`):
  - wrap `dataLayer.push`, record each push with `gtm.uniqueEventId`;
  - `google_tag_manager['GTM-XXX'].dataLayer.get(key)` for the data model after each event;
  - `eventCallback(containerId, eventData)`: when `eventData.tags[]` is present it gives tag id + status
    (`success` / `failure` / `exception` / `timeout`) + execution time (to be verified live);
  - consent: `google_tag_data.ics.entries[type].{default,update}` (undocumented, read-only) cross-checked
    with `gcs` / `gcd` on GA4 hits and `consent` commands in the dataLayer.
- **Network hits:** CDP `Network.requestWillBeSent` (covers `sendBeacon`), classified: GA4 `/g/collect`,
  Google Ads, Meta `/tr`, Bing `bat.bing.com`, Criteo, and the sGTM host.
- **Why a tag did not fire:** not exposed anywhere. GS Code evaluates the mirror's trigger files against the
  captured event + data-model snapshot and points at the exact file and condition.
- **Browser:** `puppeteer-core` (no bundled Chromium), launching the user's Chrome/Edge with a dedicated
  profile dir (Chrome 136+ ignores `--remote-debugging-port` on the default profile), or connecting to any
  Chromium that already exposes CDP (`browserURL`). Headful by default.

## Server containers

There is no public API for sGTM preview results (tags fired, outgoing requests). Free, phased:
1. Browser-side capture of every request to the sGTM host (method, path, body, status, Set-Cookie,
   response), plus a static *prediction* of which client claims it from the mirrored client files.
2. "Replay with preview header": the user pastes `X-Gtm-Server-Preview` from Tag Assistant
   (base64 of `gtm_debug|gtm_preview|gtm_auth`, per session); GS Code replays captured requests so they
   show in the user's own Tag Assistant.
3. Opt-in local runtime: the official `gtm-cloud-image` in Docker with `CONTAINER_CONFIG`
   (+ `RUN_AS_PREVIEW_SERVER`), egress through a local proxy to record outgoing vendor requests, and
   `docker logs` for `logToConsole`. Use test ids or block egress: a local sGTM sends real hits.
4. Experimental, off by default: the preview server's undocumented debug endpoints.

Cloud Run logs need a billing account, and Stape logs are a paid feature: both are out.

## Agent tools (MCP `gscode mcp` + VS Code language-model tools)

`debug_start(url)`, `debug_events()`, `debug_event(id)` (data model, consent, tags, hits),
`debug_explain_tag(tag, eventId)` (trigger evaluation against the mirror files), `debug_hits(filter)`,
`debug_reload()`, `debug_stop()`, plus the existing mirror operations (`status`, `push`).
