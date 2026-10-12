# Status

_Updated 2026-10-12_

## Current state

- Version 0.2.0 on the `dev` branch: sync engine, `gscode` CLI, VS Code extension, debugger, MCP server and Copilot tools. See CHANGELOG.md.
- 172 unit and lifecycle tests pass (`npm test`). VS Code integration test: `npm run test:extension`. Live run against a real mirror: `npm run test:live` (experimental).
- Serializer verified lossless on real web and server container exports.
- Nothing published yet: no GitHub release, Marketplace, Open VSX or npm package.

## Open items

- Create Version and Publish have not been tested live on a personal test container.
- Draft workspace preview in the debugger has not been tested end to end.
- Publishing is pending Matt: Marketplace, Open VSX and npm tokens, and the GitHub release.
