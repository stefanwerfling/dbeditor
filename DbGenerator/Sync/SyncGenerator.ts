import {DbFsTreeWalker} from '../../DbRepository/DbFsTreeWalker.js';
import {JsonColumn, JsonDataDB, JsonForeignKey, JsonIndex, JsonTable, JsonView} from '../../DbEditor/JsonData.js';
import {SchemaChange, SchemaChangeKind, SchemaChangeSet} from '../../DbDiff/ChangeTypes.js';
import {DbDialect, DialectContext} from '../DbDialect.js';

/**
 * One SQL statement that realises a single change-ID. The pairing lets the
 * UI map back from a failed statement to the change the user originally
 * picked.
 */
export type SyncStatement = {
    changeId: string;
    kind: SchemaChangeKind;
    sql: string;
    /** Lower number = earlier execution. */
    bucket: number;
};

/**
 * Execution-order buckets. Within a bucket order doesn't matter beyond
 * stable iteration of the changeset. Across buckets the order is:
 *
 *   1  drop FKs that reference soon-to-go columns / tables
 *   2  drop views (might reference columns we touch)
 *   3  drop indexes
 *   4  drop columns
 *   5  drop tables
 *   6  create new tables
 *   7  add columns
 *   8  alter columns
 *   9  alter table options
 *   10 create indexes
 *   11 add FKs
 *   12 replace / create views
 */
const Bucket = {
    /*
     * Renames go FIRST. Subsequent buckets reference the table/column
     * by its model-side name; renaming early makes those name lookups
     * resolve. Table-rename precedes column-rename so column refs use
     * the new table name.
     */
    renameTable: -2,
    renameColumn: -1,
    dropFk: 1,
    dropView: 2,
    dropIndex: 3,
    dropColumn: 4,
    dropTable: 5,
    createTable: 6,
    addColumn: 7,
    alterColumn: 8,
    alterTableOptions: 9,
    createIndex: 10,
    addFk: 11,
    createOrReplaceView: 12
};

const isColumn = (v: unknown): v is JsonColumn => Boolean(v) && typeof (v as JsonColumn).name === 'string' && typeof (v as JsonColumn).type === 'string';
const isTable = (v: unknown): v is JsonTable => Boolean(v) && Array.isArray((v as JsonTable).columns);
const isIndex = (v: unknown): v is JsonIndex => Boolean(v) && Array.isArray((v as JsonIndex).columns) && typeof (v as JsonIndex).type === 'string';
const isFk = (v: unknown): v is JsonForeignKey => Boolean(v) && typeof (v as JsonForeignKey).refTableUnid === 'string';
const isView = (v: unknown): v is JsonView => Boolean(v) && typeof (v as JsonView).select === 'string';

/**
 * Renders SQL for every change in a `SchemaChangeSet`. Mutates the changeset
 * in place by filling each change's `sql[]` array and additionally returns
 * an ordered list of `SyncStatement`s for execution.
 *
 * `modelDb` is the model-side database container that was diffed — used to
 * look up affected tables by name when the change itself only carries the
 * table name.
 */
export class SyncGenerator {

    public static generate(
        changeSet: SchemaChangeSet,
        modelDb: JsonDataDB,
        dialect: DbDialect,
        ctx: DialectContext
    ): SyncStatement[] {
        const tablesByName = new Map<string, JsonTable>();
        for (const {table} of DbFsTreeWalker.allTables(modelDb)) {tablesByName.set(table.name, table);}

        const statements: SyncStatement[] = [];

        for (const change of changeSet.changes) {
            /* Reset any prior SQL so re-rendering after a config change works. */
            change.sql = [];
            const parts = SyncGenerator._renderChange(change, tablesByName, dialect, ctx);
            for (const p of parts) {
                change.sql.push(p.sql);
                statements.push({changeId: change.id, kind: change.kind, sql: p.sql, bucket: p.bucket});
            }
        }

        statements.sort((a, b) => a.bucket - b.bucket);
        return statements;
    }

