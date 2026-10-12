# Troubleshooting

Messages in `code` below are what GS Code shows. Most API errors are one plain sentence followed by the raw API response underneath (`GET accounts/… failed (403): …`); the sentence is what to act on. In VS Code, **Show Details** on an error opens the full text in the GS Code output channel.

## Sign-in

### "The Tag Manager API is not enabled"

```
The Tag Manager API is not enabled in the Google Cloud project of your OAuth client. Enable it under APIs & Services → Library.
```

Google Cloud Console → the project that owns your OAuth client (or, in CI, the service account) → **APIs & Services → Library** → **Tag Manager API** → **Enable**. It can take a minute or two to apply.

### A "Web application" client by mistake

```
This is a "Web application" client. Create a "Desktop app" OAuth client instead.
```

GS Code signs in with a loopback redirect (`http://127.0.0.1:<random port>`), which Google only allows for **Desktop app** clients. In Google Auth Platform → **Clients** → **Create client**, choose **Desktop app**, download the JSON, then configure it again: **GS Code: Configure OAuth Client**, or `gscode login --client client_secret.json`.

Other messages about the JSON file:

- `That file is not valid JSON. Download the OAuth client JSON from Google Cloud Console → Credentials.`
- `Expected a Desktop app OAuth client JSON with "installed.client_id" and "installed.client_secret".`

### redirect_uri_mismatch

Google shows **Error 400: redirect_uri_mismatch** in the browser. The client is not a Desktop app client (for example a Web client whose JSON was edited). Create a Desktop app client as above. Desktop clients accept any loopback port; there is nothing to register.

### The browser ends on "can't connect" (Remote, WSL, containers, SSH)

Google redirects to `http://127.0.0.1:…` on the machine where your browser runs, which may not be where GS Code runs. That is expected. Copy the whole address from the browser and paste it into the box GS Code shows. The CLI does this by itself over SSH, in Codespaces, in containers and on Linux without a display; force it with `gscode login --manual`.

- `That is not the address from the browser. Copy the whole address bar (it starts with http://127.0.0.1).`
- `That address belongs to a different sign-in attempt. Start again.`
- `Sign-in timed out.` Start the sign-in again.

### "Access blocked" or "has not completed the Google verification process"

The Google account is not a **Test user** of an External app in Testing status. Add it under Google Auth Platform → **Audience** → **Test users**. "Google hasn't verified this app" is normal for your own client: choose **Continue**.

### Signed out after 7 days

```
Your Google sign-in expired or was revoked. Sign in again.
```

In VS Code: `GS Code stopped checking GTM for changes: Your Google sign-in expired or was revoked. Sign in again.` with a **Sign In** button.

Google expires refresh tokens after 7 days for **External** apps in **Testing** status. Sign in again (**GS Code: Sign In**, or `gscode login`). To stop it for good, either use an **Internal** audience (Google Workspace), or set the app's publishing status to **In production** in Google Auth Platform → **Audience**. The unverified-app screen stays either way, because the app is yours and unreviewed.

The same message appears if the sign-in was revoked at myaccount.google.com/permissions.

### "Google did not return a refresh token"

```
Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and sign in again.
```

### "Not signed in" / "No OAuth client configured"

- `Not signed in. Run "Sign In" first.` (CLI: `Not signed in. Run \`gscode login\`.` from `gscode whoami`)
- `No OAuth client configured. Run "Configure OAuth Client" first.` (CLI: `gscode login --client client_secret.json`)

The CLI and VS Code keep separate sign-ins. **GS Code: Import Sign-In from gscode CLI** copies the CLI's into VS Code.

## Permissions (403)

GS Code turns a 403 into one of these, depending on what was attempted:

