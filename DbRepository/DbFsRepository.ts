import * as fs from 'fs';
import * as path from 'path';
import {randomUUID} from 'crypto';
import {DbProject, DbProjectSync} from '../DbProject/DbProject.js';
import {
    JsonData,
    JsonDataDB,
    JsonDataDBType,
    JsonTable,
    JsonColumn,
    JsonIndex,
    JsonForeignKey,
    JsonEnum,
    JsonEnumValue,
    JsonDiagram,
    JsonLayer,
    JsonView,
    JsonEditorSettings,
    JsonOutputSettings,
    JsonPosition,
    JsonRoutine,
    JsonRoutineKind,
    JsonSyncSettings,
    SchemaJsonData
} from '../DbEditor/JsonData.js';
import {MwbTableCacheEntry} from '../DbMwbImport/MwbReader.js';
import {DbRepositoryEventBus} from './DbRepositoryEventBus.js';
import {DbFsTreeWalker} from './DbFsTreeWalker.js';
import {RepoNotFoundError, RepoInvalidError} from './DbRepositoryErrors.js';
import {SchemaChange, SchemaChangeKind} from '../DbDiff/ChangeTypes.js';

const FLUSH_DEBOUNCE_MS = 150;

const emptyData = (name: string): JsonData => ({
    fs: {
        unid: 'root',
        name: 'root',
        type: JsonDataDBType.root,
        entrys: [
            {
                unid: randomUUID(),
                name: name,
                type: JsonDataDBType.database,
                istoggle: true,
                entrys: [],
                tables: [],
                views: [],
                enums: [],
                routines: []
            } as JsonDataDB
        ],
        tables: [],
        views: [],
        enums: [],
        routines: []
    },
    editor: {}
});

const defaultPos = (): JsonPosition => ({x: 80, y: 80});

/**
 * In-memory store for one project's JSON tree. Mutations are synchronous
 * and increment a revision counter; persistence is debounced. After every
 * flush we optionally run a hook (used by the backend to trigger codegen
 * when `autoGenerate` is on).
 */
const UNDO_STACK_MAX = 100;

export class DbFsRepository {

    private readonly _project: DbProject;
    private readonly _bus = new DbRepositoryEventBus();
    private _data: JsonData;
    private _rev = 0;
    private _flushTimer: ReturnType<typeof setTimeout> | null = null;
    private _flushPending = false;
    private _afterFlush: ((repo: DbFsRepository) => void | Promise<void>) | null = null;
    /*
     * Undo/redo: stacks of full JsonData snapshots. The top of `_undoStack`
     * is always the *current* state, so undo pops one entry and pushes it
     * onto `_redoStack`; the new stack top becomes the live state. A fresh
     * mutation after some undo() clears `_redoStack` — the redo path is
     * abandoned, mirroring every other editor.
     */
    private _undoStack: JsonData[] = [];
    private _redoStack: JsonData[] = [];

    /*
     * Whole-file MWB roundtrip preservation. Set immediately after a
     * `.mwb` import in replace mode; cleared by `_commit` on any
     * mutation. While present, `export-mwb` returns these bytes
     * verbatim instead of regenerating via MwbWriter — useful when
     * the user opens a .mwb in dbeditor, makes no changes, and saves
     * it back: byte-identical output. The persisted store ignores
     * this field; restart drops it (in-memory only).
     */
    private _mwbOriginalBytes: Buffer | null = null;

    /*
     * Phase E.2 per-object roundtrip cache. Map of routine.unid →
     * raw outer-XML bytes of the source `db.mysql.Routine` struct.
     * Survives non-routine mutations (per-object granularity) but
     * an `updateRoutine` / `deleteRoutine` drops the matching entry
     * — the cached bytes no longer reflect the live model state.
     * `replaceFs` clears all entries.
     */
    private _mwbOriginalRoutineXml: Map<string, string> = new Map();
    private _mwbOriginalViewXml: Map<string, string> = new Map();
    /*
     * Tables are all-or-nothing within the set: any structural
     * change to ANY table (column add/remove/reorder, index, FK)
     * potentially invalidates ID cross-references in the other
     * cached tables' FK refs. _commit clears this map whenever the
     * mutation op is in the table/column/index/fk family.
     */
    private _mwbOriginalTableXml: Map<string, MwbTableCacheEntry> = new Map();

    public constructor(project: DbProject) {
        this._project = project;
        this._data = this._loadFromDisk();
        /* Initial state goes on the undo stack so the very first mutation has something to fall back to. */
        this._undoStack.push(this._cloneData(this._data));
    }

    public get project(): DbProject { return this._project; }
    public get bus(): DbRepositoryEventBus { return this._bus; }
    public get rev(): number { return this._rev; }
    public get data(): JsonData { return this._data; }
    public get canUndo(): boolean { return this._undoStack.length > 1; }
    public get canRedo(): boolean { return this._redoStack.length > 0; }

    public setAfterFlush(fn: (repo: DbFsRepository) => void | Promise<void>): void {
        this._afterFlush = fn;
    }

    /*
     * ---------------------------------------------------------------------
     * Undo / Redo
     *
     * Snapshot strategy: every `_commit` deep-clones the post-mutation tree
     * and pushes it onto the undo stack. Coarse and memory-hungry compared
     * to a command-pattern approach with per-op inverses, but correct by
     * construction and easy to reason about — a 50-table schema clones in
     * under a millisecond and the 100-entry cap keeps memory bounded.
     */
    public undo(clientId: string | null): { applied: boolean; rev: number; } {
        if (!this.canUndo) {return { applied: false, rev: this._rev };}
        const popped = this._undoStack.pop();
        if (!popped) {return { applied: false, rev: this._rev };}
        this._redoStack.push(popped);
        const target = this._undoStack[this._undoStack.length - 1];
        this._data = this._cloneData(target);
        this._rev += 1;
        this._bus.publish({
            rev: this._rev,
            op: 'state.replaced',
            clientId: clientId,
            body: { reason: 'undo' }
        });
        this._scheduleFlush();
        return { applied: true, rev: this._rev };
    }

    public redo(clientId: string | null): { applied: boolean; rev: number; } {
        if (!this.canRedo) {return { applied: false, rev: this._rev };}
        const popped = this._redoStack.pop();
        if (!popped) {return { applied: false, rev: this._rev };}
        this._undoStack.push(popped);
        this._data = this._cloneData(popped);
        this._rev += 1;
        this._bus.publish({
            rev: this._rev,
            op: 'state.replaced',
            clientId: clientId,
            body: { reason: 'redo' }
        });
        this._scheduleFlush();
        return { applied: true, rev: this._rev };
    }

    private _cloneData(d: JsonData): JsonData {
        return structuredClone(d);
    }

    private _pushUndoSnapshot(): void {
        this._undoStack.push(this._cloneData(this._data));
        if (this._undoStack.length > UNDO_STACK_MAX) {
            /* Drop the oldest pre-state, NOT the current top. */
            this._undoStack.shift();
        }
        /* Any fresh mutation invalidates the redo path. */
        this._redoStack.length = 0;
    }

    /*
     * ---------------------------------------------------------------------
     * Persistence
     * ---------------------------------------------------------------------
     */

