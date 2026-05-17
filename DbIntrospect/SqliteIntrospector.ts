import {DbConnection, DbRow} from '../DbConnection/DbConnection.js';
import {
    JsonColumn,
    JsonDataDB,
    JsonDataDBType,
    JsonForeignKey,
    JsonForeignKeyAction,
    JsonForeignKeyColumn,
    JsonIndex,
    JsonIndexColumn,
    JsonIndexType,
    JsonTable,
    JsonView
} from '../DbEditor/JsonData.js';
import {DbIntrospector} from './DbIntrospector.js';

const uTable = (db: string, t: string): string => `live:t:${db}:${t}`;
const uColumn = (db: string, t: string, c: string): string => `live:c:${db}:${t}:${c}`;
const uIndex = (db: string, t: string, i: string): string => `live:i:${db}:${t}:${i}`;
const uFk = (db: string, t: string, n: string): string => `live:fk:${db}:${t}:${n}`;
const uView = (db: string, v: string): string => `live:v:${db}:${v}`;
const uDb = (db: string): string => `live:db:${db}`;

/*
 * ---------------------------------------------------------------------------
 * SQLite stores the "declared type" verbatim — `INTEGER`, `VARCHAR(255)`,
 * `BOOLEAN`, etc. We map declared types back to the editor's logical names
 * the same way the MySQL parser does. SQLite's type affinity rules apply
 * at the storage diagram, but the diff is over the *declared* type.
 * ---------------------------------------------------------------------------
 */
const mapDeclaredType = (declared: string): { type: string; length?: string; } => {
    const trimmed = (declared || '').trim();
    if (!trimmed) {return {type: 'text'};}

    const m = trimmed.match(/^([A-Za-z_][A-Za-z_0-9]*)\s*(?:\(([^)]+)\))?\s*$/u);
    if (!m) {return {type: trimmed.toLowerCase()};}
    const raw = m[1].toLowerCase();
    const len = m[2] ? m[2].trim() : undefined;
    switch (raw) {
        case 'integer':
        case 'int':
        case 'tinyint':
        case 'smallint':
        case 'mediumint':
        case 'bigint':
            return {type: 'int', length: len};
        case 'bool':
        case 'boolean':
            return {type: 'boolean'};
        case 'real':
        case 'double':
        case 'float':
            return {type: 'double'};
        case 'numeric':
        case 'decimal':
            return {type: 'decimal', length: len};
        case 'varchar':
            return {type: 'varchar', length: len};
        case 'char':
        case 'character':
            return {type: 'char', length: len};
        case 'text':
        case 'clob':
            return {type: 'text', length: len};
        case 'blob':
            return {type: 'blob'};
        case 'date':
        case 'time':
        case 'datetime':
        case 'timestamp':
        case 'uuid':
        case 'json':
            return {type: raw};
        default:
            return {type: raw, length: len};
    }
};

const mapAction = (raw: string | null | undefined): string | undefined => {
    if (!raw) {return undefined;}
    const v = String(raw).toUpperCase();
    switch (v) {
        case 'NO ACTION':   return JsonForeignKeyAction.no_action;
        case 'RESTRICT':    return JsonForeignKeyAction.restrict;
        case 'CASCADE':     return JsonForeignKeyAction.cascade;
        case 'SET NULL':    return JsonForeignKeyAction.set_null;
        case 'SET DEFAULT': return JsonForeignKeyAction.set_default;
        default:            return v;
    }
};

export class SqliteIntrospector implements DbIntrospector {

    public async introspect(conn: DbConnection, db: string): Promise<JsonDataDB> {
        const tableNames = await this._loadObjectNames(conn, 'table');
        const tables = await this._loadTables(conn, db, tableNames);
        const views = await this._loadViews(conn, db);
        return {
            unid: uDb(db),
            name: db,
            type: JsonDataDBType.database,
            istoggle: true,
            entrys: [],
            tables: tables,
            views: views,
            enums: []
        };
    }

    private async _loadObjectNames(conn: DbConnection, kind: 'table' | 'view'): Promise<string[]> {
        /*
         * Skip the internal `sqlite_*` bookkeeping tables (sqlite_sequence,
         * sqlite_stat1, …) so they don't show up as user tables.
         */
        const rows = await conn.query(
            `SELECT name FROM sqlite_master
              WHERE type = ? AND name NOT LIKE 'sqlite_%'
              ORDER BY name`,
            [kind]
        );
        return rows.map(r => String(r.name));
    }

    private async _loadTables(conn: DbConnection, db: string, tableNames: string[]): Promise<JsonTable[]> {
        const tables: JsonTable[] = [];
        for (const name of tableNames) {
            /*
             * Sequential lookups against per-table PRAGMAs are required —
             * `PRAGMA` doesn't take a generic schema filter. Each call is
             * cheap (SQLite is local + in-process via better-sqlite3).
             */
            // eslint-disable-next-line no-await-in-loop
            const columns = await this._loadColumns(conn, db, name);
            // eslint-disable-next-line no-await-in-loop
            const indexes = await this._loadIndexes(conn, db, name, columns);
            // eslint-disable-next-line no-await-in-loop
            const foreignKeys = await this._loadForeignKeys(conn, db, name, columns);
            tables.push({
                unid: uTable(db, name),
                name: name,
                pos: {x: 0, y: 0},
                columns: columns,
                indexes: indexes,
                foreignKeys: foreignKeys
            });
        }
        return tables;
    }

