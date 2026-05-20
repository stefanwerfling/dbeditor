import {JsonColumn, JsonEnum, JsonForeignKey, JsonIndex, JsonRoutine, JsonTable, JsonView} from '../../editor_frontend/DbEditor/JsonData.js';

/**
 * Context shared between the dispatcher and the dialect. The dialect uses
 * `findTable` / `findEnum` to resolve cross-table references (FK targets,
 * enum types referenced by columns) by unid.
 */
export type DialectContext = {
    indent: string;
    terminator: string;
    comments: boolean;
    findTable: (unid: string) => JsonTable | undefined;
    findEnum: (unid: string) => JsonEnum | undefined;
    findColumn: (tableUnid: string, columnUnid: string) => JsonColumn | undefined;
};

/**
 * Each dialect knows how to render the same logical concepts as its native
 * DDL. The output is a list of statements; each statement is one DDL command
 * without trailing terminator (the dispatcher joins them with `terminator`).
 *
 * Implementations should:
 *   - quote identifiers with the dialect's native quote (`backtick` for
 *     MySQL/MariaDB, `"` for Postgres/SQLite)
 *   - translate logical column types via `mapColumnType` (`int` → `INTEGER`
 *     on Postgres, `INT` on MySQL, etc.)
 *   - emit ENUM types where supported (Postgres CREATE TYPE; MySQL inlines)
 *   - return CREATE INDEX statements separately from CREATE TABLE
 *   - produce ALTER TABLE ... ADD CONSTRAINT for foreign keys (so we can
 *     emit them after every CREATE TABLE in the file, avoiding circular
 *     forward-reference issues)
 */
export interface DbDialect {

    /** Identifier quote(s). e.g. "`" for mysql, '"' for postgres. */
    quote(name: string): string;

    /** Map a logical type ('int', 'varchar', etc.) to dialect SQL. */
    mapColumnType(col: JsonColumn, ctx: DialectContext): string;

    /**
     * Render one CREATE TABLE block as one statement string (no trailing
     * terminator). Includes columns, inline PK, and any inline UNIQUEs.
     */
    renderCreateTable(table: JsonTable, ctx: DialectContext): string;

    /** Render one CREATE INDEX statement. Returns null if not applicable. */
    renderCreateIndex(table: JsonTable, ix: JsonIndex, ctx: DialectContext): string | null;

    /** Render one ALTER TABLE ADD FOREIGN KEY constraint. */
    renderAddForeignKey(table: JsonTable, fk: JsonForeignKey, ctx: DialectContext): string | null;

    /** Render CREATE TYPE for ENUMs (postgres). Returns null for dialects without CREATE TYPE. */
    renderCreateEnum(e: JsonEnum, ctx: DialectContext): string | null;

    /** Render DROP TABLE for migrations down-files. */
    renderDropTable(table: JsonTable, ctx: DialectContext): string;

    /** Render DROP INDEX for migrations down-files. */
    renderDropIndex(table: JsonTable, ix: JsonIndex, ctx: DialectContext): string | null;

    /** Render DROP TYPE for migrations down-files (postgres). */
    renderDropEnum(e: JsonEnum, ctx: DialectContext): string | null;

    /**
     * Render CREATE VIEW (or CREATE MATERIALIZED VIEW where supported).
     * Returns null if the view body is empty or otherwise unrenderable.
     */
    renderCreateView(view: JsonView, ctx: DialectContext): string | null;

    /** Render DROP VIEW for migrations down-files. */
    renderDropView(view: JsonView, ctx: DialectContext): string | null;

    /*
     * -----------------------------------------------------------------------
     * Sync-with-DB renderers — produce ALTER statements for individual
     * diff changes. Used by the SyncGenerator, not by the file/migration
     * codegen path.
     * -----------------------------------------------------------------------
     */

    /** `ALTER TABLE x ADD COLUMN ...`. The column is appended at the end. */
    renderAlterTableAddColumn(table: JsonTable, col: JsonColumn, ctx: DialectContext): string;

    /** `ALTER TABLE x DROP COLUMN y`. */
    renderAlterTableDropColumn(table: JsonTable, col: JsonColumn, ctx: DialectContext): string;

    /**
     * `ALTER TABLE x MODIFY/CHANGE COLUMN ...`. `oldCol` carries the live
     * column for column rename support (which we intentionally don't do in
     * iter 1 — same name on both sides), and as a reference for dialects
     * that need it.
     */
    renderAlterTableChangeColumn(table: JsonTable, oldCol: JsonColumn, newCol: JsonColumn, ctx: DialectContext): string;

    /** `ALTER TABLE x DROP FOREIGN KEY/CONSTRAINT y`. */
    renderDropForeignKey(table: JsonTable, fkName: string, ctx: DialectContext): string;

    /**
     * `RENAME TABLE oldName TO newName` (or dialect equivalent).
     * `table` carries the new table state — caller passes the model
     * side so the rename inherits any options it sets.
     * Returns null for dialects without a native rename.
     */
    renderRenameTable(oldName: string, newName: string, ctx: DialectContext): string | null;

    /**
     * `ALTER TABLE x RENAME COLUMN old TO new`. The new-column shape
     * carries the model-side state so the dialect can re-emit type
     * info if it requires the column shape in the rename statement
     * (MySQL <8.0 needs `CHANGE COLUMN old new <type>` for that —
     * we target MySQL 8+ which supports bare `RENAME COLUMN`).
     */
    renderRenameColumn(table: JsonTable, oldName: string, newCol: JsonColumn, ctx: DialectContext): string | null;

    /**
     * `ALTER TABLE x ENGINE=..., CHARSET=..., ...`. Empty diff returns null —
     * caller should skip emitting the statement entirely.
     */
    renderAlterTableOptions(table: JsonTable, ctx: DialectContext): string | null;

    /**
     * Re-render a view, replacing the existing one. MySQL uses `CREATE OR
     * REPLACE VIEW`; postgres uses the same but with caveats around column
     * lists; sqlite drops and recreates.
     */
    renderReplaceView(view: JsonView, ctx: DialectContext): string;

    /**
     * Stored procedure / function / trigger emit. The body is opaque —
     * the user pastes the full `CREATE PROCEDURE name(...) BEGIN ... END`
     * SQL and the dialect wraps it with whatever framing the engine needs
     * (MySQL: DELIMITER //; Postgres: $$-quoting if absent; SQLite: null
     * — engine doesn't support stored routines).
     *
     * Returns null when the dialect doesn't support stored routines or
     * the body is empty.
     */
    renderCreateRoutine(routine: JsonRoutine, ctx: DialectContext): string | null;

    /** DROP PROCEDURE / FUNCTION / TRIGGER. Null when dialect doesn't support routines. */
    renderDropRoutine(routine: JsonRoutine, ctx: DialectContext): string | null;
}