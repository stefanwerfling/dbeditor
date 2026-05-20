import {JsonDataDB, JsonTable, JsonView, JsonColumn} from '../DbEditor/JsonData.js';
import {DbFsTreeWalker} from '../DbRepository/DbFsTreeWalker.js';
import {DbProjectSync} from '../DbProject/DbProject.js';
import {SchemaChange, SchemaChangeKind, SchemaChangeSet, SchemaChangeSeverity, SchemaRenameHints} from './ChangeTypes.js';
import {ColumnEquivalence} from './ColumnEquivalence.js';

const severityFor = (kind: SchemaChangeKind): SchemaChangeSeverity => {
    switch (kind) {
        case SchemaChangeKind.tableDropped:
        case SchemaChangeKind.columnDropped:
            return 'destructive';
        case SchemaChangeKind.columnChanged:
        case SchemaChangeKind.indexChanged:
        case SchemaChangeKind.fkChanged:
        case SchemaChangeKind.viewChanged:
        case SchemaChangeKind.tableOptionsChanged:
        case SchemaChangeKind.indexDropped:
        case SchemaChangeKind.fkDropped:
        case SchemaChangeKind.viewDropped:
        case SchemaChangeKind.tableRenamed:
        case SchemaChangeKind.columnRenamed:
            return 'warn';
        default:
            return 'safe';
    }
};

/*
 * Deterministic change id. Two diff calls on the same input MUST
 * produce the same ids — the sync test-run / apply / reverse-apply
 * routes re-run the diff server-side and filter by `changeIds` the
 * client sent from a prior preview; if ids drifted between calls,
 * every selected change would silently fall out of the filter.
 *
 * The natural key is `(kind, tableName, columnName, indexName,
 * fkName, viewName)`. These fields are mutually exclusive per
 * kind, and at most one change per tuple is emitted in a single
 * diff pass (each loop in `_diffTableContents` walks a name set).
 * Rename changes get their own id pattern that incorporates the
 * before-name so a `a→b` rename and a `c→b` rename can coexist.
 */
const changeId = (kind: SchemaChangeKind, patch: Partial<SchemaChange>): string => {
    const parts = [
        kind,
        patch.tableName ?? '',
        patch.columnName ?? '',
        patch.indexName ?? '',
        patch.fkName ?? '',
        patch.viewName ?? ''
    ];
    return parts.join(':');
};

const newChange = (kind: SchemaChangeKind, patch: Partial<SchemaChange>): SchemaChange => ({
    id: changeId(kind, patch),
    kind: kind,
    severity: severityFor(kind),
    sql: [],
    ...patch
});

/**
 * Diff a model database against a live-introspected database. Matching is
 * by NAME at every level (table, column, index, fk, view). Renames are
 * never inferred — a model rename results in `dropped`+`added` pair, which
 * the user resolves manually in iter 7.
 *
 * Returns every meaningful change. `sql[]` arrays are empty — the caller
 * (SyncGenerator) renders dialect-specific SQL afterwards.
 */
export class SchemaDiff {

