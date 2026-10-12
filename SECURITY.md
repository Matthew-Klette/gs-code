# Security

## Reporting a vulnerability

Please report security problems privately through GitHub Security Advisories:

https://github.com/Matthew-Klette/gs-code/security/advisories/new

Do not open a public issue for them. Include the GS Code version, how to reproduce the problem and what an attacker could do with it. Leave out real container ids, account ids and tokens. The maintainer aims to reply within a week. Fixes go into the next release, and the advisory is published once a fixed version is out.

## Supported versions

Only the latest release gets security fixes.

## What GS Code stores, and where

GS Code has no server of its own and no telemetry. It talks to the Google Tag Manager API (`tagmanager.googleapis.com`) and Google's OAuth endpoints with your own OAuth client, and, when you use the debugger, to the pages you open in it.

### Sign-in

- **OAuth scopes.** `openid` and `email` (only to show which account is signed in), `tagmanager.readonly`, `tagmanager.edit.containers` and `tagmanager.edit.containerversions`. `tagmanager.publish` is requested only when publishing is allowed (`gsCode.allowPublish`, on by default). With it turned off, the stored token cannot publish at all.
- **Sign-in flow.** A loopback redirect to `http://127.0.0.1` on a random port. In remote shells you paste the final browser address instead.
- **Sign-out** revokes the refresh token with Google (best effort when offline) and deletes it locally.

### VS Code extension

- The OAuth client (client id and secret) and the tokens are kept in VS Code SecretStorage under the keys `gsCode.oauthClient` and `gsCode.tokens`. VS Code keeps SecretStorage in the operating system's keychain or credential store.
- **Import Sign-In from gscode CLI** reads the CLI's `client.json` and `tokens.json` (see below) and copies them into SecretStorage. It does not change or delete the CLI files.
- The debugger's browser profile lives in the extension's global storage folder, in `browser-profile/`.

### gscode CLI

The config directory is `GSCODE_CONFIG_DIR` if set, else `$XDG_CONFIG_HOME/gs-code`, else `~/.config/gs-code`. It holds:

| File | Contents |
| --- | --- |
| `client.json` | OAuth client id and secret |
| `tokens.json` | OAuth access and refresh tokens |
| `config.json` | Optional settings you write yourself, such as `protectedContainers` |
| `ratelimit.json` | Timestamps of recent API requests, shared between `gscode` runs to respect the quota |
| `browser-profile/` | The debugger's dedicated browser profile |

The directory is created with mode `0700`. `client.json`, `tokens.json` and `ratelimit.json` are written with mode `0600` (readable only by you). On Windows these modes are not enforced the same way, so the files are protected by your user profile's permissions only.

In CI the CLI can skip the stored tokens: `GSCODE_ACCESS_TOKEN` uses a ready access token as is, and `GSCODE_AUTH=adc` uses Application Default Credentials (a service-account key in `GOOGLE_APPLICATION_CREDENTIALS`, workload identity federation or `gcloud auth application-default login`). Treat these like any other secret in your CI system.

### The mirror folder

A mirror is a normal folder of JSON and code files that you can commit and share. GS Code's own bookkeeping goes in `.gtm/` inside it, which is per machine and must not be committed. When GS Code creates a mirror and the folder has no `.gitignore`, it writes one that ignores `.gtm/`.

| Path | Contents |
| --- | --- |
| `.gtm/README.txt` | A short note on what the folder is |
| `.gtm/state.json` | Account, container and workspace ids and names, and the id of every mirrored entity |
| `.gtm/base/` | The last pulled copy of every file |
| `.gtm/remote/` | GTM's copy of entities that are in conflict |
| `.gtm/merge/` | The latest container version's copy of entities in a GTM merge conflict |
| `.gtm/backups/<timestamp>/` | A copy of the working files, taken before switching to another workspace |
| `.gtm/lock` | Process id, host name, operation and start time of the GS Code process working on the folder. Removed when it finishes; a lock older than 15 minutes is treated as stale |
| `.gtm/debug/` | Debugger session logs (`session-<timestamp>.jsonl`) and a `latest` pointer |

No credentials are written into the mirror.

### Debugger logs

Debugger session logs can contain personal or sensitive data from the pages you debug: page URLs, dataLayer pushes, consent state, tag hits with their parameters, `Set-Cookie` response headers and up to 20,000 characters of response bodies for recorded hits. The `gtm_auth` preview value is masked in the log note about loading the draft workspace, but captured URLs are otherwise stored as they were sent. Delete `.gtm/debug/` when you no longer need it, and never commit it.

The MCP server (`gscode mcp`) talks over stdin and stdout only and does not open a network port. `debug_replay_sgtm` only sends requests to your own server container, with the preview header you give it.

`gscode sgtm-local` runs Google's server-side tagging image in Docker with `-p <port>:8080`. Docker binds such ports on all network interfaces by default, so other machines on your network may reach the local tagging and preview servers while they run. The `CONTAINER_CONFIG` value is passed to Docker as an environment variable.

## Keeping client data out of this repository

This repository holds the extension and CLI only. `npm run check:safety` fails if any tracked file is a `.gtm/` folder, is named after a container (`GTM-...`), looks like a container export or contains a real Tag Manager URL. It runs in CI and before `npm publish`.
