# Debugger

The GS Code debugger records what GTM does on a real page: every dataLayer event, the data model after it, each tag's status, consent state and every measurement hit. For each tag it also works out **why** it fired or not, from the files in your mirror, and points at the file and condition that decided it.

It runs in three places, all on the same engine:

- the **GS Code: Open Debugger** panel in VS Code;
- the CLI: `gscode debug`, `gscode explain`, `gscode replay-sgtm`, `gscode sgtm-local`;
- AI agents, through the MCP server (`gscode mcp`) or the VS Code language-model tools (Copilot agent mode).

Everything is free and local. GS Code drives a browser you already have over the Chrome DevTools Protocol, uses the Tag Manager API you already use for the mirror, and never calls a paid service. It does not use Tag Assistant or `gtm_debug`.

## Modes

| Mode | What the page loads | How |
| --- | --- | --- |
| **Workspace draft** (default) | Your *unpublished* workspace, as it is in GTM right now | GS Code compiles the workspace with `quick_preview` (nothing is published), reads the workspace's preview environment, and rewrites the page's `gtm.js` request to carry its `gtm_auth` and `gtm_preview=env-N`. |
| **Live** | The published container | Nothing is rewritten. |

Workspace mode shows what is **in the GTM workspace**, not your unpushed files. Edit, push, then press **Reload**: the draft picks up the change.

Details of workspace mode:

