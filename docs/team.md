# Working as a team

GS Code mirrors one GTM workspace into one folder. A team shares the **files** through git, and each person sends them to GTM through **their own workspace**. GTM merges workspaces when a version is created, exactly as it does in the GTM UI.

## The model

| | Shared through git | Per person, never committed |
| --- | --- | --- |
| What | `tags/`, `triggers/`, `variables/`, `templates/`, `clients/`, `transformations/`, `zones/`, `gtag-configs/`, `folders.json`, `built-in-variables.json` | `.gtm/`: the link to one workspace (ids, fingerprints, the last pulled copy, conflict copies, backups, debug sessions, the lock) |
| Why | Review, history, search across the container | It belongs to one person's workspace. Two people sharing it would push over each other's base. |

The file format is in [file-format.md](file-format.md).

## One workspace per person

Give every person (and CI, if you use it) their own GTM workspace, named after them. Never point two folders at the same workspace.

Free GTM containers allow 3 workspaces. When the limit is reached, GTM refuses a new one and GS Code says: `This container already has the maximum number of workspaces (3 on free GTM). Delete or version one in GTM first.` Version or delete finished workspaces to free a slot.

## Keep `.gtm/` out of git

`gscode init` and **Open Workspace…** write a `.gitignore` with `.gtm/` in a new folder. If the folder already has a `.gitignore`, GS Code leaves it alone, so add the line yourself:

```gitignore
.gtm/
```

If `.gtm/` was committed by mistake, remove it from the index (`git rm -r --cached .gtm`) and commit the `.gitignore`.

## Starting a shared repo

One person:

```sh
gscode init ./container --account <accountId> --container GTM-XXXXXXX --workspace "alice" --create
cd container
git init && git add . && git commit -m "GTM-XXXXXXX mirror"
git remote add origin <your private repo URL> && git push -u origin main
```

(In VS Code: **GS Code: Open Workspace…**, then commit the folder.)

## Joining: adopt a clone

Everyone else clones the repo, then links the clone to their own workspace. `--adopt` keeps the files that are already there.

```sh
git clone <your private repo URL> container
gscode init ./container --account <accountId> --container GTM-XXXXXXX --workspace "bob" --create --adopt
```

In VS Code: **GS Code: Adopt Folder (git clone of a mirror)…**, then pick the account, container and your workspace (or **Create new workspace…**).

What adopt does:

- Each file is matched to a GTM entity in the workspace by kind and name (unnamed Google tag configs by content), and keeps its file name.
- GTM's copy becomes the base. Any difference between your files and the workspace shows as **your local change**, ready to review and push.
- Entities that exist in GTM but have no file in the clone are written as new files.
- Files with no matching entity stay as local additions; Push creates them.

Without `--adopt`, `init` refuses a folder that is not empty: `<dir> is not empty. Pick an empty folder, or adopt the files already there (gscode init --adopt).`

## Day to day

1. `git pull` to get teammates' merged files.
2. GS Code shows what differs from your workspace. Review it in Source Control (or `gscode status`).
3. Edit, then **Push** (`gscode push`) to your own workspace. Test it with the [debugger](debugger.md) in workspace mode.
4. Commit and open a pull request as usual.
5. When the change should go live, someone with the right GTM permission creates a version from their workspace (and publishes it, typing the container id to confirm).

After someone publishes, everyone else's workspace is **behind**. GS Code tells you (`Container version N was published…`). **Pull** brings your workspace up to that version; GTM reports merge conflicts if both sides changed the same entity, and GS Code lists them for **Keep Workspace Version** / **Take Latest Version** (`gscode resolve-gtm <base> --keep-workspace | --latest`).

If a teammate versioned or deleted the workspace your folder follows, GS Code stops and asks you to pick another: **Switch Workspace…** or `gscode switch --workspace <name|id>` / `gscode switch --new <name>`. Your working files are backed up to `.gtm/backups/` first, and unpushed edits are kept.

## Keep file names the same in every clone

A file's name is only a label: identity is the entity's `name` inside the file. But when someone renames a tag in the GTM UI, or creates an entity on another machine, the file names in each clone can drift apart, and git sees renames that are not real.

**GS Code: Rename Files to Match GTM** (`gscode tidy`) renames every file to match its GTM name. Run it after a pull that brought renames, and commit the result. It skips entities that are in conflict and unnamed Google tag configs. When two entities would get the same file name (names that differ only in case, for example), the second gets its id in brackets.

## Several people on one machine, or several tools on one folder

The CLI, `gscode watch`, other VS Code windows and agents can all work on the same folder. They take turns through `.gtm/lock`; a second process waits up to 30 seconds, then stops with `Another GS Code process (pid …, "…") is working on this folder. Try again when it finishes.` See [troubleshooting.md](troubleshooting.md#mirrorbusy-another-process-is-working-on-this-folder).

## Sign-in and quota

Everyone signs in with their own Google account; tokens stay on their own machine. A team can share one OAuth client (for example an **Internal** client on Google Workspace), but the Tag Manager API quota (25 requests per 100 seconds) is per Google Cloud project, so everyone on that client shares it. Separate clients in separate projects get separate quotas.

## Private repositories only

A mirror holds your container's full configuration: ids, endpoints, custom code, sometimes tokens pasted into tags. **Keep mirrors in private repositories.** Do not put them in this project's repo or any public one.

## Settings each person sets for themselves

Some settings only count in your own **User** settings (or Remote settings), never in a shared repo's `.vscode/settings.json`. VS Code ignores a workspace value for them, so a cloned repo cannot switch off someone's protection or point their debugger at another browser:

- `gsCode.protectedContainers` and `gsCode.allowPublish`: User settings only. Each person adds the containers they want protected. The CLI reads `protectedContainers` from `~/.config/gs-code/config.json` or `GSCODE_PROTECTED`.
- `gsCode.debug.browserPath` and `gsCode.debug.browserUrl`: User or Remote settings only.

## Cloned repos open in Restricted Mode

When VS Code asks whether you trust the authors of a freshly cloned folder and you choose not to, it opens in Restricted Mode. GS Code still shows the mirror, its changes and diffs, and **Pull** works. It refuses anything that writes to GTM or starts a browser, with `GS Code does not <action> in Restricted Mode. Trust this workspace first (Manage Workspace Trust).`:

- Push, Create Version, Create Version and Publish, and Versions (publish or roll back);
- starting the debugger browser (launch or attach);
- the agent tools `gtm_push`, `debug_start` and `debug_replay_sgtm`.

A workspace value of `gsCode.debug.sgtmHosts` is also ignored until you trust the folder. Review what the repo contains, then trust it with **Manage Workspace Trust**.

For running checks and pushes from GitHub Actions, see [ci.md](ci.md).
