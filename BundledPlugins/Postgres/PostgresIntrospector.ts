import {DbConnection, DbRow} from '../../editor_backend/DbConnection/DbConnection.js';
import {
    JsonColumn,
    JsonDataDB,
    JsonDataDBType,
    JsonEnum,
    JsonEnumValue,
    JsonForeignKey,
    JsonForeignKeyColumn,
    JsonIndex,
    JsonIndexColumn,
    JsonIndexType,
    JsonTable,
    JsonTableOptions,
    JsonView
} from '../../editor_frontend/DbEditor/JsonData.js';
import {DbIntrospector} from '../../editor_backend/DbIntrospect/DbIntrospector.js';
import {FkActionMapper} from '../../editor_backend/DbIntrospect/FkActionMapper.js';
import {LiveUridScheme} from '../../editor_backend/DbIntrospect/LiveUridScheme.js';

export class PostgresIntrospector implements DbIntrospector {

    /**
     * Type mapping back to editor's logical type names. Postgres
     * `data_type` is verbose ("character varying", "timestamp without
     * time zone", ...); the editor expects the shorter logical names.
     * `udt_name` carries the underlying type (e.g. `varchar`, `int4`,
     * `timestamptz`) which is closer to what we want; we still normalise
     * common aliases.
     */
    private static _mapType(dataType: string, udtName: string): string {
        const dt = (dataType || '').toLowerCase();
        const udt = (udtName || '').toLowerCase();
        switch (udt) {
            case 'int2': return 'smallint';
            case 'int4': return 'int';
            case 'int8': return 'bigint';
            case 'float4': return 'float';
            case 'float8': return 'double';
            case 'bool': return 'boolean';
            case 'varchar': return 'varchar';
            case 'bpchar': return 'char';
            case 'text': return 'text';
            case 'numeric': return 'decimal';
            case 'date': return 'date';
            case 'timestamp':
            case 'timestamptz': return 'timestamp';
            case 'time':
            case 'timetz': return 'time';
            case 'jsonb':
            case 'json': return 'json';
            case 'uuid': return 'uuid';
            case 'bytea': return 'blob';
            default:
                return udt || dt || 'text';
        }
    }

    /**
     * Whitelist Postgres identifier shape (letters / digits / underscores /
     * `$`, not starting with a digit). The introspector inlines the schema
     * name into SQL string literals, so a hostile value with embedded
     * quotes would otherwise be an SQL-injection vector. We can't use
     * positional parameters because `DbConnection.query` doesn't expose
     * them. Throw on shape mismatch — better fail-fast than silent breakage.
     */
    private static _assertSafeSchemaName(s: string): string {
        if (!/^[A-Za-z_][A-Za-z0-9_$]*$/u.test(s)) {
            throw new Error(`PostgresIntrospector: refusing unsafe schema name "${s}" — must match [A-Za-z_][A-Za-z0-9_$]*`);
        }
        return s;
    }

    public async introspect(conn: DbConnection, db: string, schemaName: string = 'public'): Promise<JsonDataDB> {
        /*
         * `db` is the connection's current Postgres database
         * (`current_database()`); `schemaName` is the schema INSIDE
         * that database to introspect (defaults to `'public'` —
         * back-compat with the pre-Iter-7 hardcoded behaviour). Every
         * query below filters on it. Validate the shape once here so
         * callers that supply an unsafe value get a clear error
         * instead of an SQL injection later.
         */
        const schema = PostgresIntrospector._assertSafeSchemaName(schemaName);
        const enums = await this._loadEnums(conn, db, schema);
        const tables = await this._loadTables(conn, db, schema);
        const views = await this._loadViews(conn, db, schema);

        return {
            unid: LiveUridScheme.db(db),
            name: db,
            type: JsonDataDBType.database,
            istoggle: true,
            entrys: [],
            tables: tables,
            views: views,
            enums: enums
        };
    }

