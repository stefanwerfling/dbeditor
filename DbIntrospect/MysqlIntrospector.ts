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
    JsonTableOptions,
    JsonView
} from '../DbEditor/JsonData.js';
import {DbIntrospector} from './DbIntrospector.js';

/*
 * ---------------------------------------------------------------------------
 * Unid synthesis — stable across re-introspection of the same database.
 * The diff engine matches model↔live by NAME; unids are only used to track
 * an object within one tree.
 * ---------------------------------------------------------------------------
 */
const uTable = (db: string, t: string): string => `live:t:${db}:${t}`;
const uColumn = (db: string, t: string, c: string): string => `live:c:${db}:${t}:${c}`;
const uIndex = (db: string, t: string, i: string): string => `live:i:${db}:${t}:${i}`;
const uFk = (db: string, t: string, n: string): string => `live:fk:${db}:${t}:${n}`;
const uView = (db: string, v: string): string => `live:v:${db}:${v}`;
const uDb = (db: string): string => `live:db:${db}`;

/*
 * ---------------------------------------------------------------------------
 * Column-type parser
 *
 * MySQL exposes the fully formatted type string via information_schema as
 * `COLUMN_TYPE` (e.g. `int(11) unsigned`, `varchar(255)`, `decimal(10,2)`,
 * `enum('a','b')`, `tinyint(1)`). We need to split that into the editor's
 * separate `type` + `length` + `unsigned` fields.
 * ---------------------------------------------------------------------------
 */
type ParsedColumnType = {
    type: string;
    length?: string;
    unsigned?: boolean;
    enumValues?: string[];
};

const parseEnumValues = (inside: string): string[] => {
    /*
     * `enum('foo','bar','it''s ok')` — values are SQL-quoted with doubled
     * single quotes as escape. Walk byte-by-byte, no regex shenanigans.
     */
    const out: string[] = [];
    let i = 0;
    while (i < inside.length) {
        while (i < inside.length && inside[i] !== '\'') {i++;}
        if (i >= inside.length) {break;}
        i++;
        let v = '';
        while (i < inside.length) {
            if (inside[i] === '\'' && inside[i + 1] === '\'') { v += '\''; i += 2; continue; }
            if (inside[i] === '\'') { i++; break; }
            v += inside[i];
            i++;
        }
        out.push(v);
    }
    return out;
};

const parseColumnType = (raw: string): ParsedColumnType => {
    const s = raw.trim();
    const unsigned = /\bunsigned\b/iu.test(s);
    const base = s.replace(/\bunsigned\b/iu, '').replace(/\bzerofill\b/iu, '').trim();

    const enumMatch = base.match(/^enum\s*\((.+)\)\s*$/iu);
    if (enumMatch) {
        return {type: 'enum', enumValues: parseEnumValues(enumMatch[1])};
    }

    const m = base.match(/^([a-z_]+)\s*(?:\(([^)]+)\))?\s*$/iu);
    if (!m) {return {type: base.toLowerCase(), unsigned: unsigned};}
    const t = m[1].toLowerCase();
    let len = m[2] ? m[2].trim() : undefined;
    /*
     * Display width on INT-family types (e.g. `int(11)`, `bigint(20)`)
     * is purely cosmetic and deprecated in MySQL 8.0.17+. Strip it so
     * the diff doesn't false-positive against a model that doesn't
     * carry it — the .mwb importer drops it too. EXCEPTION: keep
     * `tinyint(1)` literally because models commonly declare boolean
     * columns that way and dropping the length would surface as a
     * needless MODIFY COLUMN on every sync.
     */
    const isIntFamily = t === 'int' || t === 'integer' || t === 'tinyint'
        || t === 'smallint' || t === 'mediumint' || t === 'bigint';
    if (isIntFamily && len !== undefined) {
        /*
         * Strip display width unconditionally — including `tinyint(1)`.
         * Models imported from `.mwb` carry bare `tinyint` because the
         * Workbench reader drops cosmetic length for all integer
         * variants. Keeping `tinyint(1)` here would surface a false-
         * positive MODIFY on every boolean-style column.
         */
        len = undefined;
    }
    return {
        type: t,
        length: len,
        unsigned: unsigned || undefined
    };
};