| Message | Fix |
| --- | --- |
| `Your Google account cannot read this (check its permissions on the account and container in GTM).` | Add the account (or service account) as a user in GTM with at least Read on the container. |
| `Your Google account cannot edit this workspace (it needs Edit permission on the container in GTM).` | Edit permission is needed to push. |
| `Your Google account cannot create versions in this container (it needs Approve or Publish in GTM).` | |
| `Your Google account cannot publish this container (it needs the Publish permission in GTM).` | |
| `Your sign-in has no publish permission (gsCode.allowPublish was off when you signed in). Sign in again with publishing allowed.` | The token lacks the `tagmanager.publish` scope. Set `gsCode.allowPublish` to `true` (CLI: sign in without `--no-publish`) and sign in again. In CI, see [ci.md](ci.md#publishing-stays-with-people). |
| `Your sign-in is missing a permission GS Code needs. Sign in again.` | |

`gscode whoami` shows which account is signed in and whether publishing is allowed.

If `gscode accounts` lists nothing, the account has no GTM access at all.

A pull with only Read permission still works: the step that brings the workspace up to a newly published version is skipped, with `no permission to update workspace "…" to version N; pulled without syncing`.

## 429 or quota errors

The Tag Manager API allows 25 requests per 100 seconds per Google Cloud project. GS Code paces itself to that, shared across every `gscode` run on the machine, and backs off when Google says no:

```
  waiting 12s for the GTM API quota…
  retry 1 in 8s (…)
```

These are normal and need nothing from you. Reads are retried on 429, quota-related 403 and 5xx; writes are retried only on quota errors, so nothing is sent twice.

When the **daily** quota is used up, waiting minutes will not help, so GS Code stops:

```
The Tag Manager API daily quota for your Google Cloud project is used up; it resets at midnight Pacific time. (…)
```

Auto-pull and `gscode watch` stop too. Everyone signed in through the same OAuth client shares this quota. To get through the day: use a second OAuth client in another project, or lower the load (raise `gsCode.autoPull.intervalSeconds`, or turn off `gsCode.autoPull.enabled`). The limits for your project are in Cloud Console → **APIs & Services → Tag Manager API → Quotas**.

## WorkspaceGone: the workspace no longer exists

```
Workspace "…" no longer exists in GTM (it was versioned or deleted). Pick the workspace this folder should follow ("GS Code: Switch Workspace…" or `gscode switch`).
```

Someone created a version from the workspace this folder follows (GTM deletes a workspace when it is versioned), or deleted it. GS Code never guesses a replacement. The CLI lists the workspaces that exist and suggests:

```
Follow one with `gscode switch --workspace <id>`, or `gscode switch --new <name>`.
```

In VS Code: **GS Code: Switch Workspace…** (offered on the warning). Your working files are backed up to `.gtm/backups/<time>/` first, then GS Code pulls the chosen workspace with a three-way merge, so unpushed edits are kept.

When **you** create a version, GS Code follows the fresh workspace automatically. If that fails, the message says so: `Version N was created…, but switching this folder to a new workspace failed: … Run "Switch Workspace…" to pick the one this folder should follow.`

## MirrorBusy: another process is working on this folder

```
Another GS Code process (pid 12345, "pull") is working on this folder. Try again when it finishes.
```

The CLI, `gscode watch`, other VS Code windows and agents take turns on a folder through `.gtm/lock`. Another process held it for more than 30 seconds. Wait for it, or stop it.

A lock is ignored when its process has exited (same machine) or when it is older than 15 minutes, so a crash does not block you for long. If the folder is on a network drive used from two machines and a lock is stuck, delete `.gtm/lock`, but only when you are sure nothing else is running.

## "Behind": a newer container version was published

- VS Code: `GS Code: container version N was published. Pull to bring "…" up to date.`
- `gscode watch`: `container version N was published; run \`gscode pull\` to bring this workspace up to date`
- `gscode pull --no-sync`: `Container version N is newer than this workspace. Run \`gscode pull\` without --no-sync to bring it up to date.`
- Create Version: `Container version N was published after this workspace was last synced. Pull first (it brings the workspace up to date), review, then create the version.`

Background checks never change your workspace. **Pull** (`gscode pull`) brings it up to the latest version and then pulls. If the same entity changed in both, GTM reports a merge conflict, and GS Code lists it:

```
GTM merge conflict tags/….json: workspace updated, latest version updated (resolve-gtm --keep-workspace / --latest)
```

Settle it with **Resolve GTM Merge Conflict: Keep Workspace Version** / **Take Latest Version**, or `gscode resolve-gtm <base> --keep-workspace | --latest`.

`GTM could not sync workspace "…" to version N. Open it in Tag Manager to see why.` means GTM itself refused the update; the Tag Manager UI shows the reason.

## Compiler errors

GTM compiles a workspace when you preview it, create a version or publish. Unknown variable references and broken templates are the usual cause.

- Debugger, workspace mode: `GTM cannot compile this workspace (a compiler error: usually an unknown variable or a broken template). Fix the Problems shown for the mirror, push, then debug again.`
- Create Version: `GTM reported a compiler error; no version was created. Open the workspace in Tag Manager to see it.`
- Publish: `Version N was NOT published: GTM reported a compiler error`

GS Code catches the common causes before anything is sent. They show in the Problems panel and in `gscode status`, and block Push:

- `{{Name}} is not a variable or enabled built-in in this workspace (renamed or deleted? enable it in built-in-variables.json)`
- `unknown trigger "…"`, `unknown folder "…" (add it to folders.json)`, `unknown template "…"`
- `setupTag references unknown tag "…"` / `teardownTag references unknown tag "…"`
- `tag sequencing loops: A → B → A`
- `duplicate tag name "…" (also in …)`
- `variable name "…" is already used by an enabled built-in variable`
- `invalid JSON (…)`, `missing "name"`, `missing "type"`

If GTM still reports a compiler error, open the workspace in Tag Manager (**Open in Tag Manager**) and press Preview: the GTM UI names the entity.

## Push problems

- `GTM changed since your last pull. Nothing was pushed. Pull, resolve, then Push again:` followed by the entities. A teammate or the GTM UI changed them.
- `Your files changed after you confirmed the push. Nothing was sent. Review the changes and push again:` A file was saved (by you, an editor or an agent) after you confirmed.
- `Push blocked:` followed by validation errors or unresolved conflicts (`… unresolved conflict (Keep Mine / Take Theirs)`).
- `GTM rejected the push. To find the entity it objects to, push with the sequential strategy (\`gscode push --sequential\`, or the gsCode.pushStrategy setting).` The bulk request was refused as a whole; sequential sends one entity at a time and names the one that fails.
- `Someone changed this in GTM a moment ago. Pull, review, then try again.` (409)
- `This workspace was submitted for approval (GTM 360) and cannot be edited until the approval is resolved.`
- `This container already has the maximum number of workspaces (3 on free GTM). Delete or version one in GTM first.`

## Folders and containers

- `<dir> is not empty. Pick an empty folder, or adopt the files already there (gscode init --adopt).` See [team.md](team.md#joining-adopt-a-clone).
- `<dir> already mirrors GTM-XXXXXXX / …. Pick an empty folder.`
- `GTM-XXXXXXX is a … container. GS Code supports web and server containers only.`

## Debugger

See [debugger.md](debugger.md) for browser, preview and replay messages.
