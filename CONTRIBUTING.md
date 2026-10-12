# Contributing to GS Code

Thanks for helping. Bug reports, fixes, tests and docs are all welcome. For a larger change, open an issue first so we can agree on the approach before you spend time on it.

## The one rule: no client data

This repository holds the extension and CLI only. Never commit real Tag Manager data:

- no container or account ids (use `GTM-XXXXXXX` and made-up numeric ids)
- no client, brand or site names (use `example.com`)
- no container exports, mirror folders or `.gtm/` folders
- no OAuth clients, tokens or debugger session logs

Tests use the in-memory fake API in `test/fakeApi.ts`, not a real account. `npm run check:safety` catches the common cases (a `.gtm/` folder, a file named after a container, a container export, a real Tag Manager URL), but it cannot catch a client name in a comment. That part is on you.

## Setup

You need Node 20 or later and git. VS Code is needed for the extension test.

```sh
git clone https://github.com/Matthew-Klette/gs-code.git
cd gs-code
npm ci
```

`npm ci` also builds `dist/` through the `prepare` script. To try the extension, run `npm run package` and install the VSIX with `code --install-extension gs-code-<version>.vsix`. The CLI runs from `node dist/cli.js`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Bundles `dist/extension.js` and `dist/cli.js` with esbuild |
| `npm run watch` | Rebuilds on change |
| `npm run typecheck` | `tsc --noEmit` over `src` and `test` |
| `npm test` | Unit and lifecycle tests (Vitest, `test/**/*.test.ts`) |
| `npm run test:coverage` | The same with a coverage report for `src/core` |
| `npm run test:extension` | Builds the test bundles and runs the VS Code integration suite against a fake mirror |
| `npm run check:safety` | Fails if anything tracked by git looks like real GTM data |
| `npm run package` | Builds and packages `gs-code-<version>.vsix` |
| `npm run test:live` | Experimental: watches a real mirror for auto-pull. Only use it with your own test container |

`npm run test:extension` reads the VS Code executable from `VSCODE_PATH`. It defaults to `/Applications/Visual Studio Code.app/Contents/MacOS/Code`, so on Linux or Windows set `VSCODE_PATH` first. On a machine without a display, run it under `xvfb-run -a`.

## Before you open a pull request

```sh
npm run typecheck
npm test
npm run check:safety
```

CI runs these on Linux, macOS and Windows with Node 20 and 22, plus the extension test on Linux. Add or update tests for any behaviour you change. Bug fixes should come with a test that fails without the fix.

## Code style

- TypeScript, strict mode. Keep functions small and files focused.
- Prefer returning new objects over mutating existing ones.
- Errors that reach the user should say what happened and what to do next. Use `GtmError` and its subclasses for expected failures.
- Only `src/extension` imports `vscode`. `src/core`, `src/debugger` and `src/cli` are shared with the CLI and must stay free of it.
- No new runtime services or paid APIs. GS Code must stay free to use with nothing but a Google account and your own OAuth client.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>

<optional body>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`. Keep the first line under about 72 characters and write it in the imperative ("add", not "added").

## Reporting security problems

See [SECURITY.md](SECURITY.md). Please report them privately, not in an issue.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