    public static diff(
        modelDb: JsonDataDB,
        liveDb: JsonDataDB,
        sync: DbProjectSync,
        modelRoot?: JsonDataDB,
        diagramUnid?: string,
        renames?: SchemaRenameHints
    ): SchemaChangeSet {
        const changes: SchemaChange[] = [];
        const ignoreTables = new Set(sync.ignoreTables);
        const ignoreColAttrs = new Set(sync.ignoreColumnAttributes);

        const modelTablesByUnid = new Map<string, JsonTable>();
        const root = modelRoot ?? modelDb;
        for (const {table} of DbFsTreeWalker.allTables(root)) {modelTablesByUnid.set(table.unid, table);}

        /*
         * Layer-scoping (optional). When `diagramUnid` is supplied, we
         * restrict the diff to the set of table NAMES whose
         * `diagramUnid` matches in the model. The live side is filtered
         * to the same names so live-only tables outside the diagram
         * don't pollute the diff (they'd otherwise surface as
         * `tableDropped` since the model doesn't have them in
         * scope). Views/enums/routines are skipped entirely under
         * diagram-scope — layers don't own non-table objects.
         */
        const layerTableNames = diagramUnid
            ? new Set<string>([...DbFsTreeWalker.allTables(modelDb)]
            .filter(({table}) => table.diagramUnid === diagramUnid)
            .map(({table}) => table.name))
            : null;

        /*
         * ---------------- tables ----------------
         * Flatten the model side through any folders; the live side is
         * already flat because the introspector doesn't carry folders.
         */
        const modelTables = new Map<string, JsonTable>();
        for (const {table} of DbFsTreeWalker.allTables(modelDb)) {
            if (ignoreTables.has(table.name)) {continue;}
            if (layerTableNames && !layerTableNames.has(table.name)) {continue;}
            modelTables.set(table.name, table);
        }
        const liveTables = new Map<string, JsonTable>();
        for (const t of liveDb.tables) {
            if (ignoreTables.has(t.name)) {continue;}
            if (layerTableNames && !layerTableNames.has(t.name)) {continue;}
            liveTables.set(t.name, t);
        }

        const allTableNames = new Set([...modelTables.keys(), ...liveTables.keys()]);
        for (const name of [...allTableNames].sort()) {
            const m = modelTables.get(name);
            const l = liveTables.get(name);
            if (m && !l) {
                changes.push(newChange(SchemaChangeKind.tableAdded, {tableName: name, after: m}));
                continue;
            }
            if (!m && l) {
                changes.push(newChange(SchemaChangeKind.tableDropped, {tableName: name, before: l}));
                continue;
            }
            if (m && l) {
                SchemaDiff._diffTableContents(m, l, ignoreColAttrs, modelTablesByUnid, modelDb, changes);
            }
        }

        /*
         * ---------------- views ----------------
         * Under diagram-scope, views are excluded — layers in the model
         * are a table-only grouping construct. Views still get
         * synced normally on the unscoped (database-level) flow.
         */
        const modelViews = new Map<string, JsonView>();
        if (!layerTableNames) {
            for (const {view} of DbFsTreeWalker.allViews(modelDb)) {modelViews.set(view.name, view);}
        }
        const liveViews = new Map<string, JsonView>();
        if (!layerTableNames) {
            for (const v of liveDb.views) {liveViews.set(v.name, v);}
        }
        const allViewNames = new Set([...modelViews.keys(), ...liveViews.keys()]);
        for (const name of [...allViewNames].sort()) {
            const m = modelViews.get(name);
            const l = liveViews.get(name);
            if (m && !l) {changes.push(newChange(SchemaChangeKind.viewAdded, {viewName: name, after: m})); continue;}
            if (!m && l) {changes.push(newChange(SchemaChangeKind.viewDropped, {viewName: name, before: l})); continue;}
            if (m && l && !ColumnEquivalence.viewsEquivalent(l, m)) {
                changes.push(newChange(SchemaChangeKind.viewChanged, {viewName: name, before: l, after: m}));
            }
        }

        /*
         * Apply user-supplied rename hints: collapse matching
         * drop+add pairs into single `tableRenamed`/`columnRenamed`
         * entries. Pairs that don't both exist are left alone (the
         * UI may have been operating on stale data). Order is
         * preserved by replacing the first member of the pair and
         * removing the second.
         */
        const finalChanges = renames
            ? SchemaDiff._applyRenameHints(changes, renames)
            : changes;

        return {
            databaseUnid: modelDb.unid,
            databaseName: liveDb.name,
            changes: finalChanges
        };
    }

