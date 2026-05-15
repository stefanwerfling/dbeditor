# dbeditor

Visual database designer — the modeling half of MySQL Workbench, but as a browser-based tool that runs inside your project, reads/writes a single `database.json`, and regenerates SQL DDL on save.

Built as the database-schema counterpart to [vtseditor](https://github.com/stefanwerfling/vtseditor) — same architecture, different domain.

## Status

Beta. Forward-engineering only.

- Multi-dialect: **MySQL, MariaDB, PostgreSQL, SQLite**
- Full UIs for the standard schema objects:
    - **Tables** — drag on the canvas, click `⋯` for rename / table options (engine, charset, collation, tablespace, comment), right-click on the canvas line to edit / delete a foreign key.
    - **Columns** — add / edit / inline-rename / delete; drag a row to reorder, drag the green dot to draw a foreign key onto another column.
    - **Indexes** — add `+` per table, edit type / column list (with ASC/DESC + prefix length per column) / partial-index `WHERE` clause.
    - **Foreign keys** — drag-create with crow's-foot / one-bar ER notation; click the line to edit the constraint name + ON DELETE / ON UPDATE; auto-cardinality from PK/UNIQUE/NOT NULL flags; dashed line for nullable; composite FKs render one line per column pair.
    - **N:N junctions** — auto-detected from junction-table heuristic (composite PK = union of two FKs); an extra dashed `N:N via <junction>` line is drawn between the two outer tables. Toggle visibility with the topbar `N:N` button.
    - **Enums** — name + values list with inline editing.
    - **Views** — name + raw SELECT body in a monospace editor + materialized flag (Postgres).
    - **Databases / folders** — create, rename, delete from the treeview.
- **Schema warnings panel** under the treeview flags: tables without PK, AI without PK, multiple AI columns, dangling FK / index references, empty tables. Click a warning to jump to the relevant database.
- **Treeview filter** — case-insensitive substring match, keeps ancestors of matches visible.
- **FK-aware arrange** — `Arrange` lays tables out by FK dependency level (parents left, children right).
- **Live SSE sync** — multiple browser tabs stay consistent.
- **Output modes:**
    - `ddl-files`: one `<table>.sql` per table, plus `<view>.view.sql`, plus `_enums.sql` (Postgres) and `_foreign_keys.sql` written last so loading in alphabetical order doesn't fail.
    - `migrations`: one timestamped `*.up.sql` / `*.down.sql` pair (currently always re-emits an `init` pair — diff-based migrations are a later iteration).

Not yet:

- Reverse-engineering (read from existing DB)
- Connection / SQL editor / data browser
- Diff-based incremental migrations
- Stored procedures / triggers
- Mid-drag live anchor flip on FK lines (anchors snap on mouseup, not during the drag)
- Undo / redo
- Canvas zoom / pan / multi-select

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

The treeview's `⋯`-menu is the central place for everything that's not on the canvas: creating databases / folders / enums / views, renaming, deleting, opening the enum or view editor.

## Configuration

| Field                                  | Type                                              | Notes                                              |
| -------------------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| `projects[].dialect`                   | `mysql` / `mariadb` / `postgres` / `sqlite`       | Picks the DDL renderer.                            |
| `projects[].output.mode`               | `ddl-files` / `migrations`                        | One file per table, or up/down migration pairs.    |
| `projects[].output.destinationPath`    | path                                              | Where SQL is written.                              |
| `projects[].output.destinationClear`   | bool                                              | Wipe the destination on every generate.            |
| `projects[].output.migrationFilenamePattern` | string                                      | Migrations only. Default `{timestamp}__{name}`.    |
| `projects[].scripts.before_generate`   | array of `{script, path}`                         | Hooks run before / after each generate.            |
| `projects[].scripts.after_generate`    | array of `{script, path}`                         |                                                    |
| `projects[].autoGenerate`              | bool                                              | Regenerate after every saved mutation.             |
| `server.port`                          | number                                            | HTTP port (default `5174`).                        |
| `server.limit`                         | string                                            | Body parser limit (default `100kb`).               |
| `browser.open`                         | bool                                              | Auto-open the browser when the dev server starts.  |

## Development

```bash
npm install
npm run dev          # vite dev server with the editor at localhost:5174
npm run lint         # ESLint over all .ts (eslint:all + @typescript-eslint + @stylistic)
npm run lint:fix     # auto-fix what ESLint can
```

`tsconfig.json` is for IDE type-checking only; `npm run dev` runs Vite directly without a compile step.

See `CLAUDE.md` for architecture notes.