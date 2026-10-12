# File format

A mirror folder holds one GTM workspace as plain files. The content is the Tag Manager API v2 format, with three changes: ids are replaced by names, code lives in its own files, and fields that GTM owns are left out.

```
GTM-XXXXXXX - my workspace/
  tags/                <name>.json  (+ <name>.html for Custom HTML)
  triggers/            <name>.json
  variables/           <name>.json  (+ <name>.js for Custom JavaScript)
  templates/           <name>/template.json + one file per section
  clients/             <name>.json  (server containers)
  transformations/     <name>.json  (server containers)
  zones/               <name>.json  (GTM 360)
  gtag-configs/        <id>.json    (Google tag configs have no name)
  folders.json
  built-in-variables.json
  .gitignore
  .gtm/                bookkeeping, never edit or commit
```

Files are written as 2-space indented JSON with a trailing newline. Key order and formatting never count as a change: GS Code compares canonical JSON (sorted keys). Code files are compared with LF line endings.

## Entity files

One JSON object per entity, in the folder for its kind:

| Kind | Folder | Id field GTM uses (not in the file) |
| --- | --- | --- |
| Tag | `tags/` | `tagId` |
| Trigger | `triggers/` | `triggerId` |
| Variable | `variables/` | `variableId` |
| Custom template | `templates/` (a folder per template) | `templateId` |
| Client | `clients/` | `clientId` |
| Transformation | `transformations/` | `transformationId` |
| Zone | `zones/` | `zoneId` |
| Google tag config | `gtag-configs/` | `gtagConfigId` |
| Folder | `folders.json` | `folderId` |

What is different from the API:

| API field | In the file |
| --- | --- |
| `firingTriggerId` | `firingTriggers`: a list of trigger references |
| `blockingTriggerId` | `blockingTriggers`: a list of trigger references |
| `parentFolderId` | `folder`: a folder reference |
| `type` of a custom-template entity (`cvt_…`) | `template:<template name>` |
| trigger ids inside `parameter` (type `triggerReference`) | trigger references |
| the entity's id, `path`, `accountId`, `containerId`, `workspaceId`, `fingerprint`, `tagManagerUrl` | left out (GTM owns them) |

Every other field is kept and sent back as is: `parameter`, `notes`, `paused`, `priority`, `consentSettings`, `setupTag`, `teardownTag`, `filter`, `customEventFilter`, `autoEventFilter`, schedule fields and anything GTM adds later.

A minimal tag:

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

Every named kind needs `name`, and every kind except templates needs `type`. Tag sequencing uses tag names: `"setupTag": [{ "tagName": "…" }]`.

### File names

The file name is a label. The entity's identity is its `name` inside the file (and, once pulled, its id in `.gtm/state.json`).

- **Rename an entity:** change `name` in the file. The file name does not matter.
- **Rename only the file:** the entity stays the same.
- **Delete the file:** the entity is deleted on push.
- **Add a file** with a `name` and `type`: the entity is created on push.

New files from a pull are named after the GTM name, made safe for macOS, Windows and Linux: `\ / : * ? " < > |` and control characters become `_`, runs of spaces collapse, trailing dots and spaces are dropped, names are cut to 120 bytes, and Windows device names (`con`, `nul`, `com1`…) get a leading `_`. If that name is already taken (case-insensitively), the id is added in brackets: `GA4 - purchase (42).json`. Google tag configs have no name, so their files are named by id.

