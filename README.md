<p align="center">
  <img src="doc/logo.svg" alt="dbeditor — visual database designer" width="420">
</p>

# dbeditor

Visual database designer — the modeling half of MySQL Workbench, but as a browser-based tool that runs inside your project, reads/writes a single `database.json`, and regenerates SQL DDL on save. Forward-engineer to four dialects, live-sync against a real database, round-trip MySQL Workbench `.mwb` files, extend with npm-loaded plugins, and drive it from an MCP client.

Built as the database-schema counterpart to [vtseditor](https://github.com/stefanwerfling/vtseditor) — same architecture, different domain.

> **User guides:** [English](doc/guide.en.md) · [Deutsch](doc/guide.de.md) — full walk-through with screenshots covering tables, FKs, EER diagrams, views, enums, routines, generate, and live sync.

## Status

Beta. Multi-dialect, forward-engineering + live-sync, plugin- and MCP-extensible.

- **Four SQL dialects** — MySQL, MariaDB, PostgreSQL, SQLite. Each ships as a bundled plugin; third-party npm plugins can add more (see [Plugins](#plugins)).
- **Full UIs for every schema object**:
    - **Tables** — drag on the canvas, `⋯` for rename / table options (engine, charset, collation, tablespace, comment), click an FK line to edit / delete.
    - **Columns** — add / edit / inline-rename / delete; drag a row to reorder, drag the green dot to draw a foreign key onto another column.
    - **Indexes** — add `+` per table, edit type / column list (ASC/DESC + prefix length per column) / partial-index `WHERE` clause.
    - **Foreign keys** — drag-create with crow's-foot / one-bar ER notation; click the line to edit the constraint name + ON DELETE / ON UPDATE; auto-cardinality from PK/UNIQUE/NOT NULL flags; dashed line for nullable; composite FKs render one line per column pair; live anchor flip mid-drag.
    - **N:N junctions** — auto-detected from junction-table heuristic (composite PK = union of two FKs); a dashed `N:N via <junction>` line is drawn between the two outer tables. Toggle visibility with the topbar `N:N` button.
    - **Enums** — name + values list with inline editing. Postgres `CREATE TYPE`; MySQL inlines values into the column type; SQLite emits `TEXT CHECK (col IN (…))`.
    - **Views** — name + raw SELECT body in a monospace editor + materialized flag (Postgres).
    - **Routines** — stored procedures, functions, triggers. Pasted-body model (the user owns the full `CREATE … END` SQL); per-dialect framing (DELIMITER on MySQL, dollar-quoting on Postgres).
    - **Databases / folders** — create, rename, delete from the treeview.
- **EER diagrams** — multiple per database. A `JsonDiagram` is a logical "EER tab" (which tables/views belong to it); inside a diagram, `JsonLayer` groups visually arrange related cards in coloured rectangles, mirroring Workbench's Layers.
- **Live sync with a real database** — connect to MySQL/MariaDB/PostgreSQL/SQLite, introspect the running schema, diff against the model, and apply changes either as live DDL or as a generated migration. Renames are paired manually (drop+add → rename) from the dialog. Each apply writes a timestamped `*.up.sql` / `*.down.sql` pair to the output path; the history dialog shows every past sync run.
- **Test-run mode** — apply against a dump → fresh restore round-trip before touching production (MySQL today).
- **Schema warnings panel** under the treeview flags: tables without PK, AI without PK, multiple AI columns, dangling FK / index references, empty tables. Click a warning to jump to the relevant database.
- **Treeview filter** — case-insensitive substring match, keeps ancestors of matches visible.
- **Search palette** — `Ctrl-K` over every database, table, column, view, enum, routine, diagram, layer.
- **FK-aware arrange** — `Arrange` lays tables out by FK dependency level (parents left, children right).
- **Undo / redo** — every mutation; toolbar buttons + `Ctrl-Z` / `Ctrl-Shift-Z`.
- **Zoom** — toolbar + `Ctrl-+` / `Ctrl--` / `Ctrl-0` / `F` (fit-to-view).
- **MySQL Workbench `.mwb` round-trip** — `File → Open .mwb` reads tables, columns, FKs, indexes, views, routines, diagrams + layers; `File → Save as .mwb` writes them back. Per-object original XML is preserved so unchanged objects come out byte-identical.
- **Live SSE sync** between browser tabs — multiple windows stay consistent without polling.
- **Output modes:**
    - `ddl-files`: one `<table>.sql` per table, plus `<view>.view.sql`, plus `_enums.sql` (Postgres) and `_foreign_keys.sql` written last so loading in alphabetical order doesn't fail.
    - `migrations`: timestamped `*.up.sql` / `*.down.sql` pairs.
- **Markdown documentation generator** — `GET /docs` returns a per-database Markdown reference.
- **[MCP server](#mcp-server)** — read + (policy-gated) mutate the schema from Claude Code, Cursor, or any MCP-compatible client.
- **[Plugin system](#plugins)** — load npm packages that contribute dialects, drivers, file formats, or generate-hooks.

Not yet:

- Canvas pan / multi-select
- SQL editor / data browser (intentionally out of scope — this is the modeling tool, not a DBA tool)

## Getting started

```bash
# inside your project
npm install --save-dev git+https://github.com/stefanwerfling/dbeditor.git
npx dbeditor
```

The first run drops a default `dbeditor.json` at the project root:

```jsonc
{
  "projects": [{
    "name": "MyDatabase",
    "schemaPath": "./schemas/database.json",
    "dialect": "mysql",
    "output": {
      "mode": "ddl-files",
      "destinationPath": "./schemas/sql",
      "destinationClear": false,
      "sqlComment": true,
      "sqlIndent": "    ",
      "statementTerminator": ";"
    },
    "autoGenerate": false
  }],
  "server":  { "port": 5174 },
  "browser": { "open": false }
}
```

Editor opens at **http://localhost:5174**.

Typical workflow:

1. `Add Table` from the topbar (or `⋯` → `Add table` on a database in the treeview) to create a table inside the active database.
2. Click `+ add column` on a card, fill in name / type / flags. Drag column rows to reorder.
3. Drag the green dot on a column over to a column on another table → a `Foreign key` dialog opens for the constraint name + ON DELETE / ON UPDATE.
4. Click `+` in the indexes section to add an index, pick columns + ASC/DESC.
5. Click `Generate SQL` (or set `autoGenerate: true` in `dbeditor.json`) — files appear under `output.destinationPath`.

The treeview's `⋯`-menu is the central place for everything that's not on the canvas: creating databases / folders / enums / views / routines / diagrams, renaming, deleting, opening the matching editor.

> 📖 For the full walk-through with screenshots — EER diagrams, FK creation, live-sync workflow, keyboard shortcuts, etc. — see the **[English](doc/guide.en.md)** or **[German](doc/guide.de.md)** user guide.

## Live sync with a database

Configure one or more `connections` per project — each one binds a model-side database container (by its `databaseUnid`) to a real DB. Credentials live in `dbeditor.json` with `${VAR}` / `${VAR:-default}` env-placeholder syntax; the resolver substitutes from `process.env` (and `.env` if present) after VTS validation, so credentials never end up in the schema JSON.

```jsonc
{
  "projects": [{
    "name": "MyDatabase",
    "dialect": "postgres",
    "schemaPath": "./schemas/database.json",
    "output": { "mode": "ddl-files", "destinationPath": "./schemas/sql" },
    "connections": [{
      "databaseUnid": "db-xyz",
      "host": "${PG_HOST:-localhost}",
      "port": 5432,
      "user": "${PG_USER}",
      "password": "${PG_PASSWORD}",
      "database": "myapp",
      "schema": "public",
      "ssl": false,
      "readOnly": false
    }],
    "sync": {
      "ignoreTables": ["schema_migrations"],
      "ignoreColumnAttributes": ["collation"]
    }
  }]
}
```

In the editor, a database container with a connection picks up a *Sync with DB* action. The flow:

1. **Refresh** — fetch the live schema.
2. **Diff** — compare model vs. live. Each change is listed with severity (`safe` / `warn` / `destructive`) and previewed SQL.
3. **Pair renames** (optional) — click `⋯` on a `dropped` row, pick the matching `added` row → drop+add collapses into a `renamed` change.
4. **Apply** — runs the SQL statement-by-statement; on success, writes a timestamped `*.up.sql` / `*.down.sql` migration pair to `output.destinationPath`. Test-run mode wraps the apply against a dump → restore round-trip first (MySQL only today).
5. **Reverse-apply** — pull live changes back into the model.
6. **History** — every past sync run is recorded per connection with the combined SQL block.

Multi-schema Postgres setups: one `database` container per schema in the model, one connection per container with its own `schema` field.

## MCP server

Drive dbeditor from an [Model Context Protocol](https://modelcontextprotocol.io/) client (Claude Code, Cursor, Continue, …). The server exposes 39 tools — 12 read, 27 mutation — covering every JsonDataDB object: projects, tree, tables, columns, indexes, foreign keys, containers, enums, enum values, views, routines, diagrams. Every mutation goes through the same `DbFsRepository` the web editor uses, so SSE fires and `autoGenerate` runs identically.

Opt in via `dbeditor.json`:

```jsonc
{
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

Policy actions: `allow`, `ask`, `deny`. Wildcards (`*` only); rules evaluated top-down, first match wins. The default is `ask` — Claude Code and friends prompt before each mutation. `deny` hides the tool from the listing entirely. The transport is streamable HTTP at the configured path; point your MCP client at `http://localhost:5174/mcp` (with the configured `server.port`).

> ⚠ The MCP endpoint trusts whoever can reach it. Bind to `localhost` for development; put the dev server behind auth if you expose it.

## Plugins

Four plugin kinds, all loaded by `editor_core/Plugin/PluginBootstrap`:

| Kind                   | What it contributes                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `DialectPlugin`        | SQL DDL renderer for a dialect. The four bundled dialects extend this.              |
| `DbConnectionPlugin`   | Live-DB driver + paired introspector + optional dump adapter. Bundled: mysql/mariadb/postgres/sqlite. |
| `FileFormatPlugin`     | Round-trip file format. Bundled: MySQL Workbench `.mwb`.                            |
| `GenerationHookPlugin` | `beforeGenerate` / `afterGenerate` hooks fired inside `DbGenerator.generate()`.     |

Third-party plugins ship as npm packages. List them in `dbeditor.json:plugins` — installation alone doesn't activate; the config list is the opt-in gate:

```jsonc
{
  "plugins": [
    "my-typeorm-generator-plugin",
    "@scoped/my-clickhouse-dialect"
  ]
}
```

Restart the dev server to pick up `plugins` changes (no hot-reload). Per-package failures are logged, not fatal.

## Configuration

| Field                                       | Type                                                  | Notes                                                                |
| ------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| `projects[].name`                           | string                                                | Display name.                                                        |
| `projects[].dialect`                        | `mysql` / `mariadb` / `postgres` / `sqlite`           | Picks the DDL renderer.                                              |
| `projects[].schemaPath`                     | path                                                  | The `database.json` source-of-truth file.                            |
| `projects[].output.mode`                    | `ddl-files` / `migrations`                            | One file per table, or up/down migration pairs.                      |
| `projects[].output.destinationPath`         | path                                                  | Where SQL is written.                                                |
| `projects[].output.destinationClear`        | bool                                                  | Wipe the destination on every generate.                              |
| `projects[].output.migrationFilenamePattern`| string                                                | Migrations only. Default `{timestamp}__{name}`.                      |
| `projects[].scripts.before_generate`        | array of `{script, path}`                             | Shell hooks run before / after each generate.                        |
| `projects[].scripts.after_generate`         | array of `{script, path}`                             |                                                                      |
| `projects[].connections[]`                  | array of connection configs                           | Bind model `databaseUnid` to a live DB. See [Live sync](#live-sync-with-a-database). |
| `projects[].sync.ignoreTables`              | array of strings                                      | Names excluded from diff on both sides.                              |
| `projects[].sync.ignoreColumnAttributes`    | array of strings                                      | Per-column attributes excluded from diff (e.g. `collation`, `charset`). |
| `projects[].autoGenerate`                   | bool                                                  | Regenerate after every saved mutation.                               |
| `server.port`                               | number                                                | HTTP port (default `5174`).                                          |
| `server.limit`                              | string                                                | Body parser limit (default `10mb`).                                  |
| `browser.open`                              | bool                                                  | Auto-open the browser when the dev server starts.                    |
| `plugins[]`                                 | array of strings                                      | npm package names of plugins to load. See [Plugins](#plugins).       |
| `mcp`                                       | `{enabled, path, policy, logging}`                    | Opt-in MCP endpoint. See [MCP server](#mcp-server).                  |

Environment placeholders work in any string value: `${VAR}` (required) or `${VAR:-default}`. Use `$$` to emit a literal `$`. Substitution happens after VTS validation, so credentials never have to live in the JSON.

## Development

```bash
npm install
npm run dev          # vite dev server with the editor at localhost:5174
npm test             # vitest (tests/ mirrors source dirs)
npm run lint         # ESLint over all .ts (eslint:all + @typescript-eslint + @stylistic + prefer-arrow)
npm run lint:fix     # auto-fix what ESLint can
```

`tsconfig.json` is for IDE type-checking only; `npm run dev` runs Vite directly without a compile step.

Repo layout:

```
BundledPlugins/   bundled dialect / driver / format plugins (MySql, MariaDb, Postgres, Sqlite, Mwb)
editor_backend/   Node-side core (Config loader, repos, generator, diff, introspector, sync executor, doc generator)
editor_frontend/  browser-side editor (main.ts entry + DbEditor/)
editor_schemas/   shared schema (JsonData.ts)
editor_core/      transport-agnostic plugin registry (Plugin/) + MCP server (Mcp/)
cli/              dbeditor CLI entry
tests/            mirrors source layout
```

See **[CLAUDE.md](CLAUDE.md)** for full architecture notes — the hooks, the gotchas (jsPlumb mousedown delegation, SQLite has no `ALTER TABLE ADD CONSTRAINT`, Postgres ENUMs are types not column-inline lists, …), and the file-by-file rundown.