- Only `https://www.googletagmanager.com/gtm.js` and `https://googletagmanager.com/gtm.js` requests for the mirror's own container id are rewritten. Look-alike hosts and plain http are never given the preview credentials. Other containers on the page load as published.
- The rewritten URL keeps only `id` and `l` from the original, plus `gtm_auth` and `gtm_preview`. Everything else, including `gtm_cookies_win`, is dropped, so an old preview cookie cannot decide what loads.
- The rewrite happens inside the browser (`Fetch.requestPaused`), only for the debug tab, so nobody else sees the draft.
- The `gtm_auth` value is a credential for your workspace preview. It is never saved or shown: session files, the timeline, recorded hits and agent tool output show it as `gtm_auth=…`.
- If your site loads `gtm.js` through a custom first-party loader, list its URL patterns in `gsCode.debug.loaderPatterns`. Matching requests are redirected to `https://www.googletagmanager.com/gtm.js` with your container id (and the loader's `l` parameter, if any).

Only `http://` and `https://` pages (and `about:blank`) can be debugged, in either mode. Anything else, such as `file:`, `chrome:`, `javascript:` or `view-source:`, is refused: `Only http:// and https:// pages can be debugged, not file: URLs.` The same check applies when you navigate the debug tab.

Starting workspace mode can fail before the browser opens:

- `GTM cannot compile this workspace (a compiler error: usually an unknown variable or a broken template). Fix the Problems shown for the mirror, push, then debug again.`
- `GTM returned no preview environment for workspace "…". Click Preview once in the GTM UI for this workspace, then try again.`

## The browser

GS Code never downloads a browser. It either launches one you have installed, or attaches to one that is already running.

**Launch (default).** The first one found of Google Chrome, Chromium, Microsoft Edge or Brave (on Windows: Chrome or Edge; on Linux: `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `microsoft-edge`, `/snap/bin/chromium`). It runs with its own profile, kept between sessions so consent choices stick:

- VS Code: a `browser-profile` folder in the extension's global storage;
- CLI: `browser-profile` in the config directory (`GSCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/gs-code`, else `~/.config/gs-code`).

**Stop** closes a browser GS Code launched. If a session fails while it is being set up, GS Code closes the browser it launched (or the tab it opened) before reporting the error.

**Attach.** Start any Chromium-based browser with `--remote-debugging-port=9222` and a separate `--user-data-dir` (recent Chrome ignores remote debugging on the default profile), then point GS Code at it with an `http://` address (GS Code reads `/json/version`) or a `ws://` / `wss://` DevTools URL. When attached, GS Code opens its own tab and, on **Stop**, closes only that tab. It never closes your browser.

You can also record a tab that is already open: pass a URL prefix with `gscode debug --tab <url prefix>` or the `tab` input of `debug_start`. This only works when attached. That tab is left open when the session stops.

| VS Code setting | CLI environment variable | |
| --- | --- | --- |
| `gsCode.debug.browserUrl` | `GSCODE_BROWSER_URL` | Attach to this browser, e.g. `http://127.0.0.1:9222`. Empty: launch one. User or Remote settings only. |
| `gsCode.debug.browserPath` | `GSCODE_BROWSER_PATH` | Browser executable to launch. Empty: the first one found. User or Remote settings only. |
| `gsCode.debug.sgtmHosts` | `GSCODE_SGTM_HOSTS` (comma-separated) | Hosts of your server container, e.g. `sgtm.example.com`, and their subdomains. Every request to them is recorded, and replay only goes to them. |
| `gsCode.debug.loaderPatterns` | (VS Code only) | URL patterns with `*` for a custom `gtm.js` loader. |
| `gsCode.debug.dataLayerName` | (VS Code only) | Name of the data layer array, if not `dataLayer`. |
| `gsCode.debug.tagStatus` | (VS Code panel only) | Read tag status per event (default `true`). See below. |

The CLI and the MCP server always use `dataLayer`, no loader patterns, and tag status on. The VS Code language-model tools use `gsCode.debug.loaderPatterns` and `gsCode.debug.dataLayerName`, but always read tag status (`gsCode.debug.tagStatus` only applies to sessions started from the panel). Every session an agent starts reads tag status.

VS Code ignores a workspace (`.vscode/settings.json`) value of `browserUrl` and `browserPath`, so a shared repo cannot choose your browser. A workspace value of `sgtmHosts` is ignored until you trust the folder (see [team.md](team.md#cloned-repos-open-in-restricted-mode)). In Restricted Mode GS Code does not launch or attach a debug browser at all: `GS Code does not launch or attach a debug browser in Restricted Mode. Trust this workspace first (Manage Workspace Trust).`

Browser errors you may see:

- `No Chrome, Edge, Brave or Chromium found. Install one, or set gsCode.debug.browserPath (or attach to a running browser with gsCode.debug.browserUrl).`
- `No browser answering at http://127.0.0.1:9222 (…). Start it with --remote-debugging-port.`
- `The browser exited before it was ready (code …). Is another copy using <profile dir>?` Close the other debug browser, or stop the other session.
- `No open tab starts with <prefix>. Open the page in the browser first.`

## What is recorded

GS Code injects a small script into every page before the page's own scripts run. It only observes, and reports back through a DevTools binding, never over the network. The page can call that binding too, so a message over 256 KB is dropped with a note: `Dropped a N KB probe message (limit 256 KB).`

- **Events.** Every dataLayer push, including GTM's own (`gtm.js`, `gtm.dom`, `gtm.load`, clicks and so on), numbered in order (`#seq`), with what was pushed and the data model after it. `gtag()`-style command pushes are recorded too.
- **Tag status.** For pushes with an `event`, GS Code adds an `eventCallback`, which GTM calls with each tag's id and status. A callback the site set itself still runs. If a site's code is sensitive to this, turn off `gsCode.debug.tagStatus` (the panel then shows explanations without GTM's reported status).
- **Containers.** Which `GTM-`, `G-`, `AW-`, `DC-` and `GT-` ids are loaded on the page.
- **Consent.** See [Consent](#consent).
- **Hits.** See [Hits](#hits).
- **Pages.** Each top-level navigation starts a new page; events and hits are grouped by page.

Sessions are saved as `.gtm/debug/session-<time>.jsonl` in the mirror, and `.gtm/debug/latest` names the newest one. `.gtm/` is never committed (see [team.md](team.md)). The panel's **Last session** button, `gscode explain` and the agent tools read the latest session file when no session is running. `latest` must name a `session-….jsonl` file in the same folder; anything else is refused.

If the session file cannot be written (disk full, permissions), recording carries on in memory and GS Code notes it once: `Stopped writing <file>: <reason>. The session continues in memory only.` When a saved file has damaged lines, they are skipped with `Skipped N unreadable line(s) in <file>.` If the connection to the browser fails, the session ends with a note (`The browser connection failed: …`).

## Explanations

For each tag on a selected event, GS Code evaluates the mirror's tag and trigger files against that event's data model and gives one verdict:

- **✔ fires**, **✘ does not fire**, or **? unknown** (something could not be computed);
- one sentence with the deciding reason, the tag's file, and GTM's reported status when there is one;
- for each firing and blocking trigger: its file, whether it matched, and each condition as written, with the value it compared and where that value came from.

The checks, in order:

1. The tag is paused.
2. The tag's schedule has not started or has ended.
3. The tag has no firing triggers.
4. A blocking trigger matches.
5. The tag's **additional consent** settings require a consent type that was not granted at this event.
6. A firing trigger matches (event and every condition).

Trigger types it evaluates: Page View, DOM Ready, Window Loaded, Initialization, Consent Initialization, Click, Link Click, Form Submission, History Change, JavaScript Error, Timer, Scroll Depth, Element Visibility, YouTube Video, Custom Event, and the built-in **All Pages**, **Initialization - All Pages** and **Consent Initialization - All Pages**. For auto-event triggers it also checks GTM's `gtm.triggers` stamp, so an event produced by another trigger's listener does not count as a match. Trigger groups are reported as unknown (they depend on earlier events).

Condition operators: equals, contains, starts with, ends with, matches RegEx, less than, less than or equal to, greater than, greater than or equal to, each with negation and ignore-case. CSS selector conditions need the element itself and show as unknown.

How `{{Variables}}` are resolved:

| Variable | Value |
| --- | --- |
| Data Layer Variable (v1 and v2, with default value) | From the data model at the event |
| Constant, Event, URL (all components, custom URL source) | Computed |
| Auto-Event Variable (element, classes, id, target, URL, text) | From the event's `gtm.element…` keys |
| Lookup Table, RegEx Table | Computed, including default value |
| 1st-Party Cookie, JavaScript Variable, DOM Element, Custom JavaScript | Evaluated **in the open page, now**, not as of the event. Needs a running session. |
| Built-ins: Event, Page URL / Hostname / Path, Container ID, click, form, error, history, scroll, visibility and video variables | From the event and data model. Debug Mode is always `false`. Referrer is not known. |
| Anything else | Unknown, with the reason |

A condition whose value is unknown makes the trigger, and then the tag, **unknown** rather than guessing. In the panel, **Evaluate in page** re-runs the explanation with the in-page variables computed from the open page.

## Hits

Every request that is a measurement hit is recorded with its parameters and attributed to the latest event on its page that started before it. GA4 requests that batch several events are split into one entry per event.

Vendors recognised: `ga4`, `google-ads`, `floodlight`, `meta`, `bing`, `tiktok`, `linkedin`, `pinterest`, `snapchat`, `criteo`, `clarity`, `reddit`, plus `gtm` (the `gtm.js` / `gtag/js` loads) and `sgtm`.

A hit is **first-party** (sent to your server container) when its host is in `gsCode.debug.sgtmHosts` / `GSCODE_SGTM_HOSTS` (or a subdomain of one), or when it is a GA4 `/g/collect` request to a non-Google host. Any request to a listed host is recorded, as `sgtm` if no vendor rule matches. A GA4 hit to an unlisted non-Google host is still shown as first-party (`ga4(1p)` in agent output), but it is not replayed: replay only goes to listed hosts.

For each hit GS Code keeps the response status and any `Set-Cookie` headers. For first-party hits it also keeps the request body (up to 64 KB, for replay) and the response body (up to 20,000 characters).

### Which server-side client claims a request

For first-party hits GS Code predicts which client in your **server** container mirror would claim the request, highest priority first:

- a GA4 client claims `/g/collect` and `/j/collect`;
- a Web Container client serves `gtm.js`, `gtag/js` and `ns.html`;
- a custom client whose path or endpoint parameter is a prefix of the request path.

This is a prediction from files, labelled `likely` or `unknown`. The real answer is in sGTM preview: use replay, below.

## Consent

Consent state is tracked per event from three sources:

- GTM's own consent state (`google_tag_data.ics`, default and update, read only);
- `gtag('consent', 'default' | 'update', {…})` commands pushed to the dataLayer, so consent is known before GTM reports it;
- the `gcs` parameter on GA4 hits, which fills in `analytics_storage` and `ad_storage` when nothing else did.

The panel's **Consent** tab shows the state at the selected event. Explanations use it for the tag's additional consent check. Consent checks built into a tag template itself are not evaluated.

## Server-side GTM

### Replay into your sGTM preview

There is no public API for sGTM preview results, so GS Code uses the supported route: replaying captured requests with a preview header.

1. In Tag Manager, open **Preview** for your server container.
2. In Tag Assistant, open **Send requests manually** and copy the `X-Gtm-Server-Preview` header value.
3. Set your server container's host: `gsCode.debug.sgtmHosts` in VS Code, or `GSCODE_SGTM_HOSTS=sgtm.example.com` for the CLI and the MCP server (an environment variable only; `config.json` has no such setting). Replay refuses to run without it.
4. Record a page that sends to your server container.
5. Replay:

   ```sh
   GSCODE_SGTM_HOSTS=sgtm.example.com gscode replay-sgtm --header <X-Gtm-Server-Preview value> [--name purchase] [--dir <mirror>]
   ```

   or the `debug_replay_sgtm` tool.

First-party requests from the latest session (except `gtm.js` loads) are sent again to the same URL, with the same method and body plus the header. GS Code prints each response status. Open your sGTM preview tab to see the claiming client, the tags that fired and their outgoing requests.

Which requests are sent:

- `gscode replay-sgtm --name purchase` sends only the hits for that event name. Without `--name`, the CLI replays every captured server-container request.
- The `debug_replay_sgtm` agent tool needs either `name` or `all: true`; with neither it refuses. In VS Code it also asks you to confirm before sending.
- Each request is checked just before it is sent. It must go to one of the configured hosts or their subdomains, over https (plain http only when `localhost` or `127.0.0.1` is itself listed, for `gscode sgtm-local`), with GET or POST, and with no user name or password in the URL. The first request that fails a check stops the replay with an error such as `Not replaying a request to <host>: it is not one of the configured sgtmHosts (…).` Requests already sent stay sent.

The header is checked first: `That is not an X-Gtm-Server-Preview value. In sGTM preview open "Send requests manually" and copy the header value.`

**Replayed requests are real.** Your server container handles them as it did the originals: its tags run and send their outgoing requests to the vendors. Replaying a purchase can record a duplicate conversion. Replay one event name at a time, do not repeat a replay, and use test ids or a test container when that matters.

### Run your server container locally

```sh
gscode sgtm-local --config <CONTAINER_CONFIG> [--port 8080] [--preview-port 8081]
```

`CONTAINER_CONFIG` is in GTM → **Admin** → **Container settings** of your server container. GS Code starts Google's official image (`gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable`) in two Docker containers, in the foreground:

- `gscode-sgtm-preview`, the preview server, on `http://localhost:8081`;
- `gscode-sgtm`, the tagging server, on `http://localhost:8080`, forwarding preview traffic to the preview server.

Details:

- Both ports are published on `127.0.0.1` only, so other machines on your network cannot reach them.
- `--port` and `--preview-port` must be whole numbers from 1 to 65535, and different from each other.
- Both containers join a Docker network named `gscode-sgtm`, where the tagging server finds the preview server by name. GS Code creates the network on the first run and reuses it after that. It stays after **Ctrl+C**; remove it with `docker network rm gscode-sgtm`. This works the same on native Linux Docker and on Docker Desktop.
- `CONTAINER_CONFIG` is passed to Docker through its environment, not on the command line, so it does not show in `ps`.

Their logs (including `logToConsole`) stream to your terminal. **Ctrl+C** stops both. No Google Cloud project or billing is involved. You need Docker: Docker Engine on Linux and Colima on macOS are free; Docker Desktop is free only where its licence allows.

To record traffic to it, send a test page's requests to `http://localhost:8080` and add `localhost` to `sgtmHosts`.

A local server container sends real requests to vendors when its tags fire. Use test ids, or block outgoing traffic.

## The VS Code panel

**GS Code: Open Debugger** (bug icon on a mirror). If several mirrors are open, GS Code uses the one of the active editor or asks.

- Toolbar: page URL, **Workspace draft (unpublished)** or **Live container**, **Start**, **Reload**, **Stop**, **Last session**.
- Left: the events of the current page.
- Right, for the selected event: **Tags** (verdicts and explanations; **Only tags that fired or might**; **Evaluate in page**), **Hits**, **Data model**, **Pushed**, **Consent**. File names in explanations open the mirror file.
- Bottom: **Push to dataLayer**, to reproduce an event, e.g. `{"event":"purchase","ecommerce":{"value":10}}`.

A session an agent starts with `debug_start` in VS Code shows in the same panel, and the agent tools see the panel's session.

## The CLI

```sh
gscode debug https://www.example.com/ [--dir <mirror>] [--live] [--tab <url prefix>]
```

Records until you quit. It prints each event as `#seq event  tags: name=status, …`. While it runs: **Enter** reloads, `e <seq>` explains an event, `q` quits. The session file path is printed at the end.

```sh
gscode explain <seq> [tag name] [--dir <mirror>]
```

Explains an event of the latest session: one line per tag, or with a tag name, every trigger and condition for that tag.

## Agent tools

The same 13 tools are offered over MCP (`gscode mcp`) and as VS Code language-model tools. The names are identical in both.

| Tool | Inputs | What it does |
| --- | --- | --- |
| `gtm_status` | `dir` | Local changes Push would send, conflicts and validation problems. When there are changes, also an `expected` signature for `gtm_push`. No API calls. |
| `gtm_pull` | `dir` | Pull the workspace's current contents from GTM (three-way merge; local edits are kept). It does not bring the workspace up to a newer published version; a person does that with **Pull** or `gscode pull`. |
| `gtm_push` | `dir`, `expected` (required) | Push to the workspace. Only the changes matching `expected` from `gtm_status` are sent. Never live. |
| `debug_start` | `url` (required), `mode` (`workspace` or `live`), `tab`, `dir` | Start a session. |
| `debug_events` | `page`, `dir` | Events of the latest (or given) page: sequence number, event name, tags, hits. |
| `debug_event` | `seq` (required), `dir` | One event: pushed data, data model, consent, tag statuses, hits. |
| `debug_explain` | `seq` (required), `tag`, `dir` | Why tags fired or not, with conditions, values and files. |
| `debug_hits` | `vendor`, `name`, `dir` | Hits, filtered by vendor or event name, with the predicted sGTM client. |
| `debug_replay_sgtm` | `header` (required), `name` or `all: true`, `dir` | Replay server-container requests into your sGTM preview. Sends real requests; see [Replay](#replay-into-your-sgtm-preview). |
| `debug_navigate` | `url` (required) | Navigate the debug tab. |
| `debug_reload` | | Reload the debug tab. |
| `debug_push` | `data` (required, a JSON object as text) | Push to the page's dataLayer. |
| `debug_stop` | | Stop the session. |

There are no tools to create versions or publish. That stays with a person.

**MCP clients** (Claude Code, Cursor and others): run the server in the mirror folder, or pass `--dir`:

```sh
claude mcp add gscode -- gscode mcp
claude mcp add gscode -- gscode mcp --dir /path/to/mirror
```

The server speaks MCP over stdio and identifies as `gs-code`. It uses the CLI's sign-in and the CLI's browser settings (`GSCODE_BROWSER_URL`, `GSCODE_BROWSER_PATH`, `GSCODE_SGTM_HOSTS`). Every tool also accepts `dir` (except the four that act on the running tab).

`dir` cannot point the tools anywhere on disk. It must be the mirror the server was started for (the current folder, or `--dir`) or a folder inside it; a relative `dir` is resolved from that mirror. Anything else is refused: `"dir" must be the open mirror (…) or a folder inside it.`

**Copilot in VS Code** (agent mode): the tools are built into the extension. Reference them as `#gtm_status`, `#debug_start`, `#debug_explain` and so on. They use the extension's sign-in and `gsCode.debug.*` settings, work on the mirror open in the debugger panel (or the first open mirror), and share the panel's session. The same `dir` rule applies, with that mirror as the base. `gtm_push` and `debug_replay_sgtm` ask you to confirm before they send anything. In Restricted Mode, `gtm_push`, `debug_start` and `debug_replay_sgtm` are refused (`GS Code does not push to GTM in Restricted Mode. Trust this workspace first (Manage Workspace Trust).` and so on).

A typical loop: `debug_start` → `debug_events` → `debug_explain` (names the file and condition) → edit the file → `gtm_status` → `gtm_push` → `debug_reload` → `debug_explain` again.

## Limits

- Chromium-based browsers only (Chrome, Edge, Brave, Chromium).
- Explanations come from the mirror files. If the workspace in GTM differs from your files (unpushed edits), push first, or the explanation and the draft disagree.
- Cookie, JavaScript, DOM and Custom JavaScript variables are read from the page as it is now, not as it was at the event.
- sGTM: client prediction is a guess from the files; tags fired and outgoing requests are only visible through replay into sGTM preview, or the logs of `gscode sgtm-local`.

See also: [troubleshooting.md](troubleshooting.md), [debugger-design.md](debugger-design.md) for the research behind it.
