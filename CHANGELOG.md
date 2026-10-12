# Changelog (GS Code)

## 0.1.0

- Mirror a GTM workspace (web or server container) as files: tags, triggers, variables, custom templates, clients, transformations, zones, Google tag configs, folders and built-in variables.
- References written as names (`firingTriggers`, `folder`, `template:Name`, trigger groups), translated back to ids on push.
- Custom HTML and Custom JavaScript in real `.html` / `.js` files; templates split into one file per section.
- Three-way Pull with conflict detection; Push via one `bulk_update` call or per-entity calls.
- Source Control view with diffs, Explorer badges, validation in the Problems panel.
- Create Version and Publish, with typed confirmation and a `protectedContainers` blocklist.
- `gscode` CLI with the same features.