    private async _loadColumns(conn: DbConnection, db: string, tableName: string): Promise<JsonColumn[]> {
        /*
         * `PRAGMA table_xinfo` includes generated/hidden columns; we stick to
         * `table_info` because the editor doesn't model SQLite hidden columns.
         */
        const rows = await conn.query(`PRAGMA table_info(${SqliteIntrospector._q(tableName)})`);
        const out: JsonColumn[] = [];
        for (const r of rows) {
            const colName = String(r.name);
            const declared = String(r.type || '');
            const parsed = mapDeclaredType(declared);
            const col: JsonColumn = {
                unid: uColumn(db, tableName, colName),
                name: colName,
                type: parsed.type
            };
            if (parsed.length) {col.length = parsed.length;}
            if (Number(r.notnull) === 1) {col.notNull = true;}
            if (Number(r.pk) > 0) {col.primaryKey = true;}
            if (r.dflt_value !== null && r.dflt_value !== undefined) {
                col.defaultValue = String(r.dflt_value);
            }
            out.push(col);
        }
        /*
         * AUTOINCREMENT detection: SQLite marks the integer PK with
         * AUTOINCREMENT semantics by inserting a row into `sqlite_sequence`.
         * We approximate by checking whether `sqlite_sequence` has an entry
         * for this table — if yes, the (single-column INTEGER PRIMARY KEY)
         * is the autoincrement column.
         */
        const seqRows = await conn.query(
            'SELECT name FROM sqlite_sequence WHERE name = ?',
            [tableName]
        ).catch(() => [] as DbRow[]);
        if (seqRows.length) {
            const pkCol = out.find(c => c.primaryKey === true);
            if (pkCol) {pkCol.autoIncrement = true;}
        }
        return out;
    }

    private async _loadIndexes(conn: DbConnection, db: string, tableName: string, columns: JsonColumn[]): Promise<JsonIndex[]> {
        const colsByName = new Map<string, JsonColumn>();
        for (const c of columns) {colsByName.set(c.name, c);}

        const rows = await conn.query(`PRAGMA index_list(${SqliteIntrospector._q(tableName)})`);
        const out: JsonIndex[] = [];
        for (const r of rows) {
            const indexName = String(r.name);
            /* origin: 'c' = CREATE INDEX, 'u' = UNIQUE constraint, 'pk' = PRIMARY KEY */
            const origin = String(r.origin || '');
            /*
             * Skip the auto-generated PK index — primary keys are surfaced
             * via per-column `primaryKey` flags. Skip the implicit indexes
             * created for inline UNIQUE/PRIMARY KEY column declarations
             * (origin 'u' with autoindex name) to match the editor's model.
             */
            if (origin === 'pk') {continue;}
            if (indexName.startsWith('sqlite_autoindex_')) {continue;}

            // eslint-disable-next-line no-await-in-loop
            const cols = await conn.query(`PRAGMA index_info(${SqliteIntrospector._q(indexName)})`);
            const indexColumns: JsonIndexColumn[] = [];
            for (const ic of cols) {
                const refCol = colsByName.get(String(ic.name));
                if (!refCol) {continue;}
                indexColumns.push({columnUnid: refCol.unid});
            }
            out.push({
                unid: uIndex(db, tableName, indexName),
                name: indexName,
                type: Number(r.unique) === 1 ? JsonIndexType.unique : JsonIndexType.index,
                columns: indexColumns
            });
        }
        return out;
    }

    private async _loadForeignKeys(conn: DbConnection, db: string, tableName: string, columns: JsonColumn[]): Promise<JsonForeignKey[]> {
        const colsByName = new Map<string, JsonColumn>();
        for (const c of columns) {colsByName.set(c.name, c);}

        const rows = await conn.query(`PRAGMA foreign_key_list(${SqliteIntrospector._q(tableName)})`);
        /*
         * `foreign_key_list` reports one row per (FK-id, seq) pair. FKs in
         * SQLite have no user-given name in the catalogue — we synthesise
         * `fk_<table>_<fkid>` so the editor can refer to them.
         */
        const byId = new Map<number, JsonForeignKey>();
        for (const r of rows) {
            const fkId = Number(r.id);
            const refTable = String(r.table);
            const fkName = `fk_${tableName}_${fkId}`;
            let fk = byId.get(fkId);
            if (!fk) {
                fk = {
                    unid: uFk(db, tableName, fkName),
                    name: fkName,
                    refTableUnid: uTable(db, refTable),
                    columns: []
                };
                const onDelete = mapAction(r.on_delete as string);
                const onUpdate = mapAction(r.on_update as string);
                if (onDelete) {fk.onDelete = onDelete;}
                if (onUpdate) {fk.onUpdate = onUpdate;}
                byId.set(fkId, fk);
            }
            const local = colsByName.get(String(r.from));
            if (!local) {continue;}
            const fkc: JsonForeignKeyColumn = {
                columnUnid: local.unid,
                refColumnUnid: uColumn(db, refTable, String(r.to))
            };
            fk.columns.push(fkc);
        }
        return Array.from(byId.values());
    }

    private async _loadViews(conn: DbConnection, db: string): Promise<JsonView[]> {
        const rows = await conn.query(
            `SELECT name, sql FROM sqlite_master
              WHERE type = 'view' AND name NOT LIKE 'sqlite_%'
              ORDER BY name`
        );
        const out: JsonView[] = [];
        for (const r of rows) {
            const name = String(r.name);
            /*
             * sqlite_master stores the *full* `CREATE VIEW … AS <select>`.
             * Strip the prefix so the editor sees just the SELECT body.
             */
            const fullSql = String(r.sql || '');
            const asMatch = fullSql.match(/\bAS\s+(.+)$/isu);
            out.push({
                unid: uView(db, name),
                name: name,
                pos: {x: 0, y: 0},
                select: asMatch ? asMatch[1].trim() : fullSql.trim()
            });
        }
        return out;
    }

    /** Quote an SQLite identifier for use inside a PRAGMA call. */
    private static _q(name: string): string {
        return `"${name.replace(/"/gu, '""')}"`;
    }

}