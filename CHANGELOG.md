# Changelog (GS Code)

## 0.2.0 (2026-10-12)

### Multi-user safety
- A push sends exactly the change set you confirmed. Edits saved while a push runs are kept on top of the pushed version.
- A failed push never adopts a teammate's entity of the same name. What a push sent is recorded before the refresh, so a failed refresh loses nothing.
- Background checks never write to GTM. A newer container version is reported as "behind"; only an explicit Pull syncs.
- Deleted in GTM but edited locally is now a conflict (Keep Mine recreates, Take Theirs deletes) instead of a silent recreate.
- A deleted workspace is detected, with a list of workspaces to choose from. New Switch Workspace command and `gscode switch` (files are backed up first).
- Create Version re-checks GTM first and refuses if the workspace changed since the last pull. Publish never rolls back a newer live version.
- `.gtm/lock` serialises the CLI, extension windows and agents working on the same folder.
- Publish follows GTM's replacement workspace when `create_version` deletes the old one.

### Quota and performance
- A one-tag push now takes about 9 to 10 API requests: it reuses the last snapshot and re-reads only the kinds it touched.
- Hitting the daily quota stops at once with a clear message instead of retrying.
- Auto-pull is paced (jitter, backs off up to 4x when idle, resets on activity) and skips a round when another process holds the folder.
- The CLI and extension share one rate-limit history, so together they stay under 25 requests per 100 seconds.

### Round-trip fidelity and validation
- Export-style enum spellings are normalised to the API spelling on push.
- Template-based entities keep GTM's exact `cvt_` type; unknown template fields are kept and sent back.
- New validation errors: unknown `{{variable}}` references, names clashing with enabled built-ins, tag sequencing loops, template name vs `info.json` drift.
- Plain-language hints for common API errors (API not enabled, missing scopes, permissions, 409, workspace limit, 360 approval).
- Mobile and AMP containers are refused; zones and Google tag configs tolerate a 403.

### Sign-in anywhere and CI
- Sign-in works in Remote-SSH, WSL, Dev Containers and Codespaces. Where the browser cannot reach the machine, paste the final address (`gscode login --manual`).
- CI auth: `GSCODE_AUTH=adc` (service account, workload identity, gcloud ADC) or `GSCODE_ACCESS_TOKEN`. Publishing from CI needs `GSCODE_ALLOW_PUBLISH=1`.
- Sign Out revokes the token at Google. New Remove OAuth Client command, `gscode logout --forget-client` and `gscode whoami`. The signed-in account is shown.
- Import Sign-In from gscode CLI copies CLI credentials into the extension.
- Portable file names: Windows reserved names escaped, 120-byte UTF-8 cap, NFC normalisation.
- The CLI installs from npm with no runtime dependencies.

### Team git
- New mirrors get a `.gitignore` for `.gtm/`, which holds each person's link to their own workspace.
- `gscode init --adopt` / Adopt Folder links a cloned mirror to your own workspace, matching files to GTM by kind and name.
- `gscode tidy` / Rename Files to Match GTM renames files whose entity was renamed in GTM, so every clone uses the same names.

### Versions, rollback and environments
- Versions / Roll Back command and `gscode versions` list versions with the live one marked.
- Publishing a version older than the live one needs an explicit rollback (typed container id in VS Code, `--rollback` in the CLI).
- `gscode publish --version <id> --confirm GTM-XXXXXXX` and `gscode environments`.

### Walkthrough
- A four-step first-run walkthrough (OAuth client, sign in, open or adopt, edit/review/push) and a welcome view in Source Control.

### Debugger, agents and server-side
- Debugger engine: drives your own Chrome, Edge, Brave or Chromium (or attaches to any browser exposing DevTools) and records every dataLayer push, tag status, Consent Mode state and outgoing hits for GA4, Google Ads, Floodlight, common ad pixels and first-party sGTM requests.
- Draft preview: loads the unpublished workspace in the page via GTM's quick preview.
- Explanations: why a tag fired or did not, condition by condition with the compared value, pointing at the mirror file.
- GS Code Debugger panel in VS Code: event timeline, tags, hits, data model, consent, and push to dataLayer.
- `gscode debug`, `gscode explain` and `gscode mcp`: an MCP server exposing status, pull, push and the debugger to agents. Agents cannot publish.
- The same tools as VS Code language-model tools for Copilot agent mode; push asks for confirmation.
- `gscode replay-sgtm`: replay captured server-container requests into your sGTM preview.
- `gscode sgtm-local`: run the official sGTM image locally.
- Requires VS Code 1.95 or later.

### Testing
- Experimental `npm run test:live` runs real VS Code against a real mirror.

## 0.1.0

- Mirror a GTM workspace (web or server container) as files: tags, triggers, variables, custom templates, clients, transformations, zones, Google tag configs, folders and built-in variables.
- References written as names (`firingTriggers`, `folder`, `template:Name`, trigger groups), translated back to ids on push.
- Custom HTML and Custom JavaScript in real `.html` / `.js` files; templates split into one file per section.
- Three-way Pull with conflict detection; Push via one `bulk_update` call or per-entity calls.
- Source Control view with diffs, Explorer badges, validation in the Problems panel.
- Create Version and Publish, with typed confirmation and a `protectedContainers` blocklist.
- `gscode` CLI with the same features.