    /**
     * Collapse user-paired drop+add into single rename changes. Each
     * pairing is matched against the change list by (kind, name,
     * tableName) tuples; matched pairs are replaced with a single
     * rename entry positioned at the original drop's index. Pairings
     * referencing missing entries are skipped (no error — UI may
     * have stale data; the apply path simply does fewer renames).
     */
    private static _applyRenameHints(
        changes: SchemaChange[],
        renames: SchemaRenameHints
    ): SchemaChange[] {
        const out = [...changes];
        for (const r of renames.tables ?? []) {
            const dropIdx = out.findIndex(c => c.kind === SchemaChangeKind.tableDropped && c.tableName === r.from);
            const addIdx = out.findIndex(c => c.kind === SchemaChangeKind.tableAdded && c.tableName === r.to);
            if (dropIdx < 0 || addIdx < 0) {continue;}
            const drop = out[dropIdx];
            const add = out[addIdx];
            const renamed: SchemaChange = {
                id: `tableRenamed:${r.from}:${r.to}`,
                kind: SchemaChangeKind.tableRenamed,
                severity: 'warn',
                tableName: r.to,
                before: drop.before,
                after: add.after,
                sql: []
            };
            /*
             * Splice the drop with the renamed entry, then remove the
             * add. Adjust addIdx if it was after dropIdx (the splice
             * keeps positions but the remove walks backwards anyway).
             */
            out[dropIdx] = renamed;
            out.splice(addIdx, 1);
        }
        for (const r of renames.columns ?? []) {
            const dropIdx = out.findIndex(c =>
                c.kind === SchemaChangeKind.columnDropped
                && c.tableName === r.tableName
                && c.columnName === r.from);
            const addIdx = out.findIndex(c =>
                c.kind === SchemaChangeKind.columnAdded
                && c.tableName === r.tableName
                && c.columnName === r.to);
            if (dropIdx < 0 || addIdx < 0) {continue;}
            const drop = out[dropIdx];
            const add = out[addIdx];
            const renamed: SchemaChange = {
                id: `columnRenamed:${r.tableName}:${r.from}:${r.to}`,
                kind: SchemaChangeKind.columnRenamed,
                severity: 'warn',
                tableName: r.tableName,
                columnName: r.to,
                before: drop.before,
                after: add.after,
                sql: []
            };
            out[dropIdx] = renamed;
            out.splice(addIdx, 1);
        }
        return out;
    }