When names in GTM change, file names stay as they were. `gscode tidy` (**Rename Files to Match GTM**) renames them; see [team.md](team.md#keep-file-names-the-same-in-every-clone).

## References

GTM links entities by numeric id. The files use these instead:

| Written as | Means | Used in |
| --- | --- | --- |
| `"My Trigger"` | the trigger or folder with that name | `firingTriggers`, `blockingTriggers`, trigger references in `parameter`, `folder` |
| `"builtin:All Pages"` | a built-in trigger with no entity of its own: `builtin:All Pages`, `builtin:Initialization - All Pages`, `builtin:Consent Initialization - All Pages` | trigger lists and trigger references |
| `"#2147479574"` | an id with no name locally, passed through untouched | trigger lists, trigger references, `folder` |
| `"template:My Template"` | the custom template with that name | `type` |

Names are resolved when you push, so a new tag can point at a trigger that is new in the same push. A name that does not resolve stops the push with an error naming the file (`unknown trigger "…"`, `unknown folder "…" (add it to folders.json)`, `unknown template "…"`).

Template types: a gallery template's type is `cvt_<galleryTemplateId>`; a template made in the container is `cvt_<containerId>_<templateId>`. A pull writes either as `template:<name>` when the template is in the workspace, and leaves any other `cvt_…` type as it is.

`{{Variable}}` references are text inside values, as in GTM. GS Code checks that each one is a variable in the mirror or an enabled built-in variable; names starting with `_` (GTM-internal, like `{{_event}}`) and anything inside `notes` are not checked.

## Code in its own file: `valueFile`

Two kinds of code are written to a separate file, so they get syntax highlighting:

| Entity | Parameter | File |
| --- | --- | --- |
| Tag of type `html` (Custom HTML) | `html` | `<file name>.html` |
| Variable of type `jsm` (Custom JavaScript) | `javascript` | `<file name>.js` |

In the JSON, the parameter's `value` is replaced by `valueFile`, the file name relative to the JSON file's folder:

```json
{
  "name": "cHTML - consent banner",
  "type": "html",
  "firingTriggers": ["builtin:All Pages"],
  "parameter": [
    { "type": "template", "key": "html", "valueFile": "cHTML - consent banner.html" },
    { "type": "boolean", "key": "supportDocumentWrite", "value": "false" }
  ]
}
```

When reading, `valueFile` works on any top-level parameter of any entity: the file's content becomes the parameter's `value` (with CRLF turned into LF). A missing file is an error: `tags/X.json: valueFile "X.html" not found`. When writing, GS Code only creates sidecars for the two cases above; other parameters are written inline.

If you rename the JSON file, rename the sidecar and update `valueFile` with it.

## Custom templates: `templates/<name>/`

A template is a folder. GTM stores its code as one `templateData` text made of `___SECTION___` blocks; GS Code splits it into one file per section:

| Section | File |
| --- | --- |
| `TERMS_OF_SERVICE` | `terms.txt` |
| `INFO` | `info.json` |
| `TEMPLATE_PARAMETERS` | `parameters.json` |
| `SANDBOXED_JS_FOR_WEB_TEMPLATE` / `SANDBOXED_JS_FOR_SERVER` | `code.js` |
| `WEB_PERMISSIONS` / `SERVER_PERMISSIONS` | `permissions.json` |
| `TESTS` | `tests.yaml` |
| `NOTES` | `notes.md` |
| any other | `<section in lower case>.txt` |

If two sections would get the same file, the second is named after its section in lower case with the same extension.

`template.json` is the manifest: the template's `name`, `galleryReference` for gallery templates, any other fields GTM returns, and `sections`, the list of sections in order with their files:

```json
{
  "name": "My Template",
  "sections": [
    { "section": "INFO", "file": "info.json" },
    { "section": "TEMPLATE_PARAMETERS", "file": "parameters.json" },
    { "section": "SANDBOXED_JS_FOR_WEB_TEMPLATE", "file": "code.js" },
    { "section": "WEB_PERMISSIONS", "file": "permissions.json" },
    { "section": "TESTS", "file": "tests.yaml" }
  ]
}
```

On push the sections are joined back in the manifest's order. A section file listed in the manifest but missing is an error: `templates/My Template/template.json: section file "code.js" not found`.

A new template folder can do without `template.json`. Then the folder name is the template name, and the sections are found from the file names in the table above (`code.js` and `permissions.json` count as web or server sections depending on the container), in the standard order.

Keep `name` in `template.json` the same as `displayName` in `info.json`; GS Code warns when they differ. Tags and variables that use the template refer to it as `template:<name>`.

## `folders.json`

All folders, as a JSON array sorted by name. Each entry is the API folder without its id and the GTM-owned fields, so at least `name`:

```json
[
  { "name": "GA4" },
  { "name": "Meta", "notes": "Pixel and CAPI" }
]
```

Add an entry to create a folder, remove it to delete it, and edit it to change it. Folders are matched by `name`; two entries with the same name are an error (`duplicate folder "…"`). Entities point at a folder with `"folder": "<name>"`.

## `built-in-variables.json`

The enabled built-in variables, as a JSON array of built-in variable **types**, sorted and without duplicates. Add a type to enable it, remove it to disable it. Use the type spelling that a pull writes: the API's `lowerCamel` `type` value, not the display name shown in GTM.

```json
["clickUrl", "event", "pageHostname", "pagePath", "pageUrl"]
```

`{{Display Name}}` references to built-ins are checked against the display names GTM reported at the last pull. A built-in you enabled locally since then is checked against GTM's standard display name (`pageUrl` is `{{Page URL}}`, `clickUrl` is `{{Click URL}}`), so you can enable it and reference it in the same push. Names from the last pull win over the standard ones.

## Container exports and enum spelling

You can paste entities from a GTM container export (Admin → Export Container). Exports spell enum values in `UPPER_SNAKE`; the API uses `lowerCamel`. On push GS Code converts:

- the `type` of every parameter and condition (any object with `key`, `value`, `list`, `map` or `parameter`): `TEMPLATE` → `template`, `TRIGGER_REFERENCE` → `triggerReference`, `MATCH_REGEX` → `matchRegex`, `BOOLEAN` → `boolean`, and so on;
- a trigger's own `type`: `CUSTOM_EVENT` → `customEvent`, `PAGEVIEW` → `pageview`.

Tag and variable types (`html`, `gaawe`, `cvt_…`) are left alone. Values that are not entirely upper case are never touched. After the push, the next pull writes GTM's copy, so the file then shows the API spelling.

Exports also carry ids and GTM-owned fields (`tagId`, `firingTriggerId`, `parentFolderId`, `accountId`, `fingerprint`…). GS Code does not convert these. Remove them, and write triggers and folders as references (`firingTriggers`, `folder`) the way a pulled file does.

## `.gtm/`

Bookkeeping for this folder's link to one workspace. Do not edit it, and never commit it ([team.md](team.md)).

| Path | |
| --- | --- |
| `.gtm/state.json` | Container, workspace, entity ids and fingerprints, conflicts |
| `.gtm/base/` | The last pulled copy: the left side of every diff |
| `.gtm/remote/` | GTM's copy of entities in conflict |
| `.gtm/merge/` | The latest version's copy of entities in a GTM merge conflict |
| `.gtm/backups/` | Working files saved before **Switch Workspace** |
| `.gtm/debug/` | Debugger session files ([debugger.md](debugger.md)) |
| `.gtm/lock` | Present while a process works on the folder: its pid, host, operation, start time and a random token. A long operation refreshes the start time every 60 seconds. |
| `.gtm/lock.<id>.tmp`, `.gtm/lock.guard` | Short-lived files used to take, refresh and release the lock. They disappear within moments; ignore them. A `lock.guard` left by a crash is ignored after 10 s. |
| `.gtm/README.txt` | A short note on the layout |