    private _loadFromDisk(): JsonData {
        const file = this._project.schemaPath;
        if (!fs.existsSync(file)) {return emptyData(this._project.name);}
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
            DbFsRepository._migrateLegacyLayerSchema(raw);
            const errors: any[] = [];
            if (!SchemaJsonData.validate(raw, errors)) {
                console.error(`[DbFsRepository] schema in ${file} failed validation, using empty:`, errors);
                return emptyData(this._project.name);
            }
            return raw as JsonData;
        } catch (err) {
            console.error(`[DbFsRepository] failed to read ${file}:`, err);
            return emptyData(this._project.name);
        }
    }

    /*
     * Phase 1 + 2 layer→diagram migration. Legacy schemas have:
     *  - `layerUnid` / `layerPlacements` on tables / views,
     *  - `layers` on db / folder / project nodes (visual rects with
     *    pos/width/height/color, no parent diagram),
     *  - `type: 'layer'` on the diagram-row node itself.
     *
     * Phase 2 turned JsonDiagram into a pure logical container —
     * strip the visual fields at load time so Vts validation passes.
     *
     * Phase 3 reintroduces `layers` at the DataDB level, but with a
     * different shape (a `JsonLayer` carries `diagramUnid` linking
     * it to a parent diagram). Files written by Phase 3+ already
     * have a `diagrams` array, so the `layers → diagrams` rename
     * below is guarded by `!Array.isArray(node.diagrams)` and only
     * fires on pre-Phase-1 files. Phase-3 layers are NOT touched.
     */
    private static _migrateLegacyLayerSchema(raw: any): void {
        if (!raw || typeof raw !== 'object' || !raw.fs) {return;}
        const renamePlacements = (entity: any): void => {
            if (entity.layerUnid !== undefined && entity.diagramUnid === undefined) {
                entity.diagramUnid = entity.layerUnid;
                delete entity.layerUnid;
            }
            if (Array.isArray(entity.layerPlacements) && !Array.isArray(entity.diagramPlacements)) {
                entity.diagramPlacements = entity.layerPlacements.map((p: any) => ({
                    diagramUnid: p.layerUnid ?? p.diagramUnid,
                    pos: p.pos
                }));
                delete entity.layerPlacements;
            }
        };
        const stripVisualProps = (d: any): void => {
            if (!d || typeof d !== 'object') {return;}
            delete d.pos;
            delete d.width;
            delete d.height;
            delete d.color;
        };
        const walk = (node: any): void => {
            if (!node || typeof node !== 'object') {return;}
            if (node.type === 'layer') {node.type = 'diagram';}
            if (Array.isArray(node.layers) && !Array.isArray(node.diagrams)) {
                node.diagrams = node.layers;
                delete node.layers;
            }
            if (Array.isArray(node.diagrams)) {
                for (const d of node.diagrams) {stripVisualProps(d);}
            }
            if (Array.isArray(node.tables)) {
                for (const t of node.tables) {renamePlacements(t);}
            }
            if (Array.isArray(node.views)) {
                for (const v of node.views) {renamePlacements(v);}
            }
            if (Array.isArray(node.entrys)) {
                for (const c of node.entrys) {walk(c);}
            }
        };
        walk(raw.fs);
    }

    private _writeToDisk(): void {
        const file = this._project.schemaPath;
        const dir = path.dirname(file);
        if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true });}
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf-8');
        fs.renameSync(tmp, file);
    }

    private _scheduleFlush(): void {
        this._flushPending = true;
        if (this._flushTimer) {return;}
        this._flushTimer = setTimeout(() => {
            this._flushTimer = null;
            this.flush();
        }, FLUSH_DEBOUNCE_MS);
    }

    public async flush(): Promise<void> {
        if (!this._flushPending) {return;}
        this._flushPending = false;
        try {
            this._writeToDisk();
        } catch (err) {
            console.error('[DbFsRepository] flush failed:', err);
            return;
        }
        if (this._afterFlush) {
            try { await this._afterFlush(this); } catch (err) { console.error('[DbFsRepository] afterFlush:', err); }
        }
    }

    /*
     * ---------------------------------------------------------------------
     * Mutation helper
     * ---------------------------------------------------------------------
     */

    private _commit(op: string, body: unknown, clientId: string | null): number {
        this._rev += 1;
        this._pushUndoSnapshot();
        /*
         * Any mutation invalidates the byte-identical roundtrip
         * passthrough — the model and the cached original-bytes are
         * now divergent. The import route re-arms via
         * `setMwbOriginalBytes` AFTER calling `replaceFs` so the
         * incoming bytes don't get cleared by their own commit.
         */
        this._mwbOriginalBytes = null;
        /*
         * Tables share a cross-reference graph via FKs and index/
         * column ids — any structural change in one table can break
         * cached XML in another. Invalidate the whole table cache
         * on any table/column/index/fk mutation. Triggers live
         * nested inside tables in Workbench's format (routine.* with
         * kind=trigger), so a routine mutation also invalidates the
         * table cache. Routine and view caches stay intact (per-
         * object granularity within their own set).
         */
        if (op.startsWith('table.') || op.startsWith('column.')
            || op.startsWith('index.') || op.startsWith('fk.')
            || op.startsWith('routine.')) {
            this._mwbOriginalTableXml.clear();
        }
        this._bus.publish({ rev: this._rev, op: op, clientId: clientId, body: body });
        this._scheduleFlush();
        return this._rev;
    }

    public setMwbOriginalBytes(bytes: Buffer): void {
        this._mwbOriginalBytes = bytes;
    }

    public getMwbOriginalBytes(): Buffer | null {
        return this._mwbOriginalBytes;
    }

    public setMwbRoutineOriginalXml(map: Map<string, string>): void {
        this._mwbOriginalRoutineXml = new Map(map);
    }

    public getMwbRoutineOriginalXml(): Map<string, string> {
        return this._mwbOriginalRoutineXml;
    }

    public setMwbViewOriginalXml(map: Map<string, string>): void {
        this._mwbOriginalViewXml = new Map(map);
    }

    public getMwbViewOriginalXml(): Map<string, string> {
        return this._mwbOriginalViewXml;
    }

    public setMwbTableOriginalXml(map: Map<string, MwbTableCacheEntry>): void {
        this._mwbOriginalTableXml = new Map(map);
    }

    public getMwbTableOriginalXml(): Map<string, MwbTableCacheEntry> {
        return this._mwbOriginalTableXml;
    }

    /*
     * ---------------------------------------------------------------------
     * Container ops (folder / database)
     * ---------------------------------------------------------------------
     */

    public createContainer(parentUnid: string, name: string, type: JsonDataDBType, clientId: string | null): { rev: number; entry: JsonDataDB; } {
        const parent = DbFsTreeWalker.findContainer(this._data.fs, parentUnid);
        if (!parent) {throw new RepoNotFoundError(`parent container ${parentUnid} not found`);}
        const entry: JsonDataDB = {
            unid: randomUUID(),
            name: name,
            type: type,
            istoggle: true,
            entrys: [],
            tables: [],
            views: [],
            enums: [],
            routines: []
        };
        parent.entrys.push(entry);
        const rev = this._commit('container.create', { parentUnid: parentUnid, entry: entry }, clientId);
        return { rev: rev, entry: entry };
    }

    public updateContainer(unid: string, patch: Partial<Pick<JsonDataDB, 'name' | 'icon' | 'istoggle'>>, clientId: string | null): number {
        const entry = DbFsTreeWalker.findContainer(this._data.fs, unid);
        if (!entry) {throw new RepoNotFoundError(`container ${unid} not found`);}
        if (patch.name !== undefined) {entry.name = patch.name;}
        if (patch.icon !== undefined) {entry.icon = patch.icon;}
        if (patch.istoggle !== undefined) {entry.istoggle = patch.istoggle;}
        return this._commit('container.update', { unid: unid, patch: patch }, clientId);
    }

    public deleteContainer(unid: string, clientId: string | null): number {
        if (unid === 'root') {throw new RepoInvalidError('cannot delete root');}
        const parent = DbFsTreeWalker.findParentOf(this._data.fs, unid);
        if (!parent) {throw new RepoNotFoundError(`container ${unid} not found`);}
        parent.entrys = parent.entrys.filter((c: any) => c.unid !== unid);
        return this._commit('container.delete', { unid: unid }, clientId);
    }

    /**
     * Patch the database-level defaults (engine / charset / collation)
     * inherited by every contained table when its options don't
     * explicitly override. Empty-string values clear the field
     * entirely (`undefined` keeps it untouched). Throws if the unid
     * doesn't resolve to a `database`-type container — root and
     * folders don't carry defaults.
     */
    public updateDatabaseDefaults(
        unid: string,
        patch: Partial<Pick<JsonDataDB, 'defaultEngine' | 'defaultCharset' | 'defaultCollation'>>,
        clientId: string | null
    ): number {
        const entry = DbFsTreeWalker.findContainer(this._data.fs, unid);
        if (!entry) {throw new RepoNotFoundError(`container ${unid} not found`);}
        if (entry.type !== JsonDataDBType.database) {
            throw new RepoInvalidError(`defaults only apply to database containers, got ${entry.type}`);
        }
        const apply = (key: 'defaultEngine' | 'defaultCharset' | 'defaultCollation'): void => {
            if (patch[key] === undefined) {return;}
            if (patch[key] === '') {delete entry[key];}
            else {entry[key] = patch[key];}
        };
        apply('defaultEngine');
        apply('defaultCharset');
        apply('defaultCollation');
        return this._commit('database.update-defaults', { unid: unid, patch: patch }, clientId);
    }

    /*
     * ---------------------------------------------------------------------
     * Table ops
     * ---------------------------------------------------------------------
     */

    public createTable(containerUnid: string, name: string, pos: JsonPosition | null, clientId: string | null): { rev: number; table: JsonTable; } {
        const container = DbFsTreeWalker.findContainer(this._data.fs, containerUnid);
        if (!container) {throw new RepoNotFoundError(`container ${containerUnid} not found`);}
        const table: JsonTable = {
            unid: randomUUID(),
            name: name,
            pos: pos || defaultPos(),
            columns: [],
            indexes: [],
            foreignKeys: [],
            options: {},
            description: ''
        };
        container.tables.push(table);
        const rev = this._commit('table.create', { containerUnid: containerUnid, table: table }, clientId);
        return { rev: rev, table: table };
    }

    public updateTable(unid: string, patch: Partial<Pick<JsonTable, 'name' | 'pos' | 'options' | 'description' | 'diagramUnid' | 'diagramPlacements'>>, clientId: string | null): number {
        const hit = DbFsTreeWalker.findTable(this._data.fs, unid);
        if (!hit) {throw new RepoNotFoundError(`table ${unid} not found`);}
        if (patch.name !== undefined) {hit.table.name = patch.name;}
        if (patch.pos !== undefined) {hit.table.pos = patch.pos;}
        if (patch.options !== undefined) {hit.table.options = patch.options;}
        if (patch.description !== undefined) {hit.table.description = patch.description;}
        if (patch.diagramUnid !== undefined) {
            /*
             * Empty string = unassign (clear the property).
             * Non-empty = set to that diagram unid.
             */
            if (patch.diagramUnid === '') {delete hit.table.diagramUnid;}
            else {hit.table.diagramUnid = patch.diagramUnid;}
        }
        if (patch.diagramPlacements !== undefined) {
            /*
             * Full-replace semantics. Pass `[]` to clear every
             * non-primary diagram membership. Pass a list to set the
             * exact set of additional placements (each with its own
             * per-diagram position). Drop the key entirely from
             * disk when empty so absent-list ≡ no-placements.
             */
            if (patch.diagramPlacements.length === 0) {delete hit.table.diagramPlacements;}
            else {hit.table.diagramPlacements = patch.diagramPlacements;}
        }
        return this._commit('table.update', { unid: unid, patch: patch }, clientId);
    }

    /**
     * Add or update one placement of a table inside a diagram. If the
     * table is not yet in this diagram (no primary `diagramUnid` match,
     * no existing placement), a new placement is appended at `pos`.
     * Otherwise the existing placement's position is updated in place.
     * No-ops cleanly when the diagram is the table's primary one — we
     * update `pos` (the legacy/implicit-placement field) so render
     * code that falls back to `pos` continues to see the new position.
     */
    public setTablePlacement(tableUnid: string, diagramUnid: string, pos: JsonPosition, clientId: string | null): number {
        const hit = DbFsTreeWalker.findTable(this._data.fs, tableUnid);
        if (!hit) {throw new RepoNotFoundError(`table ${tableUnid} not found`);}
        const t = hit.table;
        if (t.diagramUnid === diagramUnid) {
            /* primary diagram — top-level pos is the canonical placement */
            t.pos = pos;
        } else {
            const placements = t.diagramPlacements ?? [];
            const existingIdx = placements.findIndex(p => p.diagramUnid === diagramUnid);
            if (existingIdx >= 0) {
                placements[existingIdx] = {diagramUnid: diagramUnid, pos: pos};
            } else {
                placements.push({diagramUnid: diagramUnid, pos: pos});
            }
            t.diagramPlacements = placements;
        }
        return this._commit('table.placement.set', {tableUnid: tableUnid, diagramUnid: diagramUnid, pos: pos}, clientId);
    }

    /**
     * Remove a table from one diagram. Strips a matching placement
     * if present; clears the primary `diagramUnid` if it equals the
     * supplied diagram. Idempotent — removing a non-membership is a
     * no-op commit so SSE listeners still get a refresh tick.
     */
    public removeTablePlacement(tableUnid: string, diagramUnid: string, clientId: string | null): number {
        const hit = DbFsTreeWalker.findTable(this._data.fs, tableUnid);
        if (!hit) {throw new RepoNotFoundError(`table ${tableUnid} not found`);}
        const t = hit.table;
        if (t.diagramUnid === diagramUnid) {delete t.diagramUnid;}
        if (t.diagramPlacements) {
            t.diagramPlacements = t.diagramPlacements.filter(p => p.diagramUnid !== diagramUnid);
            if (t.diagramPlacements.length === 0) {delete t.diagramPlacements;}
        }
        return this._commit('table.placement.remove', {tableUnid: tableUnid, diagramUnid: diagramUnid}, clientId);
    }

    public deleteTable(unid: string, clientId: string | null): number {
        const hit = DbFsTreeWalker.findTable(this._data.fs, unid);
        if (!hit) {throw new RepoNotFoundError(`table ${unid} not found`);}
        hit.container.tables = hit.container.tables.filter(t => t.unid !== unid);
        // also strip FKs in other tables that pointed here
        for (const { table } of DbFsTreeWalker.allTables(this._data.fs)) {
            table.foreignKeys = table.foreignKeys.filter(fk => fk.refTableUnid !== unid);
        }
        return this._commit('table.delete', { unid: unid }, clientId);
    }

    /**
     * Deep-clone a table within its container, with fresh unids on the
     * table + every column / index / FK, and a name derived from the
     * source (`<name>_copy`, `_copy_2`, …) so it doesn't collide with
     * siblings. Local references inside the clone (index → column,
     * FK.columns[].columnUnid → column) are remapped to the new unids.
     * Cross-table references (FK.refTableUnid, FK.columns[].refColumnUnid)
     * stay pointing at the originals — we're cloning ONE table, not the
     * graph around it.
     *
     * Position offsets by (40, 40) so the clone is visible but obviously
     * stacked on top.
     */
    public duplicateTable(unid: string, clientId: string | null): { rev: number; table: JsonTable; } {
        const hit = DbFsTreeWalker.findTable(this._data.fs, unid);
        if (!hit) {throw new RepoNotFoundError(`table ${unid} not found`);}
        const src = hit.table;

        const existingNames = new Set(hit.container.tables.map(t => t.name));
        const baseName = `${src.name}_copy`;
        let suffix = 2;
        let name = baseName;
        while (existingNames.has(name)) {
            name = `${baseName}_${suffix}`;
            suffix += 1;
        }

        const columnIdMap = new Map<string, string>();
        const newColumns: JsonColumn[] = src.columns.map(c => {
            const u = randomUUID();
            columnIdMap.set(c.unid, u);
            return { ...c, unid: u };
        });
        const newIndexes: JsonIndex[] = src.indexes.map(ix => ({
            ...ix,
            unid: randomUUID(),
            columns: ix.columns.map(ic => ({
                ...ic,
                columnUnid: columnIdMap.get(ic.columnUnid) ?? ic.columnUnid
            }))
        }));
        const newForeignKeys: JsonForeignKey[] = src.foreignKeys.map(fk => ({
            ...fk,
            unid: randomUUID(),
            columns: fk.columns.map(fc => ({
                ...fc,
                /* Local-side gets the remapped clone column; remote stays. */
                columnUnid: columnIdMap.get(fc.columnUnid) ?? fc.columnUnid
            }))
        }));

        const cloned: JsonTable = {
            unid: randomUUID(),
            name: name,
            pos: { x: src.pos.x + 40, y: src.pos.y + 40 },
            columns: newColumns,
            indexes: newIndexes,
            foreignKeys: newForeignKeys,
            options: src.options ? { ...src.options } : undefined,
            description: src.description
        };
        hit.container.tables.push(cloned);
        const rev = this._commit('table.duplicate', { sourceUnid: unid, table: cloned }, clientId);
        return { rev: rev, table: cloned };
    }

    /*
     * ---------------------------------------------------------------------
     * Column ops
     * ---------------------------------------------------------------------
     */

    public addColumn(tableUnid: string, column: Omit<JsonColumn, 'unid'>, clientId: string | null): { rev: number; column: JsonColumn; } {
        const hit = DbFsTreeWalker.findTable(this._data.fs, tableUnid);
        if (!hit) {throw new RepoNotFoundError(`table ${tableUnid} not found`);}
        const created: JsonColumn = { unid: randomUUID(), ...column };
        hit.table.columns.push(created);
        const rev = this._commit('column.add', { tableUnid: tableUnid, column: created }, clientId);
        return { rev: rev, column: created };
    }

    public updateColumn(tableUnid: string, columnUnid: string, patch: Partial<Omit<JsonColumn, 'unid'>>, clientId: string | null): number {
        const hit = DbFsTreeWalker.findTable(this._data.fs, tableUnid);
        if (!hit) {throw new RepoNotFoundError(`table ${tableUnid} not found`);}
        const col = hit.table.columns.find(c => c.unid === columnUnid);
        if (!col) {throw new RepoNotFoundError(`column ${columnUnid} not found`);}
        Object.assign(col, patch);
        return this._commit('column.update', { tableUnid: tableUnid, columnUnid: columnUnid, patch: patch }, clientId);
    }

    public removeColumn(tableUnid: string, columnUnid: string, clientId: string | null): number {
        const hit = DbFsTreeWalker.findTable(this._data.fs, tableUnid);
        if (!hit) {throw new RepoNotFoundError(`table ${tableUnid} not found`);}
        hit.table.columns = hit.table.columns.filter(c => c.unid !== columnUnid);
        // strip from indexes
        hit.table.indexes = hit.table.indexes.map(ix => ({
            ...ix,
            columns: ix.columns.filter(ic => ic.columnUnid !== columnUnid)
        })).filter(ix => ix.columns.length > 0);
        // strip from local FKs
        hit.table.foreignKeys = hit.table.foreignKeys.map(fk => ({
            ...fk,
            columns: fk.columns.filter(fc => fc.columnUnid !== columnUnid)
        })).filter(fk => fk.columns.length > 0);
        // strip from other tables' FKs that reference this column
        for (const { table } of DbFsTreeWalker.allTables(this._data.fs)) {
            table.foreignKeys = table.foreignKeys.map(fk => ({
                ...fk,
                columns: fk.columns.filter(fc => fc.refColumnUnid !== columnUnid)
            })).filter(fk => fk.columns.length > 0);
        }
        return this._commit('column.remove', { tableUnid: tableUnid, columnUnid: columnUnid }, clientId);
    }

    public reorderColumns(tableUnid: string, orderedUnids: string[], clientId: string | null): number {
        const hit = DbFsTreeWalker.findTable(this._data.fs, tableUnid);
        if (!hit) {throw new RepoNotFoundError(`table ${tableUnid} not found`);}
        const map = new Map(hit.table.columns.map(c => [c.unid, c]));
        const next: JsonColumn[] = [];
        for (const unid of orderedUnids) {
            const c = map.get(unid);
            if (c) { next.push(c); map.delete(unid); }
        }
        for (const c of map.values()) {next.push(c);}
        hit.table.columns = next;
        return this._commit('column.reorder', { tableUnid: tableUnid, order: orderedUnids }, clientId);
    }

    /*
     * ---------------------------------------------------------------------
     * Index ops
     * ---------------------------------------------------------------------
     */

    public addIndex(tableUnid: string, index: Omit<JsonIndex, 'unid'>, clientId: string | null): { rev: number; index: JsonIndex; } {
        const hit = DbFsTreeWalker.findTable(this._data.fs, tableUnid);
        if (!hit) {throw new RepoNotFoundError(`table ${tableUnid} not found`);}
        const created: JsonIndex = { unid: randomUUID(), ...index };
        hit.table.indexes.push(created);
        const rev = this._commit('index.add', { tableUnid: tableUnid, index: created }, clientId);
        return { rev: rev, index: created };
    }

    public updateIndex(tableUnid: string, indexUnid: string, patch: Partial<Omit<JsonIndex, 'unid'>>, clientId: string | null): number {
        const hit = DbFsTreeWalker.findTable(this._data.fs, tableUnid);
        if (!hit) {throw new RepoNotFoundError(`table ${tableUnid} not found`);}
        const ix = hit.table.indexes.find(i => i.unid === indexUnid);
        if (!ix) {throw new RepoNotFoundError(`index ${indexUnid} not found`);}
        Object.assign(ix, patch);
        return this._commit('index.update', { tableUnid: tableUnid, indexUnid: indexUnid, patch: patch }, clientId);
    }

    public removeIndex(tableUnid: string, indexUnid: string, clientId: string | null): number {
        const hit = DbFsTreeWalker.findTable(this._data.fs, tableUnid);
        if (!hit) {throw new RepoNotFoundError(`table ${tableUnid} not found`);}
        hit.table.indexes = hit.table.indexes.filter(i => i.unid !== indexUnid);
        return this._commit('index.remove', { tableUnid: tableUnid, indexUnid: indexUnid }, clientId);
    }

    /*
     * ---------------------------------------------------------------------
     * Foreign key ops
     * ---------------------------------------------------------------------
     */

    public addForeignKey(tableUnid: string, fk: Omit<JsonForeignKey, 'unid'>, clientId: string | null): { rev: number; fk: JsonForeignKey; } {
        const hit = DbFsTreeWalker.findTable(this._data.fs, tableUnid);
        if (!hit) {throw new RepoNotFoundError(`table ${tableUnid} not found`);}
        const refHit = DbFsTreeWalker.findTable(this._data.fs, fk.refTableUnid);
        if (!refHit) {throw new RepoInvalidError(`referenced table ${fk.refTableUnid} not found`);}
        const created: JsonForeignKey = { unid: randomUUID(), ...fk };
        hit.table.foreignKeys.push(created);
        const rev = this._commit('fk.add', { tableUnid: tableUnid, fk: created }, clientId);
        return { rev: rev, fk: created };
    }

    public updateForeignKey(tableUnid: string, fkUnid: string, patch: Partial<Omit<JsonForeignKey, 'unid'>>, clientId: string | null): number {
        const hit = DbFsTreeWalker.findTable(this._data.fs, tableUnid);
        if (!hit) {throw new RepoNotFoundError(`table ${tableUnid} not found`);}
        const fk = hit.table.foreignKeys.find(f => f.unid === fkUnid);
        if (!fk) {throw new RepoNotFoundError(`fk ${fkUnid} not found`);}
        Object.assign(fk, patch);
        return this._commit('fk.update', { tableUnid: tableUnid, fkUnid: fkUnid, patch: patch }, clientId);
    }

    public removeForeignKey(tableUnid: string, fkUnid: string, clientId: string | null): number {
        const hit = DbFsTreeWalker.findTable(this._data.fs, tableUnid);
        if (!hit) {throw new RepoNotFoundError(`table ${tableUnid} not found`);}
        hit.table.foreignKeys = hit.table.foreignKeys.filter(f => f.unid !== fkUnid);
        return this._commit('fk.remove', { tableUnid: tableUnid, fkUnid: fkUnid }, clientId);
    }

    /*
     * ---------------------------------------------------------------------
     * Enum ops
     * ---------------------------------------------------------------------
     */

    public createEnum(containerUnid: string, name: string, pos: JsonPosition | null, clientId: string | null): { rev: number; enumNode: JsonEnum; } {
        const container = DbFsTreeWalker.findContainer(this._data.fs, containerUnid);
        if (!container) {throw new RepoNotFoundError(`container ${containerUnid} not found`);}
        const enumNode: JsonEnum = {
            unid: randomUUID(),
            name: name,
            pos: pos || defaultPos(),
            values: [],
            description: ''
        };
        container.enums.push(enumNode);
        const rev = this._commit('enum.create', { containerUnid: containerUnid, enum: enumNode }, clientId);
        return { rev: rev, enumNode: enumNode };
    }

    public updateEnum(unid: string, patch: Partial<Pick<JsonEnum, 'name' | 'pos' | 'description'>>, clientId: string | null): number {
        const hit = DbFsTreeWalker.findEnum(this._data.fs, unid);
        if (!hit) {throw new RepoNotFoundError(`enum ${unid} not found`);}
        if (patch.name !== undefined) {hit.enum.name = patch.name;}
        if (patch.pos !== undefined) {hit.enum.pos = patch.pos;}
        if (patch.description !== undefined) {hit.enum.description = patch.description;}
        return this._commit('enum.update', { unid: unid, patch: patch }, clientId);
    }

    public deleteEnum(unid: string, clientId: string | null): number {
        const hit = DbFsTreeWalker.findEnum(this._data.fs, unid);
        if (!hit) {throw new RepoNotFoundError(`enum ${unid} not found`);}
        hit.container.enums = hit.container.enums.filter(e => e.unid !== unid);
        return this._commit('enum.delete', { unid: unid }, clientId);
    }

    public addEnumValue(enumUnid: string, value: string, clientId: string | null): { rev: number; value: JsonEnumValue; } {
        const hit = DbFsTreeWalker.findEnum(this._data.fs, enumUnid);
        if (!hit) {throw new RepoNotFoundError(`enum ${enumUnid} not found`);}
        const v: JsonEnumValue = { unid: randomUUID(), value: value };
        hit.enum.values.push(v);
        const rev = this._commit('enum.value.add', { enumUnid: enumUnid, value: v }, clientId);
        return { rev: rev, value: v };
    }

    public updateEnumValue(enumUnid: string, valueUnid: string, value: string, clientId: string | null): number {
        const hit = DbFsTreeWalker.findEnum(this._data.fs, enumUnid);
        if (!hit) {throw new RepoNotFoundError(`enum ${enumUnid} not found`);}
        const v = hit.enum.values.find(x => x.unid === valueUnid);
        if (!v) {throw new RepoNotFoundError(`enum value ${valueUnid} not found`);}
        v.value = value;
        return this._commit('enum.value.update', { enumUnid: enumUnid, valueUnid: valueUnid, value: value }, clientId);
    }

    public removeEnumValue(enumUnid: string, valueUnid: string, clientId: string | null): number {
        const hit = DbFsTreeWalker.findEnum(this._data.fs, enumUnid);
        if (!hit) {throw new RepoNotFoundError(`enum ${enumUnid} not found`);}
        hit.enum.values = hit.enum.values.filter(x => x.unid !== valueUnid);
        return this._commit('enum.value.remove', { enumUnid: enumUnid, valueUnid: valueUnid }, clientId);
    }

    /*
     * ---------------------------------------------------------------------
     * View ops
     * ---------------------------------------------------------------------
     */

    public createView(containerUnid: string, name: string, pos: JsonPosition | null, clientId: string | null): { rev: number; view: JsonView; } {
        const container = DbFsTreeWalker.findContainer(this._data.fs, containerUnid);
        if (!container) {throw new RepoNotFoundError(`container ${containerUnid} not found`);}
        const view: JsonView = {
            unid: randomUUID(),
            name: name,
            pos: pos || defaultPos(),
            select: '',
            description: ''
        };
        container.views.push(view);
        const rev = this._commit('view.create', { containerUnid: containerUnid, view: view }, clientId);
        return { rev: rev, view: view };
    }

    public updateView(unid: string, patch: Partial<Pick<JsonView, 'name' | 'pos' | 'select' | 'materialized' | 'description' | 'diagramUnid' | 'diagramPlacements'>>, clientId: string | null): number {
        this._mwbOriginalViewXml.delete(unid);
        const hit = DbFsTreeWalker.findView(this._data.fs, unid);
        if (!hit) {throw new RepoNotFoundError(`view ${unid} not found`);}
        if (patch.name !== undefined) {hit.view.name = patch.name;}
        if (patch.pos !== undefined) {hit.view.pos = patch.pos;}
        if (patch.select !== undefined) {hit.view.select = patch.select;}
        if (patch.materialized !== undefined) {hit.view.materialized = patch.materialized;}
        if (patch.description !== undefined) {hit.view.description = patch.description;}
        if (patch.diagramUnid !== undefined) {
            /* Empty string is the "clear assignment" sentinel — matches updateTable's diagramUnid handling. */
            if (patch.diagramUnid === '') {delete hit.view.diagramUnid;}
            else {hit.view.diagramUnid = patch.diagramUnid;}
        }
        if (patch.diagramPlacements !== undefined) {
            if (patch.diagramPlacements.length === 0) {delete hit.view.diagramPlacements;}
            else {hit.view.diagramPlacements = patch.diagramPlacements;}
        }
        return this._commit('view.update', { unid: unid, patch: patch }, clientId);
    }

    public deleteView(unid: string, clientId: string | null): number {
        this._mwbOriginalViewXml.delete(unid);
        const hit = DbFsTreeWalker.findView(this._data.fs, unid);
        if (!hit) {throw new RepoNotFoundError(`view ${unid} not found`);}
        hit.container.views = hit.container.views.filter(v => v.unid !== unid);
        return this._commit('view.delete', { unid: unid }, clientId);
    }

    /*
     * ---------------------------------------------------------------------
     * Diagram ops — Workbench-style "EER tab", a pure logical
     * container that groups a subset of the database's tables/views
     * under a named scope. No visual rectangle: scoping the canvas
     * to a diagram just filters which cards render.
     *
     * Producers: `.mwb` import (one JsonDiagram per Workbench diagram
     * or authored Layer) and the in-app "Add EER diagram" action.
     * ---------------------------------------------------------------------
     */

    public createDiagram(
        containerUnid: string,
        name: string,
        clientId: string | null
    ): { rev: number; diagram: JsonDiagram; } {
        const container = DbFsTreeWalker.findContainer(this._data.fs, containerUnid);
        if (!container) {throw new RepoNotFoundError(`container ${containerUnid} not found`);}
        const trimmed = name.trim();
        if (!trimmed) {throw new RepoInvalidError('diagram name must not be empty');}
        const diagram: JsonDiagram = {
            unid: randomUUID(),
            name: trimmed
        };
        container.diagrams = [...container.diagrams ?? [], diagram];
        const rev = this._commit('diagram.create', { containerUnid: containerUnid, diagram: diagram }, clientId);
        return { rev: rev, diagram: diagram };
    }

    public updateDiagram(
        unid: string,
        patch: Partial<Pick<JsonDiagram, 'name' | 'description'>>,
        clientId: string | null
    ): number {
        const hit = DbFsTreeWalker.findDiagram(this._data.fs, unid);
        if (!hit) {throw new RepoNotFoundError(`diagram ${unid} not found`);}
        if (patch.name !== undefined) {hit.diagram.name = patch.name;}
        if (patch.description !== undefined) {hit.diagram.description = patch.description;}
        return this._commit('diagram.update', { unid: unid, patch: patch }, clientId);
    }

    /**
     * Remove a diagram. Tables that referenced it via `diagramUnid` keep
     * their reference (now dangling); the validator surfaces this if
     * the user wants to clean up. We don't auto-clear `diagramUnid` on
     * tables because the user might just be re-creating the diagram.
     */
    public deleteDiagram(unid: string, clientId: string | null): number {
        const hit = DbFsTreeWalker.findDiagram(this._data.fs, unid);
        if (!hit) {throw new RepoNotFoundError(`diagram ${unid} not found`);}
        hit.container.diagrams = (hit.container.diagrams ?? []).filter(l => l.unid !== unid);
        /*
         * Cascade: layers belong to a diagram and have no meaning
         * without one. Removing the parent removes its layer set.
         * Persisted under the same commit so undo restores both.
         */
        hit.container.layers = (hit.container.layers ?? []).filter(l => l.diagramUnid !== unid);
        return this._commit('diagram.delete', { unid: unid }, clientId);
    }

    /*
     * ---------------------------------------------------------------------
     * Layer ops — Workbench "Group" rectangle within a diagram
     *
     * A `JsonLayer` is a visual grouping rectangle the user draws on
     * the canvas while scoped to its parent diagram. Membership is
     * implicit (cards "in" the layer are the ones whose pos falls
     * inside the bbox). The parent diagram must exist when a layer
     * is created; deleting a diagram cascades to its layers above.
     * ---------------------------------------------------------------------
     */

    public createLayer(
        containerUnid: string,
        diagramUnid: string,
        name: string,
        pos: JsonPosition | null,
        width: number | null,
        height: number | null,
        color: string | null,
        clientId: string | null
    ): { rev: number; layer: JsonLayer; } {
        const container = DbFsTreeWalker.findContainer(this._data.fs, containerUnid);
        if (!container) {throw new RepoNotFoundError(`container ${containerUnid} not found`);}
        const diagram = DbFsTreeWalker.findDiagram(this._data.fs, diagramUnid);
        if (!diagram) {throw new RepoNotFoundError(`diagram ${diagramUnid} not found`);}
        const trimmed = name.trim();
        if (!trimmed) {throw new RepoInvalidError('layer name must not be empty');}
        const layer: JsonLayer = {
            unid: randomUUID(),
            name: trimmed,
            diagramUnid: diagramUnid,
            pos: pos || {x: 80, y: 80},
            width: width && width > 0 ? width : 400,
            height: height && height > 0 ? height : 300
        };
        if (color) {layer.color = color;}
        container.layers = [...container.layers ?? [], layer];
        const rev = this._commit('layer.create', { containerUnid: containerUnid, layer: layer }, clientId);
        return { rev: rev, layer: layer };
    }

    public updateLayer(
        unid: string,
        patch: Partial<Pick<JsonLayer, 'name' | 'pos' | 'width' | 'height' | 'color' | 'description'>>,
        clientId: string | null
    ): number {
        const hit = DbFsTreeWalker.findLayer(this._data.fs, unid);
        if (!hit) {throw new RepoNotFoundError(`layer ${unid} not found`);}
        if (patch.name !== undefined) {hit.layer.name = patch.name;}
        if (patch.pos !== undefined) {hit.layer.pos = patch.pos;}
        if (patch.width !== undefined) {hit.layer.width = patch.width;}
        if (patch.height !== undefined) {hit.layer.height = patch.height;}
        if (patch.color !== undefined) {hit.layer.color = patch.color;}
        if (patch.description !== undefined) {hit.layer.description = patch.description;}
        return this._commit('layer.update', { unid: unid, patch: patch }, clientId);
    }

    public deleteLayer(unid: string, clientId: string | null): number {
        const hit = DbFsTreeWalker.findLayer(this._data.fs, unid);
        if (!hit) {throw new RepoNotFoundError(`layer ${unid} not found`);}
        hit.container.layers = (hit.container.layers ?? []).filter(l => l.unid !== unid);
        return this._commit('layer.delete', { unid: unid }, clientId);
    }

    /*
     * ---------------------------------------------------------------------
     * Routine ops (stored procedures / functions / triggers)
     *
     * Stored as opaque-body objects: name + kind + raw SQL. We don't
     * parse parameters or return types — the generator emits the body
     * verbatim, the user owns the SQL.
     * ---------------------------------------------------------------------
     */

    public createRoutine(containerUnid: string, name: string, kind: string, pos: JsonPosition | null, clientId: string | null): { rev: number; routine: JsonRoutine; } {
        const container = DbFsTreeWalker.findContainer(this._data.fs, containerUnid);
        if (!container) {throw new RepoNotFoundError(`container ${containerUnid} not found`);}
        if (!container.routines) {container.routines = [];}
        const routine: JsonRoutine = {
            unid: randomUUID(),
            name: name,
            pos: pos || defaultPos(),
            kind: kind || JsonRoutineKind.procedure,
            body: '',
            description: ''
        };
        container.routines.push(routine);
        const rev = this._commit('routine.create', { containerUnid: containerUnid, routine: routine }, clientId);
        return { rev: rev, routine: routine };
    }

    public updateRoutine(unid: string, patch: Partial<Pick<JsonRoutine, 'name' | 'pos' | 'kind' | 'body' | 'description'>>, clientId: string | null): number {
        this._mwbOriginalRoutineXml.delete(unid);
        const hit = DbFsTreeWalker.findRoutine(this._data.fs, unid);
        if (!hit) {throw new RepoNotFoundError(`routine ${unid} not found`);}
        if (patch.name !== undefined) {hit.routine.name = patch.name;}
        if (patch.pos !== undefined) {hit.routine.pos = patch.pos;}
        if (patch.kind !== undefined) {hit.routine.kind = patch.kind;}
        if (patch.body !== undefined) {hit.routine.body = patch.body;}
        if (patch.description !== undefined) {hit.routine.description = patch.description;}
        return this._commit('routine.update', { unid: unid, patch: patch }, clientId);
    }

    public deleteRoutine(unid: string, clientId: string | null): number {
        this._mwbOriginalRoutineXml.delete(unid);
        const hit = DbFsTreeWalker.findRoutine(this._data.fs, unid);
        if (!hit) {throw new RepoNotFoundError(`routine ${unid} not found`);}
        hit.container.routines = (hit.container.routines ?? []).filter(r => r.unid !== unid);
        return this._commit('routine.delete', { unid: unid }, clientId);
    }

    /*
     * ---------------------------------------------------------------------
     * Editor settings
     * ---------------------------------------------------------------------
     */

    public updateEditorSettings(patch: Partial<JsonEditorSettings>, clientId: string | null): number {
        this._data.editor = { ...this._data.editor, ...patch };
        return this._commit('editor.update', { patch: patch }, clientId);
    }

    /**
     * Whole-tree replace for the Import flow. `editor` and `sync` are
     * deliberately preserved — the user's layout preferences and ignore
     * patterns belong to the *project*, not the schema they imported.
     * Routed through `_commit` so the import shows up in the undo stack
     * just like any other mutation.
     */
    public replaceFs(newFs: JsonDataDB, clientId: string | null): number {
        /* Whole tree changed — every per-object cache is now stale. */
        this._mwbOriginalRoutineXml.clear();
        this._mwbOriginalViewXml.clear();
        this._mwbOriginalTableXml.clear();
        this._data = { ...this._data, fs: structuredClone(newFs) };
        return this._commit('fs.replaced', { kind: 'import' }, clientId);
    }

    /**
     * Append imported databases as new top-level entries on the
     * existing fs root. Sibling to `replaceFs` for the import flows
     * that want to merge into the current schema instead of clobbering
     * it. Each database keeps its own unid (callers hand in tree
     * fragments with fresh `randomUUID()`s); name collisions are not
     * deduped — the user can rename in the treeview if it matters.
     *
     * Routes through `_commit` so one undo step reverts the entire
     * import. Publishes `fs.replaced` (same op as full replace) so
     * existing SSE consumers refresh their tree without a new wire
     * message.
     */
    public appendDatabases(databases: JsonDataDB[], clientId: string | null): number {
        if (databases.length === 0) {return this._rev;}
        const cloned = databases.map(d => structuredClone(d));
        const nextFs = structuredClone(this._data.fs);
        (nextFs.entrys as unknown[]).push(...cloned);
        this._data = { ...this._data, fs: nextFs };
        return this._commit('fs.replaced', { kind: 'import-append', count: cloned.length }, clientId);
    }

    /*
     * ---------------------------------------------------------------------
     * Sync settings — UI overrides for `project.sync` defaults
     *
     * `project.sync` from `dbeditor.json` provides the defaults. When the
     * user edits ignore patterns in the SyncDialog we persist the result
     * to `data.sync`, which then overrides the defaults whenever
     * `effectiveSync()` is queried (preview / apply / reverse-apply all
     * route through it). A `null`-valued field in the patch resets that
     * field back to the default; an empty array means "ignore nothing".
     * ---------------------------------------------------------------------
     */

    public updateSyncSettings(patch: Partial<JsonSyncSettings>, clientId: string | null): number {
        const current = this._data.sync ?? {};
        this._data.sync = { ...current, ...patch };
        return this._commit('sync.settings.update', { patch: patch }, clientId);
    }

    public effectiveSync(): DbProjectSync {
        const override = this._data.sync ?? {};
        return {
            ignoreTables: override.ignoreTables ?? this._project.sync.ignoreTables,
            ignoreColumnAttributes: override.ignoreColumnAttributes ?? this._project.sync.ignoreColumnAttributes
        };
    }

    /*
     * ---------------------------------------------------------------------
     * Output settings — UI overrides for `project.output` defaults
     *
     * `project.output` (from dbeditor.json) is the default; per-field
     * overrides in `data.output` win when present. The merged shape is
     * surfaced via `effectiveProject` — every call site that used to read
     * `repo.project.output.x` should switch to `repo.effectiveProject.output.x`.
     * The schemaPath, dialect, and other top-level project fields aren't
     * overridable: they affect file layout and SQL syntax and changing
     * them at runtime would leave artifacts.
     * ---------------------------------------------------------------------
     */

    public updateOutputSettings(patch: Partial<JsonOutputSettings>, clientId: string | null): number {
        const current = this._data.output ?? {};
        this._data.output = { ...current, ...patch };
        return this._commit('output.settings.update', { patch: patch }, clientId);
    }

    public effectiveOutput(): DbProject['output'] {
        const override = this._data.output ?? {};
        const base = this._project.output;
        return {
            mode: override.mode ?? base.mode,
            destinationPath: override.destinationPath ?? base.destinationPath,
            destinationClear: override.destinationClear ?? base.destinationClear,
            sqlComment: override.sqlComment ?? base.sqlComment,
            sqlIndent: override.sqlIndent ?? base.sqlIndent,
            statementTerminator: override.statementTerminator ?? base.statementTerminator,
            migrationFilenamePattern: override.migrationFilenamePattern ?? base.migrationFilenamePattern
        };
    }

    /**
     * `DbProject` with the effective `output` substituted in. Used by every
     * code path that needs to know the *current* output config (generator
     * dispatch, sync codegen ctx, file-path responses) — they go through
     * this getter so per-project UI overrides are honoured uniformly.
     */
    public get effectiveProject(): DbProject {
        return { ...this._project, output: this.effectiveOutput() };
    }

    /*
     * ---------------------------------------------------------------------
     * Sync — reverse-apply
     *
     * Per-change mutator that pulls the LIVE state into the model. For each
     * selected `SchemaChange` we apply the inverse of the forward intent:
     *   tableAdded     — model has, live doesn't  → drop from model
     *   tableDropped   — live has, model doesn't  → clone live → model
     *   columnChanged  — copy live attrs (`before`) into model column
     *   …etc for indexes, FKs, views, table options, enums
     *
     * New model objects get fresh `randomUUID()` unids — live's synthetic
     * `live:…` unids never leak in. Cross-table refs (FK refTableUnid,
     * refColumnUnid, index columnUnid) are resolved by name lookup against
     * the model tree post-mutation. Refs that don't resolve are dropped
     * silently — the next preview run will surface them as missing.
     *
     * All mutations are applied in-memory and emitted as a single
     * `sync.reverseApply` event with the list of applied change-IDs.
     * ---------------------------------------------------------------------
     */
    public applyReverseSync(
        databaseUnid: string,
        changes: SchemaChange[],
        liveDb: JsonDataDB,
        clientId: string | null
    ): { rev: number; appliedChangeIds: string[]; } {
        const modelDb = DbFsTreeWalker.findContainer(this._data.fs, databaseUnid);
        if (!modelDb || modelDb.type !== JsonDataDBType.database) {
            throw new RepoNotFoundError(`model database ${databaseUnid} not found`);
        }
        const applied: string[] = [];

        for (const change of changes) {
            const ok = this._applyOneReverse(modelDb, liveDb, change);
            if (ok) {applied.push(change.id);}
        }

        const rev = this._commit('sync.reverseApply', {
            databaseUnid: databaseUnid,
            appliedChangeIds: applied
        }, clientId);
        return { rev: rev, appliedChangeIds: applied };
    }

    private _applyOneReverse(modelDb: JsonDataDB, liveDb: JsonDataDB, change: SchemaChange): boolean {
        const modelTablesByName = new Map<string, JsonTable>();
        for (const { table } of DbFsTreeWalker.allTables(modelDb)) {modelTablesByName.set(table.name, table);}

        switch (change.kind) {
            case SchemaChangeKind.tableAdded: {
                /* model has, live doesn't → drop from model */
                if (!change.tableName) {return false;}
                const hit = modelTablesByName.get(change.tableName);
                if (!hit) {return false;}
                modelDb.tables = modelDb.tables.filter(t => t.unid !== hit.unid);
                /* Also strip from any folders */
                this._removeTableFromTree(modelDb, hit.unid);
                /* Strip FKs from other tables that referenced this one */
                for (const { table } of DbFsTreeWalker.allTables(this._data.fs)) {
                    table.foreignKeys = table.foreignKeys.filter(fk => fk.refTableUnid !== hit.unid);
                }
                return true;
            }
            case SchemaChangeKind.tableDropped: {
                /* live has, model doesn't → clone live → model */
                const liveTable = change.before as JsonTable | undefined;
                if (!liveTable) {return false;}
                const cloned = this._cloneLiveTableToModel(liveTable, liveDb, modelDb);
                modelDb.tables.push(cloned);
                return true;
            }
            case SchemaChangeKind.tableOptionsChanged: {
                if (!change.tableName) {return false;}
                const t = modelTablesByName.get(change.tableName);
                if (!t) {return false;}
                t.options = {...change.before as JsonTable['options'] | undefined ?? {}};
                return true;
            }
            case SchemaChangeKind.columnAdded: {
                if (!change.tableName || !change.columnName) {return false;}
                const t = modelTablesByName.get(change.tableName);
                if (!t) {return false;}
                const col = t.columns.find(c => c.name === change.columnName);
                if (!col) {return false;}
                t.columns = t.columns.filter(c => c.unid !== col.unid);
                /* Cascade — like removeColumn does */
                t.indexes = t.indexes.map(ix => ({
                    ...ix,
                    columns: ix.columns.filter(ic => ic.columnUnid !== col.unid)
                })).filter(ix => ix.columns.length > 0);
                t.foreignKeys = t.foreignKeys.map(fk => ({
                    ...fk,
                    columns: fk.columns.filter(fc => fc.columnUnid !== col.unid)
                })).filter(fk => fk.columns.length > 0);
                for (const { table } of DbFsTreeWalker.allTables(this._data.fs)) {
                    table.foreignKeys = table.foreignKeys.map(fk => ({
                        ...fk,
                        columns: fk.columns.filter(fc => fc.refColumnUnid !== col.unid)
                    })).filter(fk => fk.columns.length > 0);
                }
                return true;
            }
            case SchemaChangeKind.columnDropped: {
                if (!change.tableName) {return false;}
                const t = modelTablesByName.get(change.tableName);
                if (!t) {return false;}
                const liveCol = change.before as JsonColumn | undefined;
                if (!liveCol) {return false;}
                t.columns.push({...liveCol, unid: randomUUID()});
                return true;
            }
            case SchemaChangeKind.columnChanged: {
                if (!change.tableName || !change.columnName) {return false;}
                const t = modelTablesByName.get(change.tableName);
                if (!t) {return false;}
                const col = t.columns.find(c => c.name === change.columnName);
                if (!col) {return false;}
                const liveCol = change.before as JsonColumn | undefined;
                if (!liveCol) {return false;}
                /*
                 * Adopt every attribute from live, preserving the model's
                 * stable unid + name (the name match is the join condition,
                 * so it's identical on both sides by construction).
                 */
                const preservedUnid = col.unid;
                Object.assign(col, liveCol);
                col.unid = preservedUnid;
                col.name = change.columnName;
                return true;
            }
            case SchemaChangeKind.indexAdded: {
                if (!change.tableName || !change.indexName) {return false;}
                const t = modelTablesByName.get(change.tableName);
                if (!t) {return false;}
                t.indexes = t.indexes.filter(ix => ix.name !== change.indexName);
                return true;
            }
            case SchemaChangeKind.indexDropped: {
                if (!change.tableName) {return false;}
                const t = modelTablesByName.get(change.tableName);
                if (!t) {return false;}
                const liveIx = change.before as JsonIndex | undefined;
                if (!liveIx) {return false;}
                const cloned = this._cloneLiveIndexToModel(liveIx, liveDb, change.tableName, t);
                if (cloned) {t.indexes.push(cloned);}
                return Boolean(cloned);
            }
            case SchemaChangeKind.indexChanged: {
                if (!change.tableName || !change.indexName) {return false;}
                const t = modelTablesByName.get(change.tableName);
                if (!t) {return false;}
                const liveIx = change.before as JsonIndex | undefined;
                if (!liveIx) {return false;}
                const existing = t.indexes.find(ix => ix.name === change.indexName);
                const cloned = this._cloneLiveIndexToModel(liveIx, liveDb, change.tableName, t);
                if (!cloned) {return false;}
                if (existing) {
                    /* Preserve the existing unid so canvas + outliner state stays. */
                    cloned.unid = existing.unid;
                    t.indexes = t.indexes.map(ix => ix.unid === existing.unid ? cloned : ix);
                } else {
                    t.indexes.push(cloned);
                }
                return true;
            }
            case SchemaChangeKind.fkAdded: {
                if (!change.tableName || !change.fkName) {return false;}
                const t = modelTablesByName.get(change.tableName);
                if (!t) {return false;}
                t.foreignKeys = t.foreignKeys.filter(fk => fk.name !== change.fkName);
                return true;
            }
            case SchemaChangeKind.fkDropped: {
                if (!change.tableName) {return false;}
                const t = modelTablesByName.get(change.tableName);
                if (!t) {return false;}
                const liveFk = change.before as JsonForeignKey | undefined;
                if (!liveFk) {return false;}
                const cloned = this._cloneLiveFkToModel(liveFk, liveDb, t, modelTablesByName);
                if (cloned) {t.foreignKeys.push(cloned);}
                return Boolean(cloned);
            }
            case SchemaChangeKind.fkChanged: {
                if (!change.tableName || !change.fkName) {return false;}
                const t = modelTablesByName.get(change.tableName);
                if (!t) {return false;}
                const liveFk = change.before as JsonForeignKey | undefined;
                if (!liveFk) {return false;}
                const existing = t.foreignKeys.find(fk => fk.name === change.fkName);
                const cloned = this._cloneLiveFkToModel(liveFk, liveDb, t, modelTablesByName);
                if (!cloned) {return false;}
                if (existing) {
                    cloned.unid = existing.unid;
                    t.foreignKeys = t.foreignKeys.map(fk => fk.unid === existing.unid ? cloned : fk);
                } else {
                    t.foreignKeys.push(cloned);
                }
                return true;
            }
            case SchemaChangeKind.viewAdded: {
                if (!change.viewName) {return false;}
                modelDb.views = modelDb.views.filter(v => v.name !== change.viewName);
                this._removeViewFromTree(modelDb, change.viewName);
                return true;
            }
            case SchemaChangeKind.viewDropped: {
                const liveView = change.before as JsonView | undefined;
                if (!liveView) {return false;}
                modelDb.views.push({
                    ...liveView,
                    unid: randomUUID(),
                    pos: defaultPos()
                });
                return true;
            }
            case SchemaChangeKind.viewChanged: {
                if (!change.viewName) {return false;}
                const v = modelDb.views.find(x => x.name === change.viewName);
                if (!v) {return false;}
                const liveView = change.before as JsonView | undefined;
                if (!liveView) {return false;}
                const preserved = {unid: v.unid, pos: v.pos};
                Object.assign(v, liveView);
                v.unid = preserved.unid;
                v.pos = preserved.pos;
                return true;
            }
            case SchemaChangeKind.tableRenamed: {
                /*
                 * Reverse direction: adopt the live name into the model.
                 * The change carries `before.name = live name` and the
                 * model side currently has `change.tableName = new name`.
                 */
                if (!change.tableName) {return false;}
                const liveTable = change.before as JsonTable | undefined;
                if (!liveTable?.name) {return false;}
                const t = modelTablesByName.get(change.tableName);
                if (!t) {return false;}
                t.name = liveTable.name;
                return true;
            }
            case SchemaChangeKind.columnRenamed: {
                /* Symmetric: rename the model column back to the live name. */
                if (!change.tableName || !change.columnName) {return false;}
                const liveCol = change.before as JsonColumn | undefined;
                if (!liveCol?.name) {return false;}
                const t = modelTablesByName.get(change.tableName);
                if (!t) {return false;}
                const col = t.columns.find(c => c.name === change.columnName);
                if (!col) {return false;}
                col.name = liveCol.name;
                return true;
            }
            default:
                return false;
        }
    }

    private _removeTableFromTree(node: JsonDataDB, tableUnid: string): void {
        node.tables = node.tables.filter(t => t.unid !== tableUnid);
        for (const child of node.entrys as JsonDataDB[]) {
            this._removeTableFromTree(child, tableUnid);
        }
    }

    private _removeViewFromTree(node: JsonDataDB, viewName: string): void {
        node.views = node.views.filter(v => v.name !== viewName);
        for (const child of node.entrys as JsonDataDB[]) {
            this._removeViewFromTree(child, viewName);
        }
    }

    private _cloneLiveTableToModel(liveTable: JsonTable, liveDb: JsonDataDB, modelDb: JsonDataDB): JsonTable {
        const liveColUnidToModel = new Map<string, string>();
        const columns: JsonColumn[] = liveTable.columns.map(c => {
            const u = randomUUID();
            liveColUnidToModel.set(c.unid, u);
            return {...c, unid: u};
        });
        const indexes: JsonIndex[] = liveTable.indexes.map(ix => {
            const remappedCols = ix.columns
            .filter(ic => liveColUnidToModel.has(ic.columnUnid))
            .map(ic => ({...ic, columnUnid: liveColUnidToModel.get(ic.columnUnid)!}));
            return {
                ...ix,
                unid: randomUUID(),
                columns: remappedCols
            };
        }).filter(ix => ix.columns.length > 0);
        const modelTablesByName = new Map<string, JsonTable>();
        for (const { table } of DbFsTreeWalker.allTables(modelDb)) {modelTablesByName.set(table.name, table);}
        /*
         * For FKs, refTableUnid points to a `live:t:<db>:<name>` synthesised
         * unid. We resolve it to a model table by name; if the referenced
         * table doesn't exist in the model yet, drop the FK silently.
         */
        const foreignKeys: JsonForeignKey[] = [];
        for (const liveFk of liveTable.foreignKeys) {
            const tempTable: JsonTable = {...liveTable, columns: columns};
            const cloned = this._cloneLiveFkToModel(liveFk, liveDb, tempTable, modelTablesByName);
            if (cloned) {foreignKeys.push(cloned);}
        }
        return {
            unid: randomUUID(),
            name: liveTable.name,
            pos: defaultPos(),
            columns: columns,
            indexes: indexes,
            foreignKeys: foreignKeys,
            options: liveTable.options ? {...liveTable.options} : undefined
        };
    }

    private _cloneLiveIndexToModel(
        liveIx: JsonIndex,
        _liveDb: JsonDataDB,
        _modelTableName: string,
        modelTable: JsonTable
    ): JsonIndex | null {
        /*
         * To resolve live's `columnUnid` (e.g. `live:c:<db>:<table>:<col>`)
         * to the model table's column unid, we extract the column name from
         * the live unid format. If the format doesn't match we conservatively
         * drop the index column.
         */
        const cols = liveIx.columns.map(ic => {
            const parts = ic.columnUnid.split(':');
            const colName = parts[parts.length - 1];
            const modelCol = modelTable.columns.find(c => c.name === colName);
            if (!modelCol) {return null;}
            return {...ic, columnUnid: modelCol.unid};
        }).filter((x): x is NonNullable<typeof x> => x !== null);
        if (!cols.length) {return null;}
        return {
            ...liveIx,
            unid: randomUUID(),
            columns: cols
        };
    }

    private _cloneLiveFkToModel(
        liveFk: JsonForeignKey,
        _liveDb: JsonDataDB,
        modelTable: JsonTable,
        modelTablesByName: Map<string, JsonTable>
    ): JsonForeignKey | null {
        /*
         * Resolve refTableUnid (`live:t:<db>:<name>`) to the corresponding
         * model table by its name. Fail (return null) if the model side
         * doesn't have the referenced table yet — caller decides whether
         * to drop the FK or queue it for a second pass.
         */
        const refParts = liveFk.refTableUnid.split(':');
        const refTableName = refParts[refParts.length - 1];
        const refTable = modelTablesByName.get(refTableName);
        if (!refTable) {return null;}

        const remappedCols: JsonForeignKey['columns'] = [];
        for (const fc of liveFk.columns) {
            const localParts = fc.columnUnid.split(':');
            const localName = localParts[localParts.length - 1];
            const localCol = modelTable.columns.find(c => c.name === localName);
            if (!localCol) {return null;}

            const refParts2 = fc.refColumnUnid.split(':');
            const refColName = refParts2[refParts2.length - 1];
            const refCol = refTable.columns.find(c => c.name === refColName);
            if (!refCol) {return null;}

            remappedCols.push({columnUnid: localCol.unid, refColumnUnid: refCol.unid});
        }
        return {
            ...liveFk,
            unid: randomUUID(),
            refTableUnid: refTable.unid,
            columns: remappedCols
        };
    }

}