    /*
     * -----------------------------------------------------------------------
     * Per-table diff: columns, indexes, foreign keys, options
     * -----------------------------------------------------------------------
     */
    private static _diffTableContents(
        model: JsonTable,
        live: JsonTable,
        ignoreColAttrs: Set<string>,
        modelTablesByUnid: Map<string, JsonTable>,
        modelDb: JsonDataDB,
        changes: SchemaChange[]
    ): void {
        /* columns */
        const modelCols = new Map<string, JsonColumn>();
        for (const c of model.columns) {modelCols.set(c.name, c);}
        const liveCols = new Map<string, JsonColumn>();
        for (const c of live.columns) {liveCols.set(c.name, c);}
        const allColNames = new Set([...modelCols.keys(), ...liveCols.keys()]);
        for (const name of [...allColNames]) {
            const m = modelCols.get(name);
            const l = liveCols.get(name);
            if (m && !l) {
                changes.push(newChange(SchemaChangeKind.columnAdded, {
                    tableName: model.name, columnName: name, after: m
                }));
                continue;
            }
            if (!m && l) {
                changes.push(newChange(SchemaChangeKind.columnDropped, {
                    tableName: model.name, columnName: name, before: l
                }));
                continue;
            }
            if (m && l) {
                const d = ColumnEquivalence.diffColumn(l, m, ignoreColAttrs);
                if (d) {
                    changes.push(newChange(SchemaChangeKind.columnChanged, {
                        tableName: model.name, columnName: name, before: l, after: m
                    }));
                }
            }
        }

        /* indexes */
        const modelColName = (unid: string): string => {
            const c = model.columns.find(x => x.unid === unid);
            return c?.name ?? '';
        };
        const liveColName = (unid: string): string => {
            const c = live.columns.find(x => x.unid === unid);
            return c?.name ?? '';
        };

        const modelIdx = new Map(model.indexes.map(i => [i.name, i]));
        const liveIdx = new Map(live.indexes.map(i => [i.name, i]));
        const allIdxNames = new Set([...modelIdx.keys(), ...liveIdx.keys()]);
        for (const name of [...allIdxNames]) {
            const m = modelIdx.get(name);
            const l = liveIdx.get(name);
            if (m && !l) {changes.push(newChange(SchemaChangeKind.indexAdded, {tableName: model.name, indexName: name, after: m})); continue;}
            if (!m && l) {changes.push(newChange(SchemaChangeKind.indexDropped, {tableName: model.name, indexName: name, before: l})); continue;}
            if (m && l) {
                const sameShape = ColumnEquivalence.indexesEquivalent(l, m);
                const sameCols = ColumnEquivalence.indexColumnNamesEqual(l, m, liveColName, modelColName);
                if (!sameShape || !sameCols) {
                    changes.push(newChange(SchemaChangeKind.indexChanged, {tableName: model.name, indexName: name, before: l, after: m}));
                }
            }
        }

        /* foreign keys — referenced table name lookup via the live side's unid scheme */
        const modelFk = new Map(model.foreignKeys.map(f => [f.name, f]));
        const liveFk = new Map(live.foreignKeys.map(f => [f.name, f]));
        const allFkNames = new Set([...modelFk.keys(), ...liveFk.keys()]);
        for (const name of [...allFkNames]) {
            const m = modelFk.get(name);
            const l = liveFk.get(name);
            if (m && !l) {changes.push(newChange(SchemaChangeKind.fkAdded, {tableName: model.name, fkName: name, after: m})); continue;}
            if (!m && l) {changes.push(newChange(SchemaChangeKind.fkDropped, {tableName: model.name, fkName: name, before: l})); continue;}
            if (m && l) {
                /*
                 * Cross-table name resolution: both sides use unids, but the
                 * unids on the live side encode the table name and the model
                 * side requires a tree lookup. The caller already knows we're
                 * comparing within ONE database, so we can use simple maps
                 * derived from this scope's `model` / `live`.
                 *
                 * Building a full project-wide ref-table-name resolver is
                 * overkill for v1; here we strip the live `live:t:db:` prefix
                 * for the live side and use the model's full tree.
                 */
                const liveRefTableName = (unid: string): string => {
                    const parts = unid.split(':');
                    return parts[parts.length - 1] || unid;
                };
                /*
                 * Model side: we get only the local table, but FKs can point
                 * anywhere. The caller of SchemaDiff.diff should ideally
                 * provide a project-wide resolver — for v1 we expose only the
                 * names of locally-known tables; cross-table FKs to other
                 * databases are out of scope.
                 */
                const modelRefTableName = (unid: string): string => {
                    return modelTablesByUnid.get(unid)?.name ?? '';
                };
                if (!ColumnEquivalence.fksEquivalent(l, m, liveColName, modelColName, liveRefTableName, modelRefTableName)) {
                    changes.push(newChange(SchemaChangeKind.fkChanged, {tableName: model.name, fkName: name, before: l, after: m}));
                }
            }
        }

        /*
         * table options — engine / charset / collation / etc.
         * Falls back to the model database's defaults (set via
         * Database properties dialog) so per-table options that just
         * inherit don't surface as drift.
         */
        const modelDefaults = {
            engine: modelDb.defaultEngine,
            charset: modelDb.defaultCharset,
            collation: modelDb.defaultCollation
        };
        if (!ColumnEquivalence.tableOptionsEquivalent(live.options, model.options, new Set(), modelDefaults)) {
            changes.push(newChange(SchemaChangeKind.tableOptionsChanged, {tableName: model.name, before: live.options, after: model.options}));
        }
    }

}