/*
 * ---------------------------------------------------------------------------
 * Foreign-key action mapping
 * ---------------------------------------------------------------------------
 */
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

const mapIndexType = (raw: string | null | undefined, nonUnique: number): string => {
    const t = String(raw || '').toUpperCase();
    if (t === 'FULLTEXT') {return JsonIndexType.fulltext;}
    if (t === 'SPATIAL') {return JsonIndexType.spatial;}
    if (nonUnique === 0) {return JsonIndexType.unique;}
    return JsonIndexType.index;
};

export class MysqlIntrospector implements DbIntrospector {

    public async introspect(conn: DbConnection, db: string): Promise<JsonDataDB> {
        /*
         * The database-level default collation is what every table
         * inherits when no explicit `COLLATE` clause was used on
         * CREATE TABLE. Surfacing it on every table's `options` would
         * trigger a false-positive `ALTER TABLE x COLLATE=...` diff
         * for the common case where the model just inherits silently.
         * Pre-load the default once so `_loadTables` can filter
         * inherited values out.
         */
        const schemaRows = await conn.query(
            `SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation
               FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
            [db]
        );
        const dbDefaults = {
            charset: schemaRows[0]?.charset ? String(schemaRows[0].charset) : '',
            collation: schemaRows[0]?.collation ? String(schemaRows[0].collation) : ''
        };
        const tables = await this._loadTables(conn, db, dbDefaults);
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

    /*
     * -----------------------------------------------------------------------
     * Tables: columns + indexes + foreign keys + table options
     * -----------------------------------------------------------------------
     */
    private async _loadTables(conn: DbConnection, db: string, _dbDefaults: {charset: string; collation: string;}): Promise<JsonTable[]> {
        const tableRows = await conn.query(
            `SELECT TABLE_NAME, ENGINE, TABLE_COLLATION, TABLE_COMMENT
               FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
              ORDER BY TABLE_NAME`,
            [db]
        );

        const columnRows = await conn.query(
            `SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_DEFAULT,
                    IS_NULLABLE, COLUMN_TYPE, COLUMN_KEY, EXTRA, COLUMN_COMMENT,
                    CHARACTER_SET_NAME, COLLATION_NAME, GENERATION_EXPRESSION
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ?
              ORDER BY TABLE_NAME, ORDINAL_POSITION`,
            [db]
        );

        const indexRows = await conn.query(
            `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
                    SUB_PART, INDEX_TYPE, COLLATION, INDEX_COMMENT
               FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = ?
              ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
            [db]
        );

        const fkRows = await conn.query(
            `SELECT kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME,
                    kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
                    kcu.ORDINAL_POSITION, rc.UPDATE_RULE, rc.DELETE_RULE
               FROM information_schema.KEY_COLUMN_USAGE kcu
               JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                 ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
                AND rc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
              WHERE kcu.TABLE_SCHEMA = ?
                AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
              ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
            [db]
        );

        const tables: JsonTable[] = [];
        for (const tr of tableRows) {
            const tableName = String(tr.TABLE_NAME);
            const tableCollation = tr.TABLE_COLLATION ? String(tr.TABLE_COLLATION) : '';
            const columns = this._buildColumns(db, tableName, columnRows, tableCollation);
            const indexes = this._buildIndexes(db, tableName, columns, indexRows);
            const foreignKeys = this._buildForeignKeys(db, tableName, columns, fkRows, tableRows);

            const options: JsonTableOptions = {};
            if (tr.ENGINE) {options.engine = String(tr.ENGINE);}
            if (tr.TABLE_COLLATION) {
                /*
                 * Always surface the table's actual collation (and
                 * derive its charset — MariaDB doesn't expose
                 * TABLE_CHARACTER_SET separately). The diff handles
                 * inheritance via the model's database-level
                 * defaults; filtering here would mask the cases
                 * where the model intends a different default than
                 * the SQL server's database default.
                 */
                const v = String(tr.TABLE_COLLATION);
                options.collation = v;
                const cs = v.split('_')[0];
                if (cs) {options.charset = cs;}
            }
            if (tr.TABLE_COMMENT) {options.comment = String(tr.TABLE_COMMENT);}

            tables.push({
                unid: uTable(db, tableName),
                name: tableName,
                pos: {x: 0, y: 0},
                columns: columns,
                indexes: indexes,
                foreignKeys: foreignKeys,
                options: options
            });
        }
        return tables;
    }

    private _buildColumns(db: string, tableName: string, rows: DbRow[], tableCollation: string): JsonColumn[] {
        /*
         * Charset/collation noise filter. Every text-typed column in
         * MySQL/MariaDB has a per-column COLLATION_NAME — but most are
         * inherited verbatim from the table default (TABLE_COLLATION),
         * not explicitly set by the user. The .mwb importer doesn't
         * carry this inherited value into the model, so leaving it on
         * the live side produces a false-positive MODIFY on every text
         * column. We zero out per-column charset/collation when they
         * MATCH the table default, keeping them only when the user has
         * actually overridden them.
         *
         * Charset is derived from the collation prefix (e.g.
         * `utf8mb4_general_ci` → `utf8mb4`).
         */
        const tableCharset = tableCollation.split('_')[0] ?? '';
        const out: JsonColumn[] = [];
        for (const r of rows) {
            if (String(r.TABLE_NAME) !== tableName) {continue;}
            const colName = String(r.COLUMN_NAME);
            const parsed = parseColumnType(String(r.COLUMN_TYPE));
            const isNullable = String(r.IS_NULLABLE).toUpperCase() === 'YES';
            const extra = String(r.EXTRA || '').toLowerCase();
            const key = String(r.COLUMN_KEY || '').toUpperCase();
            const col: JsonColumn = {
                unid: uColumn(db, tableName, colName),
                name: colName,
                type: parsed.type
            };
            if (parsed.length) {col.length = parsed.length;}
            if (parsed.unsigned) {col.unsigned = true;}
            if (!isNullable) {col.notNull = true;}
            if (key === 'PRI') {col.primaryKey = true;}
            if (extra.includes('auto_increment')) {col.autoIncrement = true;}
            /*
             * UNI in COLUMN_KEY means there is a unique index on JUST this
             * column. We surface the flag on the column to match the editor's
             * column-level UI; the same uniqueness will also show up as a
             * UNIQUE index below — that's intentional duplication, the diff
             * engine normalises it.
             */
            if (key === 'UNI') {col.unique = true;}
            if (r.COLUMN_DEFAULT !== null && r.COLUMN_DEFAULT !== undefined) {
                const dv = String(r.COLUMN_DEFAULT);
                /*
                 * MariaDB returns the literal string `"NULL"` (not SQL
                 * NULL) for nullable columns without an explicit
                 * DEFAULT clause. MySQL 8 returns SQL NULL → already
                 * filtered above. Treat both representations the same
                 * to keep the diff stable: `defaultValue: undefined`
                 * means "no DEFAULT clause" on the live side too.
                 */
                if (dv !== 'NULL') {
                    col.defaultValue = dv;
                }
            }
            /*
             * Workbench `.mwb` collapses `DEFAULT <expr> ON UPDATE
             * <expr>` into a single `defaultValue` string (most
             * commonly for `DATETIME` audit columns). MariaDB / MySQL
             * split that into `COLUMN_DEFAULT` + `EXTRA` separately.
             * Append the `ON UPDATE` clause from EXTRA back onto the
             * model-shaped `defaultValue` so the diff sees one
             * canonical form on both sides.
             */
            const onUpdateMatch = extra.match(/on update\s+(.+)$/u);
            if (onUpdateMatch) {
                const onUpdateExpr = onUpdateMatch[1].trim();
                col.defaultValue = col.defaultValue
                    ? `${col.defaultValue} ON UPDATE ${onUpdateExpr}`
                    : `ON UPDATE ${onUpdateExpr}`;
            }
            if (r.COLUMN_COMMENT) {col.comment = String(r.COLUMN_COMMENT);}
            if (r.COLLATION_NAME) {
                const v = String(r.COLLATION_NAME);
                if (v !== tableCollation) {col.collation = v;}
            }
            if (r.CHARACTER_SET_NAME) {
                const v = String(r.CHARACTER_SET_NAME);
                if (v !== tableCharset) {col.charset = v;}
            }
            if (r.GENERATION_EXPRESSION) {
                col.generatedExpression = String(r.GENERATION_EXPRESSION);
                col.generatedStored = extra.includes('stored');
            }
            out.push(col);
        }
        return out;
    }

    private _buildIndexes(db: string, tableName: string, columns: JsonColumn[], rows: DbRow[]): JsonIndex[] {
        const byName = new Map<string, JsonIndex>();
        const colsByName = new Map<string, JsonColumn>();
        for (const c of columns) {colsByName.set(c.name, c);}

        for (const r of rows) {
            if (String(r.TABLE_NAME) !== tableName) {continue;}
            const ixName = String(r.INDEX_NAME);
            /*
             * PRIMARY is modelled via per-column `primaryKey` flags on the
             * editor side, not as a separate index entity — skip it.
             */
            if (ixName.toUpperCase() === 'PRIMARY') {continue;}
            let ix = byName.get(ixName);
            if (!ix) {
                ix = {
                    unid: uIndex(db, tableName, ixName),
                    name: ixName,
                    type: mapIndexType(r.INDEX_TYPE as string | null, Number(r.NON_UNIQUE)),
                    columns: []
                };
                if (r.INDEX_COMMENT) {ix.comment = String(r.INDEX_COMMENT);}
                byName.set(ixName, ix);
            }
            const refCol = colsByName.get(String(r.COLUMN_NAME));
            if (!refCol) {continue;}
            const ic: JsonIndexColumn = {columnUnid: refCol.unid};
            const collation = String(r.COLLATION || '').toUpperCase();
            if (collation === 'D') {ic.order = 'DESC';}
            if (r.SUB_PART !== null && r.SUB_PART !== undefined) {
                ic.length = Number(r.SUB_PART);
            }
            ix.columns.push(ic);
        }
        return Array.from(byName.values());
    }

    private _buildForeignKeys(
        db: string,
        tableName: string,
        columns: JsonColumn[],
        fkRows: DbRow[],
        _tableRows: DbRow[]
    ): JsonForeignKey[] {
        const colsByName = new Map<string, JsonColumn>();
        for (const c of columns) {colsByName.set(c.name, c);}

        const byName = new Map<string, JsonForeignKey>();
        for (const r of fkRows) {
            if (String(r.TABLE_NAME) !== tableName) {continue;}
            const fkName = String(r.CONSTRAINT_NAME);
            let fk = byName.get(fkName);
            if (!fk) {
                const refTable = String(r.REFERENCED_TABLE_NAME);
                fk = {
                    unid: uFk(db, tableName, fkName),
                    name: fkName,
                    refTableUnid: uTable(db, refTable),
                    columns: []
                };
                const onDelete = mapAction(r.DELETE_RULE as string);
                const onUpdate = mapAction(r.UPDATE_RULE as string);
                if (onDelete) {fk.onDelete = onDelete;}
                if (onUpdate) {fk.onUpdate = onUpdate;}
                byName.set(fkName, fk);
            }
            const local = colsByName.get(String(r.COLUMN_NAME));
            if (!local) {continue;}
            const refColName = String(r.REFERENCED_COLUMN_NAME);
            const refTableName = String(r.REFERENCED_TABLE_NAME);
            const fkc: JsonForeignKeyColumn = {
                columnUnid: local.unid,
                refColumnUnid: uColumn(db, refTableName, refColName)
            };
            fk.columns.push(fkc);
        }
        return Array.from(byName.values());
    }

    /*
     * -----------------------------------------------------------------------
     * Views
     * -----------------------------------------------------------------------
     */
    private async _loadViews(conn: DbConnection, db: string): Promise<JsonView[]> {
        const rows = await conn.query(
            `SELECT TABLE_NAME, VIEW_DEFINITION
               FROM information_schema.VIEWS
              WHERE TABLE_SCHEMA = ?
              ORDER BY TABLE_NAME`,
            [db]
        );
        const out: JsonView[] = [];
        for (const r of rows) {
            const name = String(r.TABLE_NAME);
            out.push({
                unid: uView(db, name),
                name: name,
                pos: {x: 0, y: 0},
                select: String(r.VIEW_DEFINITION || '')
            });
        }
        return out;
    }

}