    /*
     * -----------------------------------------------------------------------
     * Enums (CREATE TYPE ... AS ENUM)
     * -----------------------------------------------------------------------
     */
    private async _loadEnums(conn: DbConnection, db: string, schema: string): Promise<JsonEnum[]> {
        const rows = await conn.query(
            `SELECT t.typname AS name, e.enumlabel AS value, e.enumsortorder AS sort
               FROM pg_type t
               JOIN pg_enum e ON e.enumtypid = t.oid
               JOIN pg_namespace n ON n.oid = t.typnamespace
              WHERE n.nspname = '${schema}'
              ORDER BY t.typname, e.enumsortorder`
        );
        const byName = new Map<string, JsonEnum>();
        for (const r of rows) {
            const name = String(r.name);
            let e = byName.get(name);
            if (!e) {
                e = {
                    unid: LiveUridScheme.enumType(db, name),
                    name: name,
                    pos: {x: 0, y: 0},
                    values: []
                };
                byName.set(name, e);
            }
            const v: JsonEnumValue = {
                unid: `${e.unid}:${String(r.value)}`,
                value: String(r.value)
            };
            e.values.push(v);
        }
        return Array.from(byName.values());
    }

    /*
     * -----------------------------------------------------------------------
     * Tables: columns + indexes + foreign keys
     * -----------------------------------------------------------------------
     */
    private async _loadTables(conn: DbConnection, db: string, schema: string): Promise<JsonTable[]> {
        const tableRows = await conn.query(
            `SELECT c.relname AS table_name,
                    obj_description(c.oid, 'pg_class') AS table_comment,
                    c.relpersistence AS persistence,
                    ts.spcname AS tablespace
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace
              WHERE n.nspname = '${schema}' AND c.relkind = 'r'
              ORDER BY c.relname`
        );

        const columnRows = await conn.query(
            `SELECT c.table_name, c.column_name, c.ordinal_position, c.column_default,
                    c.is_nullable, c.data_type, c.udt_name, c.character_maximum_length,
                    c.numeric_precision, c.numeric_scale, c.is_identity, c.identity_generation,
                    col_description(pgc.oid, c.ordinal_position) AS column_comment,
                    c.collation_name
               FROM information_schema.columns c
          LEFT JOIN pg_class pgc ON pgc.relname = c.table_name
          LEFT JOIN pg_namespace pgn ON pgn.oid = pgc.relnamespace
              WHERE c.table_schema = '${schema}'
                AND (pgn.nspname = '${schema}' OR pgn.nspname IS NULL)
              ORDER BY c.table_name, c.ordinal_position`
        );

        const pkRows = await conn.query(
            `SELECT kcu.table_name, kcu.column_name
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON kcu.constraint_name = tc.constraint_name
                AND kcu.constraint_schema = tc.constraint_schema
              WHERE tc.constraint_schema = '${schema}'
                AND tc.constraint_type = 'PRIMARY KEY'`
        );
        const pkLookup = new Set<string>();
        for (const r of pkRows) {pkLookup.add(`${String(r.table_name)}:${String(r.column_name)}`);}

        const uniqueRows = await conn.query(
            `SELECT tc.table_name, kcu.column_name, tc.constraint_name
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON kcu.constraint_name = tc.constraint_name
                AND kcu.constraint_schema = tc.constraint_schema
              WHERE tc.constraint_schema = '${schema}'
                AND tc.constraint_type = 'UNIQUE'`
        );
        /*
         * Single-column UNIQUE constraints surface on the column as
         * `unique: true`. Multi-column UNIQUE shows up via the indexes
         * query below as a UNIQUE index, not on the column itself.
         */
        const uniqueByConstraint = new Map<string, string[]>();
        for (const r of uniqueRows) {
            const k = String(r.constraint_name);
            const cols = uniqueByConstraint.get(k) ?? [];
            cols.push(String(r.column_name));
            uniqueByConstraint.set(k, cols);
        }
        const singleColumnUnique = new Set<string>();
        for (const r of uniqueRows) {
            const cols = uniqueByConstraint.get(String(r.constraint_name)) ?? [];
            if (cols.length === 1) {
                singleColumnUnique.add(`${String(r.table_name)}:${String(r.column_name)}`);
            }
        }

        const indexRows = await conn.query(
            `SELECT t.relname AS table_name,
                    i.relname AS index_name,
                    ix.indisunique AS is_unique,
                    ix.indkey,
                    pg_get_indexdef(ix.indexrelid) AS index_def,
                    am.amname AS using_method
               FROM pg_class t
               JOIN pg_namespace n ON n.oid = t.relnamespace
               JOIN pg_index ix ON ix.indrelid = t.oid
               JOIN pg_class i ON i.oid = ix.indexrelid
               JOIN pg_am am ON am.oid = i.relam
              WHERE n.nspname = '${schema}' AND t.relkind = 'r'
                AND NOT ix.indisprimary
              ORDER BY t.relname, i.relname`
        );

        const fkRows = await conn.query(
            `SELECT kcu.table_name AS table_name,
                    tc.constraint_name AS constraint_name,
                    kcu.column_name AS column_name,
                    kcu.ordinal_position AS ordinal_position,
                    ccu.table_name AS ref_table,
                    ccu.column_name AS ref_column,
                    rc.update_rule, rc.delete_rule
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON kcu.constraint_name = tc.constraint_name
                AND kcu.constraint_schema = tc.constraint_schema
               JOIN information_schema.referential_constraints rc
                 ON rc.constraint_name = tc.constraint_name
                AND rc.constraint_schema = tc.constraint_schema
               JOIN information_schema.constraint_column_usage ccu
                 ON ccu.constraint_name = tc.constraint_name
                AND ccu.constraint_schema = tc.constraint_schema
              WHERE tc.constraint_schema = '${schema}'
                AND tc.constraint_type = 'FOREIGN KEY'
              ORDER BY kcu.table_name, tc.constraint_name, kcu.ordinal_position`
        );

        const tables: JsonTable[] = [];
        for (const tr of tableRows) {
            const tableName = String(tr.table_name);
            const columns = this._buildColumns(db, tableName, columnRows, pkLookup, singleColumnUnique);
            const indexes = this._buildIndexes(db, tableName, columns, indexRows);
            const foreignKeys = this._buildForeignKeys(db, tableName, columns, fkRows);

            const options: JsonTableOptions = {};
            if (tr.table_comment) {options.comment = String(tr.table_comment);}
            if (tr.tablespace) {options.tablespace = String(tr.tablespace);}
            const p = String(tr.persistence || '');
            if (p === 'u') {options.persistence = 'UNLOGGED';}
            if (p === 't') {options.persistence = 'TEMPORARY';}

            tables.push({
                unid: LiveUridScheme.table(db, tableName),
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

    private _buildColumns(
        db: string,
        tableName: string,
        rows: DbRow[],
        pkLookup: Set<string>,
        singleColumnUnique: Set<string>
    ): JsonColumn[] {
        const out: JsonColumn[] = [];
        for (const r of rows) {
            if (String(r.table_name) !== tableName) {continue;}
            const colName = String(r.column_name);
            const dt = String(r.data_type || '');
            const udt = String(r.udt_name || '');
            const length = PostgresIntrospector._lengthFor(r);
            const isIdentity = String(r.is_identity || '').toUpperCase() === 'YES';

            const col: JsonColumn = {
                unid: LiveUridScheme.column(db, tableName, colName),
                name: colName,
                type: udt === 'enum' || dt === 'USER-DEFINED' ? 'enum' : PostgresIntrospector._mapType(dt, udt)
            };
            if (length) {col.length = length;}
            if (String(r.is_nullable).toUpperCase() === 'NO') {col.notNull = true;}
            if (pkLookup.has(`${tableName}:${colName}`)) {col.primaryKey = true;}
            if (singleColumnUnique.has(`${tableName}:${colName}`)) {col.unique = true;}
            if (isIdentity) {col.autoIncrement = true;}
            if (r.column_default !== null && r.column_default !== undefined) {
                const def = String(r.column_default);
                /*
                 * `nextval('foo_id_seq'::regclass)` indicates a SERIAL — treat
                 * as autoIncrement and drop the default, since the editor's
                 * autoIncrement flag covers it.
                 */
                if (/nextval\(/iu.test(def)) {
                    col.autoIncrement = true;
                } else {
                    col.defaultValue = def;
                }
            }
            if (r.column_comment) {col.comment = String(r.column_comment);}
            if (r.collation_name) {col.collation = String(r.collation_name);}
            /*
             * USER-DEFINED is how information_schema labels enum columns.
             * udt_name then carries the enum type's name; we point enumRef
             * at the synthesised enum-unid so the diff can match by name.
             */
            if (dt === 'USER-DEFINED' && udt) {
                col.type = 'enum';
                col.enumRef = LiveUridScheme.enumType(db, udt);
            }
            out.push(col);
        }
        return out;
    }

    private static _lengthFor(r: DbRow): string | undefined {
        if (r.character_maximum_length !== null && r.character_maximum_length !== undefined) {
            return String(r.character_maximum_length);
        }
        if (r.numeric_precision !== null && r.numeric_precision !== undefined) {
            const scale = r.numeric_scale ?? 0;
            return `${String(r.numeric_precision)},${String(scale)}`;
        }
        return undefined;
    }

    private _buildIndexes(db: string, tableName: string, columns: JsonColumn[], rows: DbRow[]): JsonIndex[] {
        const colsByName = new Map<string, JsonColumn>();
        for (const c of columns) {colsByName.set(c.name, c);}
        const out: JsonIndex[] = [];
        for (const r of rows) {
            if (String(r.table_name) !== tableName) {continue;}
            const indexName = String(r.index_name);
            /*
             * pg_get_indexdef returns the full `CREATE [UNIQUE] INDEX … ON …
             * USING method (col1, col2 DESC)` text. We parse just the columns
             * out of the trailing `(...)`. The using-method is what classifies
             * the index type for the editor.
             */
            const def = String(r.index_def || '');
            const parenMatch = def.match(/\(([^)]*)\)\s*$/u);
            const innerCols = parenMatch ? parenMatch[1].split(',').map(s => s.trim()) : [];
            const indexColumns: JsonIndexColumn[] = [];
            for (const col of innerCols) {
                /*
                 * Each spec is `<col> [opclass] [ASC|DESC] [NULLS …]`. Strip
                 * surrounding quotes from the column identifier.
                 */
                const parts = col.split(/\s+/u);
                const rawName = parts[0].replace(/^"|"$/gu, '');
                const refCol = colsByName.get(rawName);
                if (!refCol) {continue;}
                const ic: JsonIndexColumn = {columnUnid: refCol.unid};
                if (parts.some(p => p.toUpperCase() === 'DESC')) {ic.order = 'DESC';}
                indexColumns.push(ic);
            }
            const using = String(r.using_method || '').toLowerCase();
            let type: string;
            if (using === 'gin') {
                type = JsonIndexType.fulltext;
            } else if (using === 'gist') {
                type = JsonIndexType.spatial;
            } else if (r.is_unique) {
                type = JsonIndexType.unique;
            } else {
                type = JsonIndexType.index;
            }
            out.push({
                unid: LiveUridScheme.index(db, tableName, indexName),
                name: indexName,
                type: type,
                columns: indexColumns
            });
        }
        return out;
    }

    private _buildForeignKeys(db: string, tableName: string, columns: JsonColumn[], rows: DbRow[]): JsonForeignKey[] {
        const colsByName = new Map<string, JsonColumn>();
        for (const c of columns) {colsByName.set(c.name, c);}

        const byName = new Map<string, JsonForeignKey>();
        for (const r of rows) {
            if (String(r.table_name) !== tableName) {continue;}
            const fkName = String(r.constraint_name);
            let fk = byName.get(fkName);
            if (!fk) {
                const refTable = String(r.ref_table);
                fk = {
                    unid: LiveUridScheme.fk(db, tableName, fkName),
                    name: fkName,
                    refTableUnid: LiveUridScheme.table(db, refTable),
                    columns: []
                };
                const onDelete = FkActionMapper.fromSql(r.delete_rule as string);
                const onUpdate = FkActionMapper.fromSql(r.update_rule as string);
                if (onDelete) {fk.onDelete = onDelete;}
                if (onUpdate) {fk.onUpdate = onUpdate;}
                byName.set(fkName, fk);
            }
            const local = colsByName.get(String(r.column_name));
            if (!local) {continue;}
            const fkc: JsonForeignKeyColumn = {
                columnUnid: local.unid,
                refColumnUnid: LiveUridScheme.column(db, String(r.ref_table), String(r.ref_column))
            };
            fk.columns.push(fkc);
        }
        return Array.from(byName.values());
    }

    /*
     * -----------------------------------------------------------------------
     * Views (regular + materialized)
     * -----------------------------------------------------------------------
     */
    private async _loadViews(conn: DbConnection, db: string, schema: string): Promise<JsonView[]> {
        const rows = await conn.query(
            `SELECT v.viewname AS name, v.definition AS body, FALSE AS materialized
               FROM pg_views v
              WHERE v.schemaname = '${schema}'
              UNION ALL
             SELECT m.matviewname AS name, m.definition AS body, TRUE AS materialized
               FROM pg_matviews m
              WHERE m.schemaname = '${schema}'
              ORDER BY name`
        );
        const out: JsonView[] = [];
        for (const r of rows) {
            const name = String(r.name);
            const body = String(r.body || '').trim();
            const view: JsonView = {
                unid: LiveUridScheme.view(db, name),
                name: name,
                pos: {x: 0, y: 0},
                select: body
            };
            if (r.materialized) {view.materialized = true;}
            out.push(view);
        }
        return out;
    }

}