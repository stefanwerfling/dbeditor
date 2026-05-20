import {JsonColumn, JsonEnum, JsonForeignKey, JsonIndex, JsonTable, JsonTableOptions, JsonView} from '../../editor_schemas/JsonData.js';

export enum SchemaChangeKind {
    tableAdded = 'tableAdded',
    tableDropped = 'tableDropped',
    tableOptionsChanged = 'tableOptionsChanged',
    tableRenamed = 'tableRenamed',
    columnAdded = 'columnAdded',
    columnDropped = 'columnDropped',
    columnChanged = 'columnChanged',
    columnRenamed = 'columnRenamed',
    indexAdded = 'indexAdded',
    indexDropped = 'indexDropped',
    indexChanged = 'indexChanged',
    fkAdded = 'fkAdded',
    fkDropped = 'fkDropped',
    fkChanged = 'fkChanged',
    viewAdded = 'viewAdded',
    viewDropped = 'viewDropped',
    viewChanged = 'viewChanged',
    enumAdded = 'enumAdded',
    enumDropped = 'enumDropped',
    enumChanged = 'enumChanged'
}

/**
 * User-supplied rename mappings. When the SyncDialog UI lets the user
 * pair a `tableDropped` with a `tableAdded` (or column-level analog),
 * the pairing gets surfaced here. `SchemaDiff.diff` collapses each
 * pairing into a single `tableRenamed`/`columnRenamed` entry instead
 * of the drop+add pair, and the SyncGenerator emits a `RENAME` SQL
 * statement.
 *
 * `from` is the live-DB-side name; `to` is the model-side name.
 * Column renames carry the table context.
 */
export type SchemaRenameHints = {
    tables?: {from: string; to: string;}[];
    columns?: {tableName: string; from: string; to: string;}[];
};

export type SchemaChangeSeverity = 'safe' | 'warn' | 'destructive';

/**
 * One typed change. `before` is the live-DB state (what's currently there);
 * `after` is the model state (what we want). `direction` is implicit: every
 * change describes the work needed to make the LIVE side match the MODEL.
 *
 * `sql` is populated by the SyncGenerator — the diff engine itself produces
 * no SQL, only structural deltas.
 */
export type SchemaChange = {
    id: string;
    kind: SchemaChangeKind;
    severity: SchemaChangeSeverity;
    /** Name of the affected table (or the table that owns the affected child object). */
    tableName?: string;
    columnName?: string;
    indexName?: string;
    fkName?: string;
    viewName?: string;
    /** Name of the affected enum type — mutually exclusive with the table-side names. */
    enumName?: string;
    /** Live-side value, if any. */
    before?: JsonColumn | JsonIndex | JsonForeignKey | JsonTable | JsonView | JsonTableOptions | JsonEnum;
    /** Model-side value, if any. */
    after?: JsonColumn | JsonIndex | JsonForeignKey | JsonTable | JsonView | JsonTableOptions | JsonEnum;
    /** Filled in by SyncGenerator — one or more SQL statements that realise this change. */
    sql: string[];
};

export type SchemaChangeSet = {
    /** Project-side unid of the database container this changeset applies to. */
    databaseUnid: string;
    /** Database name as known to the live DB. */
    databaseName: string;
    changes: SchemaChange[];
};