    /*
     * -----------------------------------------------------------------------
     * Per-change dispatch
     * -----------------------------------------------------------------------
     */
    private static _renderChange(
        change: SchemaChange,
        tablesByName: Map<string, JsonTable>,
        dialect: DbDialect,
        ctx: DialectContext
    ): { sql: string; bucket: number; }[] {
        /* SyncGenerator doesn't append a terminator — the executor or UI does. */
        const term = '';
        const ix = (): JsonIndex => {
            if (isIndex(change.after) || isIndex(change.before)) {return (change.after ?? change.before) as JsonIndex;}
            throw new Error('index change missing payload');
        };
        const fk = (): JsonForeignKey => {
            if (isFk(change.after) || isFk(change.before)) {return (change.after ?? change.before) as JsonForeignKey;}
            throw new Error('fk change missing payload');
        };

        const tableFor = (): JsonTable | null => {
            const name = change.tableName;
            if (!name) {return null;}
            return tablesByName.get(name) ?? null;
        };

        switch (change.kind) {
            case SchemaChangeKind.tableAdded: {
                if (!isTable(change.after)) {return [];}
                const create = dialect.renderCreateTable(change.after, ctx) + term;
                const out: { sql: string; bucket: number; }[] = [{sql: create, bucket: Bucket.createTable}];
                /*
                 * Indexes and FKs for a brand-new table go into their own
                 * buckets so they sequence correctly with cross-table changes.
                 */
                for (const idx of change.after.indexes) {
                    const s = dialect.renderCreateIndex(change.after, idx, ctx);
                    if (s) {out.push({sql: s + term, bucket: Bucket.createIndex});}
                }
                for (const f of change.after.foreignKeys) {
                    const s = dialect.renderAddForeignKey(change.after, f, ctx);
                    if (s) {out.push({sql: s + term, bucket: Bucket.addFk});}
                }
                return out;
            }
            case SchemaChangeKind.tableDropped: {
                if (!isTable(change.before)) {return [];}
                /*
                 * Drop FKs on the table first so the table-drop doesn't
                 * fight referential constraints. The diff itself doesn't
                 * emit fkDropped for FKs that are part of a tableDropped,
                 * but we still need to drop them here.
                 */
                const out: { sql: string; bucket: number; }[] = [];
                for (const f of change.before.foreignKeys) {
                    out.push({sql: dialect.renderDropForeignKey(change.before, f.name, ctx) + term, bucket: Bucket.dropFk});
                }
                out.push({sql: dialect.renderDropTable(change.before, ctx) + term, bucket: Bucket.dropTable});
                return out;
            }
            case SchemaChangeKind.tableOptionsChanged: {
                const t = tableFor();
                if (!t) {return [];}
                const s = dialect.renderAlterTableOptions(t, ctx);
                return s ? [{sql: s + term, bucket: Bucket.alterTableOptions}] : [];
            }
            case SchemaChangeKind.columnAdded: {
                const t = tableFor();
                if (!t || !isColumn(change.after)) {return [];}
                return [{sql: dialect.renderAlterTableAddColumn(t, change.after, ctx) + term, bucket: Bucket.addColumn}];
            }
            case SchemaChangeKind.columnDropped: {
                const t = tableFor();
                if (!t || !isColumn(change.before)) {return [];}
                return [{sql: dialect.renderAlterTableDropColumn(t, change.before, ctx) + term, bucket: Bucket.dropColumn}];
            }
            case SchemaChangeKind.columnChanged: {
                const t = tableFor();
                if (!t || !isColumn(change.before) || !isColumn(change.after)) {return [];}
                return [{sql: dialect.renderAlterTableChangeColumn(t, change.before, change.after, ctx) + term, bucket: Bucket.alterColumn}];
            }
            case SchemaChangeKind.indexAdded: {
                const t = tableFor();
                if (!t) {return [];}
                const s = dialect.renderCreateIndex(t, ix(), ctx);
                return s ? [{sql: s + term, bucket: Bucket.createIndex}] : [];
            }
            case SchemaChangeKind.indexDropped: {
                const t = tableFor();
                if (!t || !isIndex(change.before)) {return [];}
                const s = dialect.renderDropIndex(t, change.before, ctx);
                return s ? [{sql: s + term, bucket: Bucket.dropIndex}] : [];
            }
            case SchemaChangeKind.indexChanged: {
                const t = tableFor();
                if (!t) {return [];}
                const drop = isIndex(change.before) ? dialect.renderDropIndex(t, change.before, ctx) : null;
                const create = isIndex(change.after) ? dialect.renderCreateIndex(t, change.after, ctx) : null;
                const out: { sql: string; bucket: number; }[] = [];
                if (drop) {out.push({sql: drop + term, bucket: Bucket.dropIndex});}
                if (create) {out.push({sql: create + term, bucket: Bucket.createIndex});}
                return out;
            }
            case SchemaChangeKind.fkAdded: {
                const t = tableFor();
                if (!t) {return [];}
                const s = dialect.renderAddForeignKey(t, fk(), ctx);
                return s ? [{sql: s + term, bucket: Bucket.addFk}] : [];
            }
            case SchemaChangeKind.fkDropped: {
                const t = tableFor();
                if (!t || !isFk(change.before)) {return [];}
                return [{sql: dialect.renderDropForeignKey(t, change.before.name, ctx) + term, bucket: Bucket.dropFk}];
            }
            case SchemaChangeKind.fkChanged: {
                const t = tableFor();
                if (!t) {return [];}
                const out: { sql: string; bucket: number; }[] = [];
                if (isFk(change.before)) {out.push({sql: dialect.renderDropForeignKey(t, change.before.name, ctx) + term, bucket: Bucket.dropFk});}
                if (isFk(change.after)) {
                    const s = dialect.renderAddForeignKey(t, change.after, ctx);
                    if (s) {out.push({sql: s + term, bucket: Bucket.addFk});}
                }
                return out;
            }
            case SchemaChangeKind.viewAdded:
            case SchemaChangeKind.viewChanged: {
                if (!isView(change.after)) {return [];}
                const s = change.kind === SchemaChangeKind.viewAdded
                    ? dialect.renderCreateView(change.after, ctx)
                    : dialect.renderReplaceView(change.after, ctx);
                return s ? [{sql: s + term, bucket: Bucket.createOrReplaceView}] : [];
            }
            case SchemaChangeKind.viewDropped: {
                if (!isView(change.before)) {return [];}
                const s = dialect.renderDropView(change.before, ctx);
                return s ? [{sql: s + term, bucket: Bucket.dropView}] : [];
            }
            case SchemaChangeKind.tableRenamed: {
                /*
                 * The diff stores the OLD name in change.before (a
                 * JsonTable with the live name) and the NEW name in
                 * change.tableName. We render the rename only —
                 * subsequent column/index changes flow normally
                 * after this bucket completes.
                 */
                if (!isTable(change.before) || !change.tableName) {return [];}
                const s = dialect.renderRenameTable(change.before.name, change.tableName, ctx);
                return s ? [{sql: s + term, bucket: Bucket.renameTable}] : [];
            }
            case SchemaChangeKind.columnRenamed: {
                const t = tableFor();
                if (!t || !isColumn(change.before) || !isColumn(change.after)) {return [];}
                const s = dialect.renderRenameColumn(t, change.before.name, change.after, ctx);
                return s ? [{sql: s + term, bucket: Bucket.renameColumn}] : [];
            }
            default:
                return [];
        }
    }

}