# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

DB Editor is a browser-based visual editor for designing relational databases. It is the database-design counterpart to [vtseditor](https://github.com/stefanwerfling/vtseditor) — same architecture (Vite-as-backend, jsPlumb canvas, JSON file as source of truth, generator emits target language), but the source of truth is a database model and the generator emits SQL DDL.

It is meant to replace the modeling half of MySQL Workbench. **Forward-engineering** (SQL generation from the model) plus **live introspection + sync** (read a target DB's schema, diff against the model, apply changes either as live DDL or as a generated migration). No SQL editor or data browser — purely schema work.

## Running

```bash
node ./cli/dev.js   # or: npm run dev
npm test            # vitest (tests/ mirrors source dirs)
npm run lint        # ESLint over all .ts (eslint:all + @typescript-eslint + @stylistic + prefer-arrow)
npm run lint:fix    # auto-fix what ESLint can
```

`cli/dev.js`:
1. Resolves `dbeditor.json` from `process.cwd()`, creating a default if missing.
2. Sets `DBEDITOR_PROJECT_ROOT` and `DBEDITOR_CONFIG_FILE`.
3. Boots `vite.config.ts` as the dev server.

When hacking the editor itself, the working directory **is** the project root. `.gitignore` excludes `dbeditor.json`, `schemas/`, and `.env` because they are per-user.

## Architecture

Identical pattern to vtseditor: `vite.config.ts` is actually the **backend** — it registers an Express app onto Vite's dev server via `expressMiddleware()`. All persistence and the SQL generator live there.

### Backend (Node side, loaded by Vite)

- `vite.config.ts` — Express middleware: bootstraps the plugin registry, loads `dbeditor.json`, resolves env placeholders, builds repos, registers API routes, optionally mounts the MCP HTTP endpoint, and runs the generator after every flush of an `autoGenerate` project.
- `Config/Config.ts` — Vts schema for `dbeditor.json`. Top-level fields: `projects`, `server`, `browser`, `plugins` (npm-loaded extensions), `mcp` (Model Context Protocol endpoint). `EnvPlaceholderResolver.resolve()` substitutes `${VAR}` / `${VAR:-default}` from `process.env` after validation. `ProjectConfig` and `ConnectionConfig` classes own the add/update/remove/rebind config-file mutations triggered by the project + connection management dialogs.
- `DbProject/DbProject.ts` — runtime project type. Each project gets a `crypto.randomUUID()` handle that the frontend uses (project unids are not stable across server restarts).
- `DbRepository/DbFsRepository.ts` — per-project in-memory store for the **model** side. Mutations bump a revision, publish an event on the project's `DbRepositoryEventBus`, and schedule a debounced flush (150 ms). After every flush an optional hook runs the generator. CRUD covers containers (database/folder), tables, columns (incl. `reorderColumns`), indexes, foreign keys, enums (incl. value-level), views, routines, diagrams + layers, and editor settings. Also caches per-object MWB-original XML (for lossless round-trip).
- `DbRepository/DbLiveRepository.ts` — per-project store for the **live-introspected** side. `refresh(databaseUnid)` connects via the matching `DbConnectionPlugin`, calls `driver.introspector().introspect(...)`, and caches the result. Drives the Sync-with-DB feature.
- `DbApi/DbApiRoutes.ts` — granular CRUD + sync + import/export endpoints. Body validators in `DbApiRequests.ts`. Mirrors the repo: `/containers`, `/tables`, `/tables/:tid/columns`, `/tables/:tid/columns/order` (PUT, full new order), `/tables/:tid/indexes`, `/tables/:tid/foreignkeys`, `/enums`, `/enums/:unid/values`, `/views`, `/routines`, `/diagrams`, `/diagrams/:did/layers`, `/editor-settings`, `/generate`, `/mwb-import`, `/mwb-export`, `/live/refresh`, `/sync/diff`, `/sync/apply`, `/sync/reverse-apply`, `/sync/test-run`, `/sync/history`, `/docs`.
- `DbGenerator/DbGenerator.ts` — dispatches to a dialect plugin. Two output modes:
  - `ddl-files`: one `<table>.sql` per table, plus `<view>.view.sql` per view, plus `_enums.sql` per database (postgres only), plus a single `_foreign_keys.sql` collecting cross-table FK constraints last, plus `<routine>.{procedure,function,trigger}.sql` per routine.
  - `migrations`: one timestamped `*.up.sql` / `*.down.sql` pair (currently always re-emits an `init` pair — diff-based migrations from the live side flow through `DbGenerator/Sync/SyncGenerator.ts` instead). Up order: enums → tables → indexes → FKs → views → routines. Down reverses.
  - **Hooks**: `generate()` invokes every registered `GenerationHookPlugin.beforeGenerate` / `afterGenerate`, then the user's `scripts.before_generate` / `scripts.after_generate` shell commands. Dry-run skips both.
- `DbGenerator/Dialects/{MySql,MariaDb,Postgres,Sqlite}Dialect.ts` — each extends `DialectPlugin` (renderCreateTable / Index / addForeignKey / Enum / View / Routine + the matching Drops). SQLite emits FKs inline (no `ALTER TABLE ADD CONSTRAINT`); Postgres emits `CREATE TYPE` for ENUMs and `MATERIALIZED VIEW` when the flag is set; MySQL/MariaDB inline ENUM values into the column type.
- `DbConnection/Drivers/{Mysql,Postgres,Sqlite}Driver.ts` — each extends `DbConnectionPlugin` and pairs with an introspector via `introspector()`. MysqlDriver covers both `mysql` and `mariadb` via `supportedDialects` and also overrides `dumpAdapter()` for the test-run dump/restore path.
- `DbIntrospect/{Mysql,Postgres,Sqlite}Introspector.ts` — read live schema → `JsonDataDB`. Shared utilities `LiveUridScheme` (URI scheme for unids) and `FkActionMapper`. Postgres has the most surface area (functions/procedures, materialized views, schema name handling).
- `DbDiff/SchemaDiff.ts` + `ColumnEquivalence.ts` — diff a model `JsonDataDB` against a live one; emits a `SchemaChangeSet` with deterministic change IDs (the sync flow filters by IDs across multiple server roundtrips). `SyncGenerator` translates the changeset to dialect-specific DDL.
- `DbSyncExecutor/{SyncExecutor,SyncTestRunner,MigrationPairWriter,SyncHistoryRepo}.ts` — apply DDL live, optionally test against a dump/restore round-trip, write migration pairs, persist apply-history per project. `DumpAdapter` interface; MysqlDumpAdapter is the only impl today.
- `DbDoc/MarkdownDocGenerator.ts` — `MarkdownDocGenerator.generate(data, project)` produces a per-database Markdown reference. Routed at `/docs`.
- `DbMwbImport/{MwbReader,MwbWriter}.ts` + `MwbFileFormatPlugin.ts` — MySQL Workbench `.mwb` parser + writer. The plugin wraps the reader/writer and registers via the plugin system so the file-format-dispatch surface is uniform.
- `editor_core/plugin/` — see **Plugin system** section below.
- `editor_core/Mcp/` — see **MCP server** section below.

### Frontend (browser side)

- `main.ts` → `DbEditor/DbEditor.ts` — single entry.
- `DbEditor/DbEditor.ts` is the controller. It loads `/api/load-schema`, builds `Treeview` + `WarningsPanel`, manages a single shared `jsPlumbInstance`, listens for **custom window events** declared in `Base/EditorEvents.ts`, and routes them to `DbApiClient`. Reconciliation on incoming SSE events is a full re-fetch — keep it that way until proven too slow.
- `DbEditor/JsonData.ts` — the wire format **and** the persisted file format. `JsonDataDB` is the recursive tree: project → database → folder → tables / views / enums. Both frontend and backend import this file; backend additionally validates with `SchemaJsonData` at boundaries.
- `DbEditor/Table/DbTable.ts` — one draggable card on the canvas. Renders the table name, columns (with PK/U/AI/NN flags + per-row hover-only `⋯` menu), an "indexes" section with editable rows + add affordance, and a read-only "foreign keys" summary. Column rows are drag-reorderable (custom mousedown/mousemove handler with 4 px threshold so click + dblclick still work). Each column row has a hover-only **grip** (`.db-table-column-grip`) that's a jsPlumb source-selector for FK creation, plus `data-column-unid` + `data-table-unid` attributes used by jsPlumb's `extract` option.
- `DbEditor/Table/DbColumnDialog.ts`, `DbIndexDialog.ts`, `DbForeignKeyDialog.ts`, `DbTableOptionsDialog.ts` — modal editors for the four objects you can attach to a table.
- `DbEditor/Enum/DbEnumDialog.ts` — name + values list (add / remove / inline-edit per value); the controller diffs the result against the current state and fires the matching API calls sequentially.
- `DbEditor/View/DbViewDialog.ts` — name + raw SELECT body in a monospace textarea + materialized flag. Returned object is sent verbatim through `updateView`.
- `DbEditor/Treeview/Treeview.ts` — sidebar. Setting an active container scopes the canvas to one database (or one folder). Each row has a hover-only `⋯` menu (rename inline, add child, delete) and a top-of-panel substring filter that hides non-matching rows + keeps their ancestors visible. EER diagrams expand to show member tables/views. **The project (root) row uses `p.data.unid` (= `"root"`) as its identifier, NOT the runtime project UUID `p.unid`** — the repo's `createContainer(parentUnid, …)` looks up parents in the data tree.
- `DbEditor/Diagram/` — EER-diagram UI. `JsonDiagram` = logical tab (which tables/views belong to it); `JsonLayer` = visual Group rectangle inside one diagram. The split is settled — don't re-conflate them. See `memory/project_diagram_layer_split.md` for the data-model details.
- `DbEditor/Sync/SyncDialog.ts` + `SyncHistoryDialog.ts` — UI for the live-introspect + diff + apply + reverse-apply + test-run flow. History dialog shows past sync runs per connection with the combined SQL block.
- `DbEditor/Settings/{AddConnectionDialog,EditConnectionDialog,RebindConnectionDialog,ProjectInfoDialog}.ts` — project + live-DB connection management UI; mutations go through the `ProjectConfig` / `ConnectionConfig` API endpoints which rewrite `dbeditor.json`.
- `DbEditor/Search/SearchPalette.ts` — Ctrl-K palette. Built on top of `SearchIndex.build(data)` which indexes databases, tables, columns, views, enums, routines, diagrams, layers.
- `DbEditor/Validation/{SchemaValidator,WarningsPanel}.ts` — pure linter that walks the data tree (no PK, AI without PK, dangling FK / index references, multiple AIs, …) plus a sticky panel beneath the treeview that lists results with severity badges and click-to-jump-to-database. `SchemaValidator.validate(data)` is called on every reload.
- `DbEditor/Base/ContextMenu.ts` — `ContextMenu.open(anchor, items)`. The visible-action-button pattern is used everywhere (column row, table header, indexes, treeview rows, FK lines via click). **Don't add bare `contextmenu` listeners that act without showing a menu** — the user explicitly objected to that hidden-affordance UX.
- `DbEditor/Base/EditorEvents.ts` — every UI → controller communication is an `EditorEventBus.dispatch(EditorEvents.x, {...})` window event. Keeps DbTable / Treeview / dialogs decoupled from the API client.
- `DbEditor/Api/DbApiClient.ts` + `DbSseClient.ts` — HTTP + SSE wrappers. The API client generates a `clientId` UUID and sends it as `X-Client-Id` on every mutation; the SSE client filters out events whose `clientId` matches its own.
- `DbEditor/Util/{Icons,Rect,Zoom,CrowsFoot,FkCardinality,SearchIndex}.ts` — static-method utility classes. Each free icon getter is `Icons.check()` / `Icons.ellipsis()` etc.; FK marker SVGs are `FkMarkers.crowsFoot` / `FkMarkers.oneBar`; zoom is `Zoom.clamp` / `Zoom.step` / `Zoom.DEFAULT` etc. Subclass-able for icon-providing plugins (the protected `makeSvg` / `svgRoot` hooks).
- `DbEditor/jsPlumbInstance.ts` — `JsPlumbHost.getInstance()` returns the process-singleton jsPlumb instance.

### The schema JSON file

`schemaPath` (default `./schemas/database.json`) holds the whole editor state as `{ fs: JsonDataDB, editor: {...} }`. This is the user's source of truth — generated `.sql` files under `output.destinationPath` are derived and can be regenerated.

## Plugin system

`editor_core/plugin/` defines four plugin kinds and a process-wide singleton registry. Bundled implementations register at boot (`PluginBootstrap.bootstrapBuiltins()` called from `vite.config.ts`); npm-installed plugins listed in `dbeditor.json:plugins` are loaded by `PluginBootstrap.loadFromConfig(packages, projectRoot)`. Installation alone doesn't activate — the config list is the opt-in gate.

- `DialectPlugin` — SQL DDL renderer. All four bundled dialects (mysql / mariadb / postgres / sqlite) extend it. `pickDialect(name)` is a pure registry lookup with lazy bootstrap fallback.
- `DbConnectionPlugin` — live-DB driver + paired introspector + optional dump adapter. `pickDriver(dialect)` is the same lazy-bootstrap registry lookup. `MysqlDriver.supportedDialects = ['mysql','mariadb']` so one plugin covers both wire-protocol-compatible dialects.
- `FileFormatPlugin` — round-trip file format. `MwbFileFormatPlugin` is the only bundled instance; resolved through `PluginRegistry.instance.fileFormat('mwb')` in the `/mwb-import` / `/mwb-export` routes.
- `GenerationHookPlugin` — `beforeGenerate` / `afterGenerate` callbacks fired inside `DbGenerator.generate()`. No bundled hook plugin today; a TypeORM class generator is the planned first consumer.

External plugins ship as npm packages. The loader uses `createRequire` rooted at the project's `package.json` (so resolution honours the user's `node_modules`, not the editor's), walks module exports, and registers either Plugin instances or Plugin-subclass constructors. Per-package failures are logged, not fatal. Hot-reload is not supported — restart the dev server to pick up `plugins` list changes.

## MCP server

`editor_core/Mcp/` implements a Model Context Protocol server that lets MCP clients (Claude Code, Cursor, …) read and (with policy opt-in) mutate the dbeditor schema through the same repository the web editor uses. Opt in via `mcp.enabled = true` in `dbeditor.json`. Read tools: `db_list_projects` / `db_get_tree` / `db_list_tables` / `db_get_table`. Mutation tools cover the full schema surface: `db_create_table` / `db_update_table` / `db_delete_table` / `db_add_column` / `db_update_column` / `db_delete_column` / `db_add_index` / `db_update_index` / `db_delete_index` / `db_add_foreign_key` / `db_update_foreign_key` / `db_delete_foreign_key` / `db_create_container` / `db_update_container` / `db_delete_container` / `db_create_enum` / `db_update_enum` / `db_delete_enum` / `db_add_enum_value` / `db_update_enum_value` / `db_delete_enum_value` / `db_create_view` / `db_update_view` / `db_delete_view` / `db_create_routine` / `db_update_routine` / `db_delete_routine`. Mutations are gated by the policy — default `ask` (rejected without approval handler), so users must explicitly `allow` them via `mcp.policy.rules`. Every mutation goes through the same `DbFsRepository` methods the web API uses, so SSE fires and autoGenerate runs identically.

- `McpToolRegistry.ts` — transport-agnostic dispatcher. Validates args against the tool's VTS schema before dispatch, catches handler exceptions, never throws.
- `McpPolicy.ts` — `compile(mcp)` → `(toolName) → allow|ask|deny`. Wildcard patterns (`*` only); rules evaluated in declared order, first match wins; no policy → allow; policy block present without `default` → ask; no rule matches → policy default. Denied tools are hidden from `list()`; ask-tool descriptions get a "⚠ Requires user approval" prefix; ask calls without an approval handler are rejected.
- `McpServer.ts` — thin SDK wrapper. `McpServer.create(registry, ctx)` wires `tools/list` + `tools/call` handlers to the registry. `buildInstructions(ctx)` emits the "treat schema files as READ-ONLY, use db_* tools" guidance the client surfaces to the model.
- HTTP transport mounted in `vite.config.ts:mountMcpEndpoint`. Stateful streamable HTTP — each `initialize` mints a session id in `Mcp-Session-Id`; subsequent calls within the session route to the same transport.
- Approval handler intentionally absent — dbeditor doesn't ship an in-app approval UI yet, so ask-action tools currently return a "not confirmed" error. Users wire `allow` for read-only tools and skip mutations until the UI lands.

## Things that will trip you up

- **ESM with `.js` imports in `.ts` files.** `package.json` has `"type": "module"` and `tsconfig.json` targets ESNext. Every internal import must use the `.js` extension even though the source is `.ts`. Required for Vite/Node ESM resolution.
- **No compile step.** `tsconfig.json` exists for the IDE / type checking only — TypeScript is never invoked by `npm run dev`. Vite transpiles on the fly. Do run `npm run lint` — the project has a strict ESLint config (`eslint:all`-derived) and CI is intended to gate on it.
- **The project dogfoods VTS.** Config, on-disk schema, and API request bodies all use `Vts.object(...).validate(...)` at their boundaries. When adding a new field to anything persisted or transmitted, update the matching `Schema...` validator or it will be silently rejected. MCP tool inputs go through the same VTS-validate path before dispatch (`VtsJsonSchema.convert` exposes the schema as JSON Schema draft-7 for the MCP `tools/list` response).
- **No free functions in editor code.** Per user mandate: every helper lives on a class as a static method, even single-function modules. The three intentional exceptions are thin factory wrappers (`pickDriver`, `pickDialect`, `registerDbApiRoutes`) plus `DbApiRoutes.ts` internal helpers scoped to the registrar function and `vite.config.ts:resolveListenPort`. Don't introduce new `export function …` modules — fold the body into a class with one or more `public static` methods. Internal-only helpers go on the same class as `private static _name`.
- **Project identity is a runtime UUID**, not a stable ID. Frontend-sent `pid`s for projects must match a UUID the *current* server process generated — restart = new UUIDs. This matters when debugging save failures after code reloads. The data-tree root (`p.data.unid`) is the literal string `"root"` and is stable across restarts.
- **CSS design tokens live in `main.css` `:root`.** `--c-primary`, `--c-pk`, `--c-fk`, `--c-uk`, `--radius-*`, etc. Prefer them over hardcoded hex values.
- **SQLite has no `ALTER TABLE ADD CONSTRAINT`.** `SqliteDialect.renderAddForeignKey()` returns `null` and FKs are inlined into the body of `renderCreateTable`. Don't accidentally add the FK twice.
- **Postgres ENUMs are types, not column-inline lists.** `PostgresDialect.renderCreateEnum()` emits `CREATE TYPE ... AS ENUM (...)` and column types resolve to the type name. The DDL-files generator writes a separate `_enums.sql` per database for these. SQLite has no native ENUM — it falls back to `TEXT CHECK (col IN (…))`.
- **`.db-table` needs `user-select: none`.** Without it, mousedown-drag on text-bearing column rows starts text selection instead of letting jsPlumb start a card or FK drag. A single `.db-table input { user-select: text; }` exception keeps the inline rename inputs editable.
- **jsPlumb mousedown is delegated on the container.** `instance.on(container, 'mousedown', SELECTOR_MANAGED_ELEMENT, …)` — so any descendant that calls `e.stopPropagation()` on mousedown breaks both card-drag and connection-drag. The grip element used to do this and FK drag silently failed; **don't restore that listener**.
- **Use jsPlumb's `extract`, not `parameterExtractor`, to surface DOM data on a connection.** `extract: {'data-column-unid': 'columnUnid'}` calls `mergeParameters` on the source/target endpoint and the values are then readable as `info.sourceEndpoint.parameters.columnUnid` in the `connection` event. `parameterExtractor`'s return ends up at the wrong place. The grip span and column row both carry the two data attributes for this reason.
- **Tearing down the temporary FK drag connection inside the `connection` event needs `setTimeout(…, 0)`.** jsPlumb's post-fire code touches `jpc.endpoints` and a synchronous `deleteConnection` in the handler trips a null-deref crash.
- **`_arrange` updates `t.pos` locally and then calls `_renderCanvas`.** SSE filters out our own clientId, so a `_reload` after the API call doesn't fire. Setting only `card.element.style.left/top` would leave FK anchor sides cached at the pre-arrange positions.

## Config reference

The authoritative schema is `Config/Config.ts`. Key fields:

```jsonc
{
  "projects": [{
    "name": "MyDatabase",
    "schemaPath": "./schemas/database.json",
    "dialect": "mysql",            // mysql | mariadb | postgres | sqlite
    "output": {
      "mode": "ddl-files",         // ddl-files | migrations
      "destinationPath": "./schemas/sql",
      "destinationClear": false,
      "sqlComment": true,
      "sqlIndent": "    ",
      "statementTerminator": ";",
      "migrationFilenamePattern": "{timestamp}__{name}"  // migrations mode only
    },
    "scripts": {
      // Executed by DbGenerator.generate(): `script` runs in the
      // platform shell, `cwd` = path (empty -> process.cwd).
      // Non-zero exit aborts the generate. Skipped in dry-run.
      "before_generate": [{"script": "...", "path": "..."}],
      "after_generate":  [{"script": "...", "path": "..."}]
    },
    "connections": [/* per-database live-DB connections, see SchemaConfigProjectConnection */],
    "sync": { "ignoreTables": [], "ignoreColumnAttributes": [] },
    "autoGenerate": false
  }],
  "server":  { "port": 5174, "limit": "10mb" },
  "browser": { "open": false },
  // Opt-in list of npm-installed plugin packages. Installation alone does
  // not activate — only entries here are loaded.
  "plugins": ["my-typeorm-generator-plugin"],
  // Opt-in MCP endpoint (omit -> no endpoint).
  "mcp": {
    "enabled": true,
    "path": "/mcp",
    "policy": {
      "default": "ask",
      "rules": [
        {"match": "db_list_*", "action": "allow"},
        {"match": "db_get_*",  "action": "allow"},
        {"match": "db_delete_*", "action": "deny"}
      ]
    },
    "logging": { "enabled": true, "file": "./mcp.log" }
  }
}
```