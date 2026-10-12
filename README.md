# GS Code

**Edit a Google Tag Manager workspace as plain files in VS Code. Bulk edit, diff, push to a workspace, and debug it in a real browser. Nothing goes live until you publish it.**

Free, MIT licensed, no account and no server. An independent project, not made by or affiliated with Google.

GS Code mirrors an entire GTM workspace (web or server-side) into a folder of plain files. You edit tags, triggers, variables and custom templates with everything VS Code is good at: search and replace across the whole container, multi-cursor, git, diffs, AI agents. Then you **Push** the changes back to GTM, check them in the **Debugger** against your real site before anything is published, and **Publish** when you are ready.

![GS Code: Source Control view listing GTM changes, with a side-by-side diff of a tag](media/screenshot.png)

---

## The problem it solves

The GTM web UI is built for editing one thing at a time. Real tagging work rarely is:

- Renaming a parameter across 40 GA4 event tags means 40 trips through the same dialog.
- Finding every tag that reads `{{DL - user_id}}` has no real search.
- Reviewing what changed in a workspace before publishing is a click-by-click comparison.
- Custom HTML, Custom JavaScript variables and sandboxed template code are edited in a small text box with no tooling.
- Getting an AI assistant to help means copying JSON in and out, or giving it slow, opaque API access.

Container export / import helps a little, but the export is one giant JSON file full of numeric ids, and importing it back risks overwriting someone else's work.

And when a tag does not fire, GTM's preview tells you *that* it did not, not *why*.

**GS Code turns the workspace into a normal project folder.** One readable file per entity, references by name instead of id, real `.html` / `.js` files for code, a safe sync that never silently overwrites anyone, and a Source Control view that shows exactly what Push will send. Its debugger records what your page does and tells you which trigger file and which condition decided each tag.

## What it can touch

Before you point it at a real container:

- **Scopes requested:** `tagmanager.readonly`, `tagmanager.edit.containers`, `tagmanager.edit.containerversions`, and `tagmanager.publish` only if publishing is enabled. Set `gsCode.allowPublish: false` and the publish scope is never requested.
- **Where pushes go:** into a GTM *workspace*, never the live container. Publishing is a separate command that makes you type the container id.
- **Where your tokens live:** your OS keychain (VS Code SecretStorage), or `~/.config/gs-code/` with file mode 600 for the CLI.
- **Who it talks to:** the Tag Manager API on `googleapis.com`, through your own OAuth client. The debugger drives a browser on your machine, and only sends requests to your own server container when you ask it to replay one. No server of mine, no analytics, no telemetry, no paid service anywhere.
- **Try it safely first:** set `allowPublish` to `false`, sign in, and open a new workspace on a test container. Pull and look around before you push anything.

## What it does

| | |
| --- | --- |
| **Every entity is a file** | `tags/GA4 - purchase.json`, `triggers/CE - purchase.json`, `variables/cJS - page type.js`, `templates/Meta CAPI/code.js`, `clients/GA4.json` … Web and server containers, including clients, transformations, zones, Google tag configs, folders and built-in variables. |
| **Names, not ids** | `"firingTriggers": ["CE - purchase"]`, `"folder": "GA4"`, `"type": "template:Meta CAPI"`. Create a trigger and the tag that uses it in one go; ids are resolved for you on push. |
| **Real code files** | Custom HTML tags get a `.html` file, Custom JavaScript variables a `.js` file, custom templates are split into `code.js`, `parameters.json`, `permissions.json`, `info.json`, `tests.yaml`. |
| **Source Control view** | Every change listed, click for a side-by-side diff against GTM, M/A/D badges in the Explorer, inline change markers in the editor gutter. |
| **Validation before push** | Unknown triggers, folders or templates, duplicate names and broken JSON show up in the Problems panel, and block the push. |
| **Safe sync** | Pull is a three-way merge: untouched files update, your edits are kept, anything changed both locally and in GTM becomes a conflict you resolve (Keep Mine / Take Theirs). Push re-checks GTM first and refuses to overwrite a change someone made since your last pull. |
| **Fast pushes** | All changes go in one `workspaces.bulk_update` call (GTM allows only 0.25 API requests per second). |
| **Versions and publishing** | Create Version, or Create Version and Publish, with a typed container-id confirmation, a blocklist for containers you never want published from here, and a no-publish sign-in mode. |
| **Debugger** | Load your *unpublished* workspace on your real site, see every dataLayer event, tag status, consent state and network hit, and get the reason each tag fired or did not, linked to the file to fix. [More](docs/debugger.md) |
| **AI agents** | Every operation and the debugger are tools: Copilot uses them inside VS Code, Claude Code, Cursor and other MCP clients through `gscode mcp`. Agents can push to a workspace; only you can publish. |
| **Teams** | Share a mirror through git: each person links the same files to their own workspace (`--adopt`). Push and versioning check GTM again right before they write, and never overwrite a teammate's change. [More](docs/team.md) |
| **CLI** | `gscode` does everything the extension does, for scripts, CI and terminal AI agents. |

## Getting started

### 1. Install

- **VS Code, Cursor, VSCodium, Windsurf:** search for **GS Code** in Extensions (VS Code Marketplace and Open VSX), or download the `.vsix` from [Releases](https://github.com/Matthew-Klette/gs-code/releases) and run **Extensions: Install from VSIX…**.
- **CLI:** `npm install -g gs-code` (Node 20+), then `gscode --help`.

The first run opens a short walkthrough (**Help → Welcome → Get started with GS Code**).

### 2. Create a Google OAuth client (one time, about 10 minutes)

GS Code talks to the Tag Manager API with **your** Google account through **your own** OAuth client. No server in the middle, nobody else ever sees your tokens.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project (any name, e.g. `gs-code`).
2. **APIs & Services → Library** → enable **Tag Manager API**.
3. **Google Auth Platform → Branding / Audience**: app name of your choice, audience **External** (or **Internal** on Google Workspace), and add the Google account you use for GTM under **Test users**.
4. **Google Auth Platform → Clients → Create client** → application type **Desktop app** → **Download JSON**.

**Can't create a Cloud project?** Any project you already have works, for example the one your server-side GTM runs in: enable the Tag Manager API there and add a Desktop client. On Google Workspace, ask your admin for one **Internal** Desktop client and share it with the team (everyone signs in with their own account; the API quota of 25 requests per 100 seconds is shared per project).

**Why sign-in expires after 7 days:** Google expires refresh tokens weekly for External apps in **Testing** status. GS Code tells you when to sign in again. To stop it, use an **Internal** audience, or set the app's publishing status to **In production** (the unverified-app screen stays, because the app is yours and unreviewed).

### 3. Sign in

Command Palette (`⇧⌘P` / `Ctrl+Shift+P`) → **GS Code: Configure OAuth Client** → pick the downloaded JSON → **Sign In**.

Google shows "Google hasn't verified this app" because the app is yours and in testing mode; choose **Continue**. Credentials are stored in your OS keychain (VS Code SecretStorage). The status bar tooltip shows which Google account is signed in.

Working over **Remote-SSH, WSL, a Dev Container or Codespaces**? Sign-in works there too. If the browser ends on a "can't connect" page, paste that page's address into the box GS Code shows. **Sign Out** revokes the sign-in at Google; **Remove OAuth Client** forgets the client as well.

### 4. Open a workspace

**GS Code: Open Workspace…** → account → container → workspace (or **Create new workspace…**) → a parent folder.

A folder named `GTM-XXXXXXX - Workspace name` is created and pulled. Open it; the **GS Code** panel appears in Source Control.

> Tip: create a dedicated GTM workspace for your session (e.g. `bulk-rename-oct`), exactly as you would in the GTM UI. GTM merges workspaces when you publish.

## Everyday use

| To | Do |
| --- | --- |
| See what you changed | Source Control view → **GS Code** |
| Compare a file with GTM | Click it in the Source Control view |
| Get changes made in GTM | Automatic (auto-pull checks every minute), or **Pull** (☁↓) to also bring the workspace up to a newly published version |
| Send your changes to GTM | **Push** (☁↑) – shows the list and asks first |
| Throw away a change | ↶ next to the file, or **Discard Changes** |
| Settle a conflict | Right-click it → **Keep Mine** / **Take Theirs** |
| Test your changes on your site | **Open Debugger** (bug icon), enter a URL, **Start** |
| Make a version | `…` → **Create Version** |
| Go live | `…` → **Create Version and Publish** (type the container id to confirm) |
| Roll back | `…` → **Versions / Roll Back…** |
| Follow another workspace | `…` → **Switch Workspace…** (e.g. after a teammate versioned yours) |
| Jump to the GTM UI | `…` → **Open in Tag Manager** |

### Bulk edits

Use VS Code's search (`⇧⌘F`) across the folder. Examples:

- Replace `"value": "{{DL - user_id}}"` with `"value": "{{DL - customer_id}}"` everywhere.
- Regex-replace a measurement id across every GA4 tag.
- Multi-cursor through 30 trigger files at once.

Then look at the Source Control view: every touched entity is listed with its diff. Push sends them in one request.

### Adding things

Create a file in the right folder with at least `name` and `type` (copying an existing file is the quickest start). The content is the GTM API format with ids replaced by names:

```json
{
  "name": "GA4 - sign_up",
  "type": "gaawe",
  "firingTriggers": ["CE - sign_up"],
  "folder": "GA4",
  "parameter": [
    { "type": "template", "key": "eventName", "value": "sign_up" },
    { "type": "template", "key": "measurementIdOverride", "value": "G-XXXXXXXXXX" }
  ]
}
```

- **Folders** are listed in `folders.json`; add a name there to create one.
- **Built-in variables** are enabled in `built-in-variables.json`.
- **Custom templates** are folders under `templates/` with `template.json`, `info.json`, `parameters.json` and `code.js`.
- **Code** can live in its own file: `{ "type": "template", "key": "html", "valueFile": "My tag.html" }`.

Reference formats: a plain name for triggers and folders, `builtin:All Pages` for built-in triggers, `template:Name` for template-based types, `#123` for an id with no name locally.

### Renaming and deleting

- Change `name` inside a file to rename the entity in GTM (the file name doesn't matter).
- Rename only the file and the entity stays the same.
- Delete the file to delete the entity.
- When you rename a trigger or folder, update its references too (one search and replace); validation tells you if you missed one.
- Renamed something in the GTM UI? **Rename Files to Match GTM** (`gscode tidy`) renames the files too.

Files copied from a container export are fine: export-style spellings like `TEMPLATE` or `TRIGGER_REFERENCE` are converted on push. The full format is in [docs/file-format.md](docs/file-format.md).

### Debugging

![GS Code Debugger: dataLayer events on the left; for the selected event, each tag with whether it fired and the trigger condition that decided it (demo container)](media/debugger.png)

**GS Code: Open Debugger** → enter your site's URL → **Start**. GS Code opens your own Chrome, Edge, Brave or Chromium (it never downloads one) and, in **Workspace draft** mode, loads your *unpublished* workspace on the real site, for you only. Then:

- every dataLayer event, with what was pushed and the data model after it;
- each tag's status as GTM reports it, and for every tag **why** it fired or not: the trigger, each condition with the value it compared, blocking triggers, consent, pause and schedule, with links to the files;
- consent state per event and every measurement hit (GA4, Google Ads, Meta, server container…) with its parameters;
- server containers: requests to your sGTM with the client predicted to claim them, and a replay into your own sGTM preview.

Fix a file, Push, press **Reload**: the draft picks up the change. Details and settings: [docs/debugger.md](docs/debugger.md).

### Using it with an AI assistant

The workspace is just files, so any coding agent can read and edit it. GS Code also gives agents tools to check their work in the real world:

- **Copilot (agent mode) in VS Code:** the tools are built in (`#debug_start`, `#debug_explain`, `#gtm_status`, …) and share the Debugger panel's session.
- **Claude Code, Cursor and other MCP clients:** `claude mcp add gscode -- gscode mcp` (run it in the mirror folder, or pass `--dir`).

A typical loop: *"Why doesn't GA4 - purchase fire on the thank-you page?"* → the agent starts a session, reads the explanation, edits the trigger file, checks `gtm_status`, pushes to the workspace and reloads to confirm. Agents cannot create versions or publish.

## Safety

GS Code is designed so that nothing reaches GTM, and nothing goes live, without you seeing it first.

- **Push** always shows the full list of changes and asks before sending. It goes to a **workspace**, never live.
- **Conflicts** are detected with GTM's own fingerprints. If anyone changed an entity in GTM since your last pull, Push stops.
- **Publish** needs you to type the container's public id (`GTM-XXXXXXX`) every time.
- **`gsCode.protectedContainers`** blocks Create Version and Publish for the containers you list (Pull and Push still work). Keep it in your *User* settings.
- **`gsCode.allowPublish: false`** + sign in again = a token that physically cannot publish (the `tagmanager.publish` scope is never requested).
- **Push sends exactly what you confirmed.** If an editor, an agent or another window changes a file between your confirmation and the push, nothing is sent.
- **Versions contain exactly what you reviewed.** Create Version re-checks GTM first and refuses if the workspace changed since your last pull. Publishing never rolls back a newer live version unless you choose Roll Back.
- **Background checks never write to GTM.** A newly published version is announced; the workspace is only updated when you Pull.
- **One process at a time per folder.** The CLI, VS Code windows and agents take turns (`.gtm/lock`), and an interrupted push loses nothing: the next pull finishes it.
- **Your data stays local.** The mirror folder, your OAuth client and tokens never leave your machine except in calls to Google's Tag Manager API.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `gsCode.protectedContainers` | `[]` | Public ids (`GTM-XXXXXXX`) where Create Version and Publish are blocked. |
| `gsCode.allowPublish` | `true` | `false` hides Publish and, after signing in again, requests a token without the publish scope. |
| `gsCode.pushStrategy` | `bulk` | `sequential` pushes one entity per API call: slower, but errors are reported per entity. |

## CLI

```sh
git clone https://github.com/Matthew-Klette/gs-code.git && cd gs-code
npm install && npm run build && npm link      # puts `gscode` on your PATH

gscode login --client ~/Downloads/client_secret_XXXX.json
gscode accounts
gscode containers <accountId>
gscode init ./my-container --account <id> --container GTM-XXXXXXX --workspace "my changes" --create
cd my-container
gscode status
gscode pull
gscode push                 # shows the changes and asks; --yes to skip
gscode version --name "v42" --notes "…"                          # create a version
gscode version --name "v42" --publish --confirm GTM-XXXXXXX      # create and publish
```

The CLI stores credentials in `~/.config/gs-code/` (file mode 600). Protected containers: `~/.config/gs-code/config.json` → `{"protectedContainers": ["GTM-XXXXXXX"]}`, or `GSCODE_PROTECTED=GTM-A,GTM-B`.

## How it works

```
GTM-XXXXXXX - my changes/
  tags/  triggers/  variables/  templates/  clients/  transformations/  zones/  gtag-configs/
  folders.json
  built-in-variables.json
  .gtm/
    state.json   ids + fingerprints of everything pulled
    base/        the last pulled copy (the left side of every diff)
    remote/      GTM's copy of anything in conflict
```

- **Pull** reads every entity (about 10 API calls), renders it as files and merges three ways against `.gtm/base`.
- **Push** diffs your files against `.gtm/base`, validates references, re-reads GTM to check fingerprints, sends one bulk update, then pulls again so ids and fingerprints are current. If a push fails, nothing is half-applied: whatever didn't go through stays as a local change.
- **Create Version** turns the workspace into a container version. GTM then deletes that workspace and starts a fresh one; GS Code follows it automatically.
- The Tag Manager API allows 25 requests per 100 seconds per Google Cloud project. GS Code rate-limits itself (shared across CLI runs) and backs off on quota errors.

> **Keep mirrors of real containers out of public repos.** A mirror folder contains your container's full configuration. If you version it with git, use a private repository.

## Limitations

- One mirror folder per GTM workspace.
- Google tag (gtag) configs have no name, so their files are named by type and id.
- Zones are only available on GTM 360 accounts.
- Mobile (Android / iOS) containers are not supported.

## Development

```sh
npm install
npm test                 # unit + lifecycle tests against an in-memory GTM
npm run test:extension   # runs the extension inside VS Code
npm run build            # dist/extension.js + dist/cli.js
npm run package          # builds a .vsix you can install with "Extensions: Install from VSIX…"
```

Press `F5` in VS Code to launch an Extension Development Host.

## License

MIT © Matthew Klette

GS Code is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Google. Google Tag Manager is a trademark of Google LLC.
