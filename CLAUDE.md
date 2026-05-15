# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

DB Editor is a browser-based visual editor for designing relational databases. It is the database-design counterpart to [vtseditor](https://github.com/stefanwerfling/vtseditor) — same architecture (Vite-as-backend, jsPlumb canvas, JSON file as source of truth, generator emits target language), but the source of truth is a database model and the generator emits SQL DDL.

It is meant to replace the modeling half of MySQL Workbench. Forward-engineering only — no DB connection / SQL editor / data browser yet.

## Running

```bash
node ./cli/dev.js   # or: npm run dev
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

- `vite.config.ts` — Express middleware: loads config, builds repos, registers API routes, runs the generator after every flush of an `autoGenerate` project.
- `Config/Config.ts` — Vts schema for `dbeditor.json`. Adds `dialect` (mysql/mariadb/postgres/sqlite) and `output.mode` (`ddl-files` or `migrations`) compared to vtseditor.
- `DbProject/DbProject.ts` — runtime project type. Each project gets a `crypto.randomUUID()` handle that the frontend uses (project unids are not stable across server restarts).
- `DbRepository/DbFsRepository.ts` — per-project in-memory store. Mutations bump a revision, publish an event on the project's `DbRepositoryEventBus`, and schedule a debounced flush (150 ms). After every flush an optional hook runs the generator. CRUD methods exist for: containers (database/folder), tables, columns (incl. `reorderColumns`), indexes, foreign keys, enums (incl. value-level add/update/remove), views, and editor settings.
- `DbApi/DbApiRoutes.ts` — granular CRUD endpoints. Body validators are in `DbApiRequests.ts`. Routes mirror the repo: `/containers`, `/tables`, `/tables/:tid/columns`, `/tables/:tid/columns/order` (PUT, full new order), `/tables/:tid/indexes`, `/tables/:tid/foreignkeys`, `/enums`, `/enums/:unid/values`, `/views`, `/editor-settings`, `/generate`.
- `DbGenerator/DbGenerator.ts` — dispatches to a dialect implementation. Two output modes:
  - `ddl-files`: one `<table>.sql` per table, plus `<view>.view.sql` per view, plus `_enums.sql` per database (postgres only) and a single `_foreign_keys.sql` collecting cross-table FK constraints last.
  - `migrations`: one timestamped `*.up.sql` / `*.down.sql` pair (currently always re-emits an `init` pair — diff-based migrations are a later iteration). Up order: enums → tables → indexes → FKs → views. Down reverses.
- `DbGenerator/Dialects/{MySql,MariaDb,Postgres,Sqlite}Dialect.ts` — each implements the `DbDialect` interface (renderCreateTable / Index / addForeignKey / Enum / View + the matching Drops). SQLite emits FKs inline (no `ALTER TABLE ADD CONSTRAINT`); Postgres emits `CREATE TYPE` for ENUMs and `MATERIALIZED VIEW` when the flag is set; MySQL/MariaDB inline ENUM values into the column type.

### Frontend (browser side)

- `main.ts` → `DbEditor/DbEditor.ts` — single entry.
- `DbEditor/DbEditor.ts` is the controller. It loads `/api/load-schema`, builds `Treeview` + `WarningsPanel`, manages a single shared `jsPlumbInstance`, listens for **custom window events** declared in `Base/EditorEvents.ts`, and routes them to `DbApiClient`. Reconciliation on incoming SSE events is a full re-fetch — keep it that way until proven too slow.
- `DbEditor/JsonData.ts` — the wire format **and** the persisted file format. `JsonDataDB` is the recursive tree: project → database → folder → tables / views / enums. Both frontend and backend import this file; backend additionally validates with `SchemaJsonData` at boundaries.
- `DbEditor/Table/DbTable.ts` — one draggable card on the canvas. Renders the table name, columns (with PK/U/AI/NN flags + per-row hover-only `⋯` menu), an "indexes" section with editable rows + add affordance, and a read-only "foreign keys" summary. Column rows are drag-reorderable (custom mousedown/mousemove handler with 4 px threshold so click + dblclick still work). Each column row has a hover-only **grip** (`.db-table-column-grip`) that's a jsPlumb source-selector for FK creation, plus `data-column-unid` + `data-table-unid` attributes used by jsPlumb's `extract` option.
- `DbEditor/Table/DbColumnDialog.ts`, `DbIndexDialog.ts`, `DbForeignKeyDialog.ts`, `DbTableOptionsDialog.ts` — modal editors for the four objects you can attach to a table.
- `DbEditor/Enum/DbEnumDialog.ts` — name + values list (add / remove / inline-edit per value); the controller diffs the result against the current state and fires the matching API calls sequentially.
- `DbEditor/View/DbViewDialog.ts` — name + raw SELECT body in a monospace textarea + materialized flag. Returned object is sent verbatim through `updateView`.
- `DbEditor/Treeview/Treeview.ts` — sidebar. Setting an active container scopes the canvas to one database (or one folder). Each row has a hover-only `⋯` menu (rename inline, add child, delete) and a top-of-panel substring filter that hides non-matching rows + keeps their ancestors visible. **The project (root) row uses `p.data.unid` (= `"root"`) as its identifier, NOT the runtime project UUID `p.unid`** — the repo's `createContainer(parentUnid, …)` looks up parents in the data tree.
- `DbEditor/Validation/{SchemaValidator,WarningsPanel}.ts` — pure linter that walks the data tree (no PK, AI without PK, dangling FK / index references, multiple AIs, …) plus a sticky panel beneath the treeview that lists results with severity badges and click-to-jump-to-database. Re-runs on every reload.
- `DbEditor/Base/ContextMenu.ts` — `openContextMenu(anchor, items)`. The visible-action-button pattern is used everywhere (column row, table header, indexes, treeview rows, FK lines via click). **Don't add bare `contextmenu` listeners that act without showing a menu** — the user explicitly objected to that hidden-affordance UX.
- `DbEditor/Base/EditorEvents.ts` — every UI → controller communication is a `dispatch(EditorEvents.x, {...})` window event. Keeps DbTable / Treeview / dialogs decoupled from the API client.
- `DbEditor/Api/DbApiClient.ts` + `DbSseClient.ts` — HTTP + SSE wrappers. The API client generates a `clientId` UUID and sends it as `X-Client-Id` on every mutation; the SSE client filters out events whose `clientId` matches its own.

### The schema JSON file

`schemaPath` (default `./schemas/database.json`) holds the whole editor state as `{ fs: JsonDataDB, editor: {...} }`. This is the user's source of truth — generated `.sql` files under `output.destinationPath` are derived and can be regenerated.

## Things that will trip you up

- **ESM with `.js` imports in `.ts` files.** `package.json` has `"type": "module"` and `tsconfig.json` targets ESNext. Every internal import must use the `.js` extension even though the source is `.ts`. Required for Vite/Node ESM resolution.
- **No compile step.** `tsconfig.json` exists for the IDE / type checking only — TypeScript is never invoked by `npm run dev`. Vite transpiles on the fly. Do run `npm run lint` — the project has a strict ESLint config (`eslint:all`-derived) and CI is intended to gate on it.
- **The project dogfoods VTS.** Config, on-disk schema, and API request bodies all use `Vts.object(...).validate(...)` at their boundaries. When adding a new field to anything persisted or transmitted, update the matching `Schema...` validator or it will be silently rejected.
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
      "before_generate": [{"script": "...", "path": "..."}],
      "after_generate":  [{"script": "...", "path": "..."}]
    },
    "autoGenerate": false
  }],
  "server":  { "port": 5174, "limit": "10mb" },
  "browser": { "open": false }
}
```