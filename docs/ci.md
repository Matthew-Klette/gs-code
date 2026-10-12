# CI: GitHub Actions

You can run `gscode` in CI to check the files in a pull request and to push merged changes to a GTM workspace. Everything here uses free tiers only: GitHub Actions minutes, a Google service account, Workload Identity Federation and the Tag Manager API. Nothing needs a billing account.

**CI should never publish.** By default it cannot: see [Publishing stays with people](#publishing-stays-with-people).

## How CI signs in

CI has no browser, so `gscode login` is not used. Two environment variables choose another way:

| Variable | Effect |
| --- | --- |
| `GSCODE_AUTH=adc` | Use Google **Application Default Credentials**: a credentials file named in `GOOGLE_APPLICATION_CREDENTIALS` (a service-account key, or a Workload Identity Federation config), or `gcloud auth application-default login`. GS Code asks for the read, edit-containers and edit-container-versions scopes. The publish scope is added only when `GSCODE_ALLOW_PUBLISH=1`. |
| `GSCODE_ACCESS_TOKEN=<token>` | Use this OAuth access token as is. It wins over `GSCODE_AUTH`. The token's own scopes decide what it can do. |

`gscode whoami` tells you which one is in use: `Using Application Default Credentials (<file>).` or `Using GSCODE_ACCESS_TOKEN from the environment.`

The identity needs to be a **user in GTM**, like a person:

1. GTM → **Admin** → **User Management** (account or container) → add the service account's email, e.g. `gscode-ci@<project>.iam.gserviceaccount.com`.
2. Container permission: **Read** is enough to check; **Edit** is needed to push and to bring the workspace up to the latest version.

API calls count against the quota of the service account's Google Cloud project, with the same 25 requests per 100 seconds as a person. Enable the **Tag Manager API** in that project.

## One-time setup: Workload Identity Federation (no keys)

GitHub's OIDC token is exchanged for a short-lived Google token. No key file is stored anywhere. Replace `PROJECT_ID`, `PROJECT_NUMBER` and `OWNER/REPO`:

```sh
gcloud services enable tagmanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project PROJECT_ID

gcloud iam service-accounts create gscode-ci --project PROJECT_ID

gcloud iam workload-identity-pools create github --location=global --project PROJECT_ID

gcloud iam workload-identity-pools providers create-oidc github-repo \
  --location=global --workload-identity-pool=github --project PROJECT_ID \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='OWNER/REPO'"

gcloud iam service-accounts add-iam-policy-binding gscode-ci@PROJECT_ID.iam.gserviceaccount.com \
  --project PROJECT_ID --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/OWNER/REPO"
```

The service account needs no Google Cloud roles: its GTM access comes from GTM's User Management.

In the GitHub repo, add these **variables** (Settings → Secrets and variables → Actions → Variables). None of them is a secret:

| Variable | Example |
| --- | --- |
| `GCP_WIF_PROVIDER` | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-repo` |
| `GCP_SERVICE_ACCOUNT` | `gscode-ci@PROJECT_ID.iam.gserviceaccount.com` |
| `GTM_ACCOUNT` | your GTM account id |
| `GTM_CONTAINER` | `GTM-XXXXXXX` |

**Alternative: a key file.** If your organisation allows service-account keys, create one, store it as the secret `GCP_SA_KEY`, and replace the `workload_identity_provider` / `service_account` inputs below with `credentials_json: ${{ secrets.GCP_SA_KEY }}`. Federation is safer: there is no long-lived key to leak.

## The CI workspace

CI is a team member like any other (see [team.md](team.md)): give it its own GTM workspace, here called `ci`. `--create` makes it on the first run. It counts towards the 3 workspaces of a free container.

The repo holds the mirror files (in this example under `gtm/`), never `.gtm/`. So each job first links the checked-out files to the `ci` workspace with `init --adopt`. Differences between the files and the workspace then show as local changes. Adopt never deletes: an entity that exists in the workspace but has no file in the repo is written as a new file, not removed from GTM.

## Example workflow

```yaml
# .github/workflows/gtm.yml
name: GTM

on:
  pull_request:
    paths: ['gtm/**']
  push:
    branches: [main]
    paths: ['gtm/**']

permissions:
  contents: read
  id-token: write   # for Workload Identity Federation

# One run at a time: they all use the same GTM workspace.
concurrency:
  group: gtm-ci
  cancel-in-progress: false

env:
  GSCODE_AUTH: adc
  GSCODE_PROTECTED: ${{ vars.GTM_CONTAINER }}   # belt and braces: version/publish blocked

jobs:
  gtm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm install -g gs-code@0.2.0

      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}
          service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}

      - name: Link the files to the ci workspace
        run: gscode init gtm --account "${{ vars.GTM_ACCOUNT }}" --container "${{ vars.GTM_CONTAINER }}" --workspace ci --create --adopt

      - name: Check
        run: |
          gscode status gtm | tee status.txt
          if grep -q '^error ' status.txt; then exit 1; fi

      - name: Push to the ci workspace
        if: github.event_name == 'push'
        run: |
          gscode pull gtm
          gscode push gtm --yes
