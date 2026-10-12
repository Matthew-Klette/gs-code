# Status

_Updated 2026-10-12_

- Core sync engine, `gscode` CLI and VS Code extension are feature complete for v0.1.0.
- 72 unit/lifecycle tests pass (`npm test`); VS Code integration test passes (`npm run test:extension`).
- Serializer verified lossless on real web + server container exports (1,909 entities, 93 templates byte-exact).
- **Next:** live test against the Tag Manager API (OAuth sign-in, `bulk_update` payloads for update/delete, version + publish on a test container), then first public release.