```

What each step does:

- `gscode init … --adopt` pulls the `ci` workspace (about 10 API requests) and links the files to it.
- `gscode status` makes no API calls. It lists the changes Push would send, conflicts, and validation problems (unknown triggers, folders, templates or `{{variables}}`, duplicate names, invalid JSON). It exits with 0 even when it finds problems, so the step looks for lines starting with `error `.
- `gscode pull` brings the `ci` workspace up to the latest container version, then merges. If the service account only has Read permission, the update is skipped (`Note: no permission to update workspace "ci" to version N; pulled without syncing.`). Use `gscode pull --no-sync` to skip it on purpose.
- `gscode push --yes` pulls first, stops if anything conflicts (`Resolve the conflicts above first. Nothing was sent to GTM.`), validates, then sends the changes in one bulk request. `--yes` skips the confirmation prompt, which CI cannot answer. Add `--sequential` to send one entity per request when you need to see which entity GTM rejects.

Any failure exits with code 1, so the job fails.

The pushed changes are now in the `ci` workspace. Test them with the [debugger](debugger.md) (workspace mode on that workspace) and create the version from GTM or from a person's machine.

## Publishing stays with people

Several things keep CI from going live:

- With `GSCODE_AUTH=adc`, the token is requested **without** the `tagmanager.publish` scope unless `GSCODE_ALLOW_PUBLISH=1` is set. Without that scope Google refuses to publish, whatever the command.
- `GSCODE_PROTECTED` (comma-separated container ids, like `gsCode.protectedContainers` in VS Code) blocks `gscode version` and `gscode publish` for those containers: `GTM-XXXXXXX is in gsCode.protectedContainers. Create Version and Publish are blocked for it; do that in the Tag Manager UI.`
- `gscode version --publish` and `gscode publish` need `--confirm GTM-XXXXXXX`, the container id typed out.
- Give the service account **Edit**, not **Approve** or **Publish**, in GTM.

If you do decide to publish from CI, do it in a separate, manually started workflow (`workflow_dispatch`), set `GSCODE_ALLOW_PUBLISH=1` only there, and give that service account Publish permission in GTM.

## Using an access token instead

If another step already produces a token, pass it with `GSCODE_ACCESS_TOKEN`. For example, `google-github-actions/auth` can mint one with only the scopes you choose:

```yaml
      - id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}
          service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}
          token_format: access_token
          access_token_scopes: |
            https://www.googleapis.com/auth/tagmanager.readonly
            https://www.googleapis.com/auth/tagmanager.edit.containers
            https://www.googleapis.com/auth/tagmanager.edit.containerversions

      - run: gscode status gtm
        env:
          GSCODE_ACCESS_TOKEN: ${{ steps.auth.outputs.access_token }}
```

The token is used as is and is not refreshed. Access tokens last about an hour, which is plenty for one job.

## Quota

A job that inits, pulls and pushes uses a few dozen API requests. GS Code paces itself to 25 requests per 100 seconds, so a job may wait (`waiting Ns for the GTM API quota…`). If the project's **daily** quota runs out, GS Code stops instead of retrying: see [troubleshooting.md](troubleshooting.md#429-or-quota-errors).
