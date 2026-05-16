import {DbApiClient, ProjectInfo} from './Api/DbApiClient.js';
import {DbSseClient, DbSseEvent} from './Api/DbSseClient.js';
import {DbLiveSseClient} from './Api/DbLiveSseClient.js';
import {Treeview, TreeviewMode} from './Treeview/Treeview.js';
import {SyncDialog} from './Sync/SyncDialog.js';
import {DbTable} from './Table/DbTable.js';
import {DbView} from './View/DbView.js';
import {DbForeignKeyDialog} from './Table/DbForeignKeyDialog.js';
import {DbTableOptionsDialog} from './Table/DbTableOptionsDialog.js';
import {DbBatchTableOptionsDialog} from './Table/DbBatchTableOptionsDialog.js';
import {DbBulkRenameDialog} from './Table/DbBulkRenameDialog.js';
import {LayerPickerDialog} from './Layer/LayerPickerDialog.js';
import {LayerMembershipDialog} from './Layer/LayerMembershipDialog.js';
import {LayerColorDialog, extractHex} from './Layer/LayerColorDialog.js';
import {DbEnumDialog} from './Enum/DbEnumDialog.js';
import {DbViewDialog} from './View/DbViewDialog.js';
import {WarningsPanel} from './Validation/WarningsPanel.js';
import {validateSchema} from './Validation/SchemaValidator.js';
import {AutoSaveIndicator} from './AutoSaveIndicator.js';
import {AlertDialog} from './Base/AlertDialog.js';
import {InputDialog} from './Base/InputDialog.js';
import {ChoiceDialog} from './Base/ChoiceDialog.js';
import {ConfirmDialog} from './Base/ConfirmDialog.js';
import {SqlPreviewDialog} from './Base/SqlPreviewDialog.js';
import {ProjectSettingsDialog} from './Settings/ProjectSettingsDialog.js';
import {ProjectInfoDialog} from './Settings/ProjectInfoDialog.js';
import {AddProjectDialog} from './Settings/AddProjectDialog.js';
import {EditProjectDialog} from './Settings/EditProjectDialog.js';
import {AddConnectionDialog, AddConnectionDatabaseChoice} from './Settings/AddConnectionDialog.js';
import {EditConnectionDialog} from './Settings/EditConnectionDialog.js';
import {RebindConnectionDialog} from './Settings/RebindConnectionDialog.js';
import {DatabasePropertiesDialog} from './Database/DatabasePropertiesDialog.js';
import {iconEllipsis} from './Util/Icons.js';
import {DbRoutineDialog} from './Routine/DbRoutineDialog.js';
import {SearchPalette} from './Search/SearchPalette.js';
import {buildSearchIndex} from './Util/SearchIndex.js';
import {ShortcutHelpDialog} from './Help/ShortcutHelpDialog.js';
import {EditorEvents} from './Base/EditorEvents.js';
import {openContextMenu, ContextMenuItem} from './Base/ContextMenu.js';
import {getJsPlumbInstance} from './jsPlumbInstance.js';
import {crowsFoot, oneBar} from './Util/CrowsFoot.js';
import {isOneToOneFk} from './Util/FkCardinality.js';
import {ZOOM_DEFAULT, clampZoom, formatZoom, isAtDefault, snapToStep, stepZoom, zoomFocalScroll} from './Util/Zoom.js';
import {rectFromCorners, rectsIntersect} from './Util/Rect.js';
import {JsonColumn, JsonDataDB, JsonDataDBType, JsonEnum, JsonForeignKey, JsonLayer, JsonRoutine, JsonTable, JsonView} from './JsonData.js';

type LoadedProject = {
    unid: string;
    name: string;
    dialect: string;
    outputMode: string;
    autoGenerate: boolean;
    rev: number;
    data: JsonDataDB;
    editor: { active_entry_unid?: string; zoom?: number; };
    connectableDatabaseUnids?: string[];
    canUndo?: boolean;
    canRedo?: boolean;
};

/**
 * Top-level controller. Loads /api/load-schema, builds the treeview,
 * subscribes to SSE for the first project, listens to EditorEvents
 * dispatched by child components, and routes them to API mutations.
 *
 * Reconciliation on incoming SSE events is done by re-fetching
 * /api/load-schema and re-rendering. A patch-based reducer would be
 * cheaper but less obviously correct for the first iteration.
 */
export class DbEditor {

    private _api = new DbApiClient();
    private _sse: DbSseClient | null = null;
    private _liveSse: DbLiveSseClient | null = null;
    /** Latest introspected live tree per database unid. Empty until `Refresh from DB` runs. */
    private _liveByDatabaseUnid = new Map<string, JsonDataDB>();
    private _treeviewMode: TreeviewMode = 'model';
    private _treeview: Treeview | null = null;
    private _warnings: WarningsPanel | null = null;
    private _saveIndicator: AutoSaveIndicator | null = null;
    private _projects: LoadedProject[] = [];
    private _activeProject: LoadedProject | null = null;
    private _activeContainerUnid: string | null = null;
    /**
     * When set, the canvas filters tables to those whose `layerUnid`
     * matches — entered via clicking a layer in the treeview. Cleared
     * on container activation (back to "show all in this database").
     */
    private _activeLayerUnid: string | null = null;
    /*
     * Multi-select. The Set holds every currently-selected table's unid.
     * Single-select is just the special case `size === 1`. Mutators go
     * through `_setSelection` so the DOM class state stays in sync.
     */
    private _selectedTableUnids = new Set<string>();
    private _tables = new Map<string, DbTable>();
    private _views = new Map<string, DbView>();
    private _grid: HTMLElement | null = null;
    private _zoomLayer: HTMLElement | null = null;
    private _zoomLevel = 1;
    private _zoomLabel: HTMLButtonElement | null = null;
    private _jsPlumbBound = false;
    /*
     * Track every FK connection we've drawn so we can re-anchor only the
     * ones touching a moved table on drag-stop. Cleared in _renderCanvas
     * by `deleteEveryConnection` semantics — we mirror that here.
     */
    private _fkConnections: { srcTableUnid: string; dstTableUnid: string; fkUnid: string; conn: any; }[] = [];
    /*
     * Logical N:N lines drawn between the two outer tables of a junction
     * table. Tracked separately so we can re-render them on drag-stop.
     */
    private _junctionConnections: { outerAUnid: string; outerBUnid: string; junctionUnid: string; conn: any; }[] = [];
    /*
     * Persisted user preference: hide derived N:N lines when the user
     * finds them noisy. Read once at startup, written on every toggle.
     */
    private _showJunctionLines: boolean = localStorage.getItem('dbeditor.showNN') !== '0';

    public async init(): Promise<void> {
        this._grid = document.getElementById('dbgrid');
        this._zoomLayer = document.getElementById('dbgrid-zoom');
        const treeEl = document.getElementById('treeview');
        if (!this._grid || !this._zoomLayer || !treeEl) {throw new Error('missing #dbgrid / #dbgrid-zoom / #treeview');}
        this._wireZoomControls();

        /*
         * Mousedown on the grid background starts the rubber-band selection
         * flow. The handler below distinguishes click from drag: a plain
         * click (no movement past threshold) clears the selection on
         * mouseup; a drag past the threshold turns into a rubber-band
         * rectangle whose final state replaces / extends / toggles the
         * selection on mouseup. Shift / Ctrl modifiers control the merge
         * mode the same way they do for a single-card click.
         */
        this._wireRubberBand();

        this._treeview = new Treeview(treeEl);
        this._treeview.setOnModeChange((mode): void => {
            this._switchTreeviewMode(mode).catch(err => console.error('[DbEditor] mode switch failed:', err));
        });
        const searchEl = document.getElementById('treeview-search-input') as HTMLInputElement | null;
        if (searchEl) {
            searchEl.addEventListener('input', (): void => {
                this._treeview?.setFilter(searchEl.value);
            });
        }
        const warningsEl = document.getElementById('warnings');
        if (warningsEl) {this._warnings = new WarningsPanel(warningsEl);}
        const saveEl = document.getElementById('topbar-savestate');
        if (saveEl) {this._saveIndicator = new AutoSaveIndicator(saveEl, this._api);}
        await this._reload();
        this._wireTopbar();
        this._wireEvents();
        this._wireResizer();
        this._wireKeyboard();
    }

    /**
     * Global keyboard shortcuts. Kept here (not in BaseDialog) so editor
     * shortcuts don't fire while a modal is open — Esc inside a dialog
     * is BaseDialog's responsibility.
     *
     * Bound shortcuts:
     *   Ctrl/Cmd+F: focus the treeview filter input. Overrides the
     *               browser's native Find when no dialog is open and
     *               the focus isn't already inside a text-editing field.
     *   F2:         start inline rename of the selected table.
     *   Delete /
     *   Backspace:  confirm + delete the selected table.
     */
    private _wireKeyboard(): void {
        document.addEventListener('keydown', (e: KeyboardEvent): void => {
            if (document.querySelector('.dialog-backdrop')) {return;}
            if (this._isTextEditing(e.target)) {return;}

            if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
                const search = document.getElementById('treeview-search-input') as HTMLInputElement | null;
                if (!search) {return;}
                e.preventDefault();
                search.focus();
                search.select();
                return;
            }

            /*
             * Ctrl/Cmd + P (or +K) opens the global search palette — a
             * jump-to-table picker that searches across every database in
             * the project. The browser's native print dialog also binds
             * Ctrl+P; preventDefault keeps the palette opening cleanly.
             */
            if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P' || e.key === 'k' || e.key === 'K')) {
                e.preventDefault();
                this._openSearchPalette();
                return;
            }

            /*
             * `?` (Shift+/ on US layouts) opens the shortcut help. No
             * modifier requirement — discoverability shortcut should be
             * the cheapest possible chord.
             */
            if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                new ShortcutHelpDialog().show().catch((err: unknown): void => console.error('[DbEditor] help failed:', err));
                return;
            }

            /*
             * Ctrl/Cmd + Shift + C copies the SQL of every currently-selected
             * table to the clipboard (scoped-generate + concat). No-op when
             * nothing is selected.
             */
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
                e.preventDefault();
                this._copySelectionSql().catch((err: unknown): void => console.error('[DbEditor] copy SQL failed:', err));
                return;
            }

            // The remaining shortcuts act on the canvas selection.
            if (this._selectedTableUnids.size === 0) {return;}

            if (e.key === 'F2') {
                e.preventDefault();
                /* Rename only meaningful for a single selected card. */
                if (this._selectedTableUnids.size === 1) {
                    const only = this._selectedTableUnids.values().next().value;
                    if (only) {this._tables.get(only)?.startRename();}
                }
                return;
            }

            /*
             * `O` opens the table-options editor for the current
             * selection. 1 selected → standard `DbTableOptionsDialog`
             * (full replace); 2+ → `DbBatchTableOptionsDialog`
             * (sparse-patch — only ticked fields land on each
             * target). No modifier; suppressed when text-editing.
             */
            if ((e.key === 'o' || e.key === 'O') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                e.preventDefault();
                this._editSelectedTableOptions();
                return;
            }

            /*
             * `L` opens the layer picker for the current selection.
             * Same single/multi semantics as `O` — applies the
             * chosen layer to every selected table.
             */
            if ((e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                e.preventDefault();
                this._pickLayerForTables(Array.from(this._selectedTableUnids))
                .catch((err: unknown): void => console.error('[DbEditor] layer pick failed:', err));
                return;
            }

            /*
             * `F` fits everything in view (zoom + scroll). Topbar
             * has the same affordance via the ⛶ button. No modifier;
             * Ctrl+F is reserved for the treeview search above.
             */
            if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                e.preventDefault();
                this._fitToView();
                return;
            }

            /*
             * `R` renames the selection: 1 = inline (same UX as F2),
             * 2+ = bulk-rename pattern dialog with live preview.
             */
            if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                e.preventDefault();
                if (this._selectedTableUnids.size === 1) {
                    const only = this._selectedTableUnids.values().next().value;
                    if (only) {this._tables.get(only)?.startRename();}
                } else if (this._selectedTableUnids.size > 1) {
                    this._bulkRenameSelected()
                    .catch((err: unknown): void => console.error('[DbEditor] bulk rename failed:', err));
                }
                return;
            }

            /*
             * Backspace as well as Delete: macOS keyboards have no real
             * forward-Delete on most layouts, so users reach for ⌫.
             */
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                this._confirmDeleteSelected();
            }
        });
    }

    /**
     * Single entry point for "edit options" on the canvas selection.
     * 1 selected → existing single-table dialog (full replace);
     * 2+ → sparse-patch batch dialog. Sequential per-table updates
     * so the server's in-memory state settles between calls; one
     * reload at the end.
     */
    /**
     * Open the bulk-rename dialog for 2+ selected tables. Pattern
     * is applied via the dialog's preview UI; on Apply we receive a
     * `Map<tableUnid, newName>` and iterate updateTable sequentially.
     * No-op when fewer than 2 tables are selected (the `R` key
     * routes single-selection to inline rename instead).
     */
    private async _bulkRenameSelected(): Promise<void> {
        if (!this._activeProject || this._selectedTableUnids.size < 2) {return;}
        const all = this._collectAllTables(this._activeProject.data);
        const targets = all
        .filter(t => this._selectedTableUnids.has(t.unid))
        .map(t => ({unid: t.unid, name: t.name}));
        if (targets.length < 2) {return;}
        const result = await new DbBulkRenameDialog(targets).show();
        if (!result || result.size === 0) {return;}
        for (const [unid, newName] of result) {
            // eslint-disable-next-line no-await-in-loop
            await this._mutate(p => this._api.updateTable(p.unid, unid, {name: newName}));
        }
        await this._reload();
    }

    private async _editSelectedTableOptions(): Promise<void> {
        if (this._selectedTableUnids.size === 0 || !this._activeProject) {return;}
        const all = this._collectAllTables(this._activeProject.data);
        const targets = all.filter(t => this._selectedTableUnids.has(t.unid));
        if (targets.length === 0) {return;}
        if (targets.length === 1) {
            await this._editTableOptions(targets[0].unid);
            return;
        }
        const patch = await new DbBatchTableOptionsDialog(targets.length).show();
        if (!patch) {return;}
        for (const t of targets) {
            const merged = {...t.options ?? {}} as Record<string, string | undefined>;
            for (const [k, v] of Object.entries(patch)) {
                if (v === undefined) {delete merged[k];}
                else {merged[k] = v as string;}
            }
            // eslint-disable-next-line no-await-in-loop
            await this._mutate(p => this._api.updateTable(p.unid, t.unid, {options: merged as Record<string, string>}));
        }
        await this._reload();
    }

    /**
     * Open a layer picker for one or more tables. Layers come from
     * the active container (and folder descendants); pre-selects the
     * common current layer when all targets agree, otherwise no row
     * is initially selected. On apply: sequential `updateTable` per
     * target with the chosen `layerUnid` (`''` clears the field).
     */
    private async _pickLayerForTables(tableUnids: string[]): Promise<void> {
        if (!this._activeProject || tableUnids.length === 0) {return;}
        const all = this._collectAllTables(this._activeProject.data);
        const targets = all.filter(t => tableUnids.includes(t.unid));
        if (targets.length === 0) {return;}
        const container = this._activeContainerUnid
            ? this._findContainer(this._activeProject.data, this._activeContainerUnid)
            : null;
        const layers = container ? this._collectLayers(container) : [];

        if (targets.length === 1) {
            /*
             * Single-target uses the multi-membership dialog so the
             * user can pick the table's full set of diagrams in one
             * shot (MWB-style: one table appears in several diagrams
             * with per-diagram positions). The first checked diagram
             * becomes the primary (`layerUnid`), the rest become
             * `layerPlacements` whose positions inherit from the
             * existing placement entries (if any) or default to the
             * table's home `pos`.
             */
            const t = targets[0];
            const currentMemberships: string[] = [];
            if (t.layerUnid) {currentMemberships.push(t.layerUnid);}
            for (const p of t.layerPlacements ?? []) {currentMemberships.push(p.layerUnid);}
            const picked = await new LayerMembershipDialog(layers, currentMemberships).show();
            if (picked === null) {return;}
            const patch: {layerUnid: string; layerPlacements: {layerUnid: string; pos: {x: number; y: number;};}[];} = {
                layerUnid: '',
                layerPlacements: []
            };
            if (picked.length > 0) {
                patch.layerUnid = picked[0];
                for (const extra of picked.slice(1)) {
                    /*
                     * Preserve any existing per-diagram positions so
                     * a member that the user just re-confirmed
                     * doesn't jump back to (0,0). New memberships
                     * inherit the table's home position.
                     */
                    const existing = (t.layerPlacements ?? []).find(p => p.layerUnid === extra);
                    patch.layerPlacements.push({
                        layerUnid: extra,
                        pos: existing ? existing.pos : t.pos
                    });
                }
            }
            await this._mutate(p => this._api.updateTable(p.unid, t.unid, patch));
            await this._reload();
            return;
        }

        /*
         * Batch: keep the single-select picker — assigning N tables
         * to a multi-diagram set independently would be confusing
         * and most users want "make all these N tables members of
         * diagram X". Pre-select the current diagram when shared.
         */
        const first = targets[0].layerUnid ?? '';
        const allSame = targets.every(t => (t.layerUnid ?? '') === first);
        const initial = allSame ? first : null;
        const result = await new LayerPickerDialog(layers, targets.length, initial).show();
        if (result === null) {return;}
        for (const t of targets) {
            // eslint-disable-next-line no-await-in-loop
            await this._mutate(p => this._api.updateTable(p.unid, t.unid, {layerUnid: result}));
        }
        await this._reload();
    }

    private async _confirmDeleteSelected(): Promise<void> {
        if (this._selectedTableUnids.size === 0 || !this._activeProject) {return;}
        const all = this._collectAllTables(this._activeProject.data);
        const toDelete = all.filter(t => this._selectedTableUnids.has(t.unid));
        if (!toDelete.length) {return;}
        const ok = await ConfirmDialog.showConfirm(
            toDelete.length === 1 ? 'Delete table' : `Delete ${toDelete.length} tables`,
            toDelete.length === 1
                ? `Delete table "${toDelete[0].name}" and all its columns?`
                : `Delete ${toDelete.length} tables and all their columns?\n\n${toDelete.map(t => `  • ${t.name}`).join('\n')}\n\n(Use Ctrl+Z to undo if wrong.)`,
            'danger'
        );
        if (!ok) {return;}
        const unids = toDelete.map(t => t.unid);
        this._setSelection(null);
        /*
         * Sequential rather than parallel: deleteTable also strips FKs in
         * OTHER tables that point at the deleted one, and the server's
         * in-memory state needs to settle between calls.
         */
        for (const unid of unids) {
            // eslint-disable-next-line no-await-in-loop
            await this._mutate(p => this._api.deleteTable(p.unid, unid));
        }
        await this._reload();
    }

    private _isTextEditing(target: EventTarget | null): boolean {
        if (!(target instanceof HTMLElement)) {return false;}
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
            // Always allow refocusing the search field itself.
            return target.id !== 'treeview-search-input';
        }
        return target.isContentEditable;
    }

    /*
     * -----------------------------------------------------------------
     * load + render
     * -----------------------------------------------------------------
     */

    private async _reload(): Promise<void> {
        try {
            const res = await this._api.loadSchema();
            this._projects = res.projects as LoadedProject[];
        } catch (err) {
            console.error('[DbEditor] failed to load schema', err);
            await AlertDialog.showAlert('Load failed', String(err));
            return;
        }
        if (!this._projects.length) {
            this._activeProject = null;
            this._activeContainerUnid = null;
            this._renderTopbarStatus();
            this._treeview?.render([]);
            this._renderEmptyCanvas('No projects configured.', 'Add one in dbeditor.json and reload.');
            return;
        }
        if (!this._activeProject) {this._activeProject = this._projects[0];}
        // refresh active project pointer if still present
        const stillThere = this._projects.find(p => p.unid === this._activeProject!.unid);
        this._activeProject = stillThere ?? this._projects[0];

        this._renderTopbarStatus();
        const allConnectable: string[] = [];
        for (const p of this._projects) {
            for (const u of p.connectableDatabaseUnids ?? []) {allConnectable.push(u);}
        }
        this._treeview!.setConnectableDatabaseUnids(allConnectable);
        this._renderTreeview();
        // Re-validate after every reload so warnings stay in sync.
        if (this._warnings && this._activeProject) {
            this._warnings.render(validateSchema(this._activeProject.data));
        }

        // start (or refresh) SSE for the active project
        if (this._sse) {this._sse.stop();}
        this._sse = new DbSseClient(this._activeProject.unid, this._api.clientId, ev => this._onSseEvent(ev));
        this._sse.start();
        if (this._liveSse) {this._liveSse.stop();}
        this._liveSse = new DbLiveSseClient(this._activeProject.unid, ev => this._onLiveSseEvent(ev));
        this._liveSse.start();

        // pick the first database as active container if none chosen yet
        if (!this._activeContainerUnid) {
            const firstDb = this._findFirstDatabase(this._activeProject.data);
            if (firstDb) {this._activeContainerUnid = firstDb.unid;}
        }
        this._loadZoomFromActiveProject();
        this._renderCanvas();
    }

    /*
     * -----------------------------------------------------------------
     * Treeview mode (Modell ↔ Live)
     * -----------------------------------------------------------------
     */

    private _renderTreeview(): void {
        if (!this._treeview) {return;}
        if (this._treeviewMode === 'model') {
            this._treeview.render(this._projects.map(p => ({unid: p.unid, name: p.name, data: p.data})));
            return;
        }
        const liveProjects = this._projects.map(p => ({
            unid: p.unid,
            name: p.name,
            data: this._buildLiveProjectRoot(p)
        }));
        this._treeview.render(liveProjects);
    }

    /**
     * Builds a synthetic tree-root for live mode: only databases that have
     * a live connection appear, with their cached live tables/views/enums
     * (or a "not loaded" placeholder if `Refresh from DB` hasn't run yet).
     * Model-side names + unids are preserved so the activate/sync menus
     * keep working.
     */
    private _buildLiveProjectRoot(p: LoadedProject): JsonDataDB {
        const connectables = new Set(p.connectableDatabaseUnids ?? []);
        const entrys: JsonDataDB[] = [];
        for (const child of (p.data.entrys as JsonDataDB[])) {
            if (child.type !== JsonDataDBType.database) {continue;}
            if (!connectables.has(child.unid)) {continue;}
            const live = this._liveByDatabaseUnid.get(child.unid);
            entrys.push({
                unid: child.unid,
                name: live ? child.name : `${child.name} · (not loaded)`,
                type: JsonDataDBType.database,
                istoggle: true,
                entrys: [],
                tables: live?.tables ?? [],
                views: live?.views ?? [],
                enums: live?.enums ?? []
            });
        }
        return {
            unid: 'root',
            name: 'root',
            type: JsonDataDBType.root,
            entrys: entrys,
            tables: [],
            views: [],
            enums: []
        };
    }

    private async _switchTreeviewMode(mode: TreeviewMode): Promise<void> {
        this._treeviewMode = mode;
        if (this._treeview) {this._treeview.setMode(mode);}
        if (mode === 'live' && this._activeProject) {
            try {
                const res = await this._api.liveSnapshot(this._activeProject.unid);
                for (const [k, v] of Object.entries(res.snapshot.byDatabaseUnid)) {
                    this._liveByDatabaseUnid.set(k, v as JsonDataDB);
                }
            } catch (err) {
                console.error('[DbEditor] live snapshot fetch failed:', err);
            }
        }
        this._renderTreeview();
    }

    private _onLiveSseEvent(ev: { op: string; body: unknown; }): void {
        if (ev.op !== 'live:refreshed' || !this._activeProject) {return;}
        if (this._treeviewMode !== 'live') {return;}
        /*
         * Pull the full snapshot rather than diff-decoding the body. The
         * live tree is small (one DB) and a re-fetch keeps the reconciler
         * trivially correct — same approach the model side uses.
         */
        this._api.liveSnapshot(this._activeProject.unid)
        .then((res): void => {
            for (const [k, v] of Object.entries(res.snapshot.byDatabaseUnid)) {
                this._liveByDatabaseUnid.set(k, v as JsonDataDB);
            }
            this._renderTreeview();
        })
        .catch((err: unknown): void => console.error('[DbEditor] live snapshot failed:', err));
    }

    private _renderTopbarStatus(): void {
        const status = document.getElementById('topbar-database');
        if (status) {
            if (this._activeProject) {
                status.textContent = ` · ${this._activeProject.name} (${this._activeProject.dialect})`;
            } else {
                status.textContent = '';
            }
        }
        this._renderUndoRedoButtons();
    }

    private _renderCanvas(): void {
        if (!this._grid) {return;}
        const jsp = getJsPlumbInstance();
        if (!this._jsPlumbBound) { this._bindJsPlumb(jsp); this._jsPlumbBound = true; }
        jsp.deleteEveryConnection();
        this._fkConnections.length = 0;
        this._junctionConnections.length = 0;
        for (const t of this._tables.values()) {t.destroy();}
        this._tables.clear();
        for (const v of this._views.values()) {v.destroy();}
        this._views.clear();
        this._grid.querySelectorAll('.empty-state').forEach(e => e.remove());

        if (!this._activeProject || !this._activeContainerUnid) {
            this._renderEmptyCanvas('No database selected.', 'Pick one from the tree.');
            return;
        }
        const container = this._findContainer(this._activeProject.data, this._activeContainerUnid);
        if (!container) {
            this._renderEmptyCanvas('Container not found.', 'Reloading…');
            return;
        }
        const enums = this._collectEnums(container);
        let tables = this._collectTables(container);
        let views = this._collectViews(container);
        let layers = this._collectLayers(container);
        /*
         * Layer scope: when a layer is the active filter (set via
         * clicking a layer in the treeview), restrict the canvas to
         * its member tables only. Views/enums are out-of-scope for
         * layers — hide them. The active layer itself stays visible
         * so the user sees the grouping they're focused on.
         */
        if (this._activeLayerUnid) {
            const layerUnid = this._activeLayerUnid;
            /*
             * Multi-diagram membership: a table is "in" this diagram
             * if its primary `layerUnid` matches OR any entry in
             * `layerPlacements` does. The position for rendering then
             * comes from the matching placement when one exists, else
             * from `pos` (the primary diagram's home position). We
             * swap `pos` on a shallow clone so DbTable's read-only
             * positioning logic doesn't need to know about placements.
             *
             * Views have single-membership only (no per-diagram
             * placements yet) — include a view in this scope iff its
             * `layerUnid` matches.
             */
            tables = tables
            .filter(t => DbEditor._tableInLayer(t, layerUnid))
            .map(t => DbEditor._tableWithEffectivePos(t, layerUnid));
            views = views.filter(v => v.layerUnid === layerUnid);
            layers = layers.filter(l => l.unid === layerUnid);
        }
        this._renderScopeBanner(layers.length === 1 && this._activeLayerUnid ? layers[0].name : null);
        if (!tables.length && !views.length) {
            this._renderEmptyCanvas('No tables or views yet.', 'Click "Add Table" in the topbar.');
            return;
        }
        const cardHost = this._zoomLayer ?? this._grid;
        /*
         * Render layers FIRST so they sit behind table cards in the
         * stacking order. They're pure visual backdrops — no jsPlumb
         * handles, no drag, no events; clicks pass through to the
         * canvas for rubber-band selection.
         */
        cardHost.querySelectorAll('.db-layer').forEach(e => e.remove());
        for (const layer of layers) {
            const el = document.createElement('div');
            el.className = 'db-layer';
            el.dataset.layerUnid = layer.unid;
            el.style.left = `${layer.pos.x}px`;
            el.style.top = `${layer.pos.y}px`;
            el.style.width = `${layer.width}px`;
            el.style.height = `${layer.height}px`;
            if (layer.color) {el.style.background = layer.color;}
            /*
             * Suppress the in-canvas layer label when this layer is
             * the currently scoped one — the scope banner above the
             * canvas already names it, and the treeview shows it as
             * the active row. Rename/delete actions remain reachable
             * via the treeview's ⋯ menu. Resize handle still renders
             * so the user can size the diagram area.
             */
            if (this._activeLayerUnid !== layer.unid) {
                this._buildLayerLabel(layer, el);
            }
            this._buildLayerResizeHandle(layer, el);
            cardHost.append(el);
        }
        /*
         * Pass active-layer context to each card so its ⋯ menu can
         * surface the "Remove from this diagram" entry when scoped.
         * `layers` was filtered to a single entry above when
         * `_activeLayerUnid` is set, so `layers[0]` is that layer.
         */
        const activeLayerCtx = this._activeLayerUnid && layers.length === 1
            ? {unid: layers[0].unid, name: layers[0].name}
            : null;
        for (const t of tables) {
            const card = new DbTable(t, jsp, enums, activeLayerCtx);
            card.attach(cardHost);
            this._tables.set(t.unid, card);
        }
        for (const v of views) {
            const card = new DbView(v, jsp, activeLayerCtx);
            card.attach(cardHost);
            this._views.set(v.unid, card);
        }

        /*
         * Render FKs after tables are in the DOM so column rows have measurable
         * offsets (anchors are computed from offsetTop / offsetHeight).
         * Use rAF so the browser has done layout before we measure.
         */
        requestAnimationFrame(() => {
            for (const t of tables) {
                for (const fk of t.foreignKeys) {this._renderForeignKey(t, fk, tables);}
            }
            this._detectAndRenderJunctions(tables);
            this._applyCanvasExtent();
            /*
             * Re-apply FK highlight after the connections exist —
             * `_applySelection` (called before this rAF) only painted
             * the cards; the connector SVG elements are only created
             * inside `_renderForeignKey` above.
             */
            this._applyFkHighlight();
        });

        /*
         * Selection survives across re-renders; re-paint the marker now
         * that the new card elements exist.
         */
        this._applySelection();
    }

    /**
     * Floating banner shown when the canvas is scoped to a layer.
     * Mounted on the `#dbgrid` container (outside the zoom layer so
     * it doesn't scale) with an × button to clear the scope. Re-runs
     * on every `_renderCanvas` — passes the layer's name or null to
     * dismiss.
     */
    private _renderScopeBanner(layerName: string | null): void {
        if (!this._grid) {return;}
        const existing = this._grid.querySelector('.scope-banner');
        if (!layerName) {
            existing?.remove();
            return;
        }
        if (existing) {existing.remove();}
        const banner = document.createElement('div');
        banner.className = 'scope-banner';
        const lbl = document.createElement('span');
        lbl.textContent = `Showing EER diagram: ${layerName}`;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'scope-banner-close';
        close.title = 'Clear diagram scope (show all)';
        close.textContent = '×';
        close.addEventListener('click', () => {
            const dbUnid = this._activeContainerUnid;
            if (!dbUnid) {return;}
            this._activeLayerUnid = null;
            this._treeview?.setActive(dbUnid);
            this._renderCanvas();
        });
        banner.append(lbl, close);
        this._grid.append(banner);
    }

    /**
     * Build the corner label for a layer with rename + delete affordances.
     * `pointer-events: auto` on the label so it catches clicks; the
     * parent layer keeps `pointer-events: none` so the rest of the
     * backdrop is click-through (rubber-band selection still works).
     *
     * Double-click on the name → inline rename input. Hover → ⋯ menu
     * with Rename + Delete (both routed through the standard event +
     * mutate flow, so undo restores the prior state).
     */
    private _buildLayerLabel(layer: JsonLayer, layerEl: HTMLElement): void {
        const lbl = document.createElement('div');
        lbl.className = 'db-layer-label';

        /*
         * Mousedown anywhere on the label that ISN'T the rename
         * input or the menu button starts a drag of the whole
         * layer. The name span and ⋯ button stop propagation
         * themselves so they don't fire this handler accidentally.
         */
        lbl.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button !== 0) {return;}
            this._startLayerDrag(layer, layerEl, e);
        });

        const nameSpan = document.createElement('span');
        nameSpan.className = 'db-layer-label-name';
        nameSpan.textContent = layer.name;
        nameSpan.addEventListener('mousedown', (e) => e.stopPropagation());
        nameSpan.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this._startLayerRename(nameSpan, layer);
        });

        const menuBtn = document.createElement('button');
        menuBtn.type = 'button';
        menuBtn.className = 'db-layer-label-menu';
        menuBtn.replaceChildren(iconEllipsis());
        menuBtn.title = 'EER diagram actions';
        menuBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openContextMenu(menuBtn, [
                {
                    label: 'Rename…',
                    onSelect: (): void => this._startLayerRename(nameSpan, layer)
                },
                {
                    label: 'Change color…',
                    onSelect: (): void => this._pickLayerColor(layer)
                },
                {
                    label: 'Delete EER diagram',
                    danger: true,
                    onSelect: async(): Promise<void> => {
                        const ok = await ConfirmDialog.showConfirm(
                            'Delete EER diagram',
                            `Delete diagram "${layer.name}"? Tables inside are not deleted; their diagram reference becomes empty.\n\nUse Ctrl+Z to undo.`,
                            'danger'
                        );
                        if (!ok) {return;}
                        window.dispatchEvent(new CustomEvent(EditorEvents.deleteLayer, {detail: {unid: layer.unid}}));
                    }
                }
            ]);
        });

        lbl.append(nameSpan, menuBtn);
        layerEl.append(lbl);
    }

    /**
     * Bottom-right corner resize handle. Mousedown starts the
     * resize, mousemove updates `width/height` directly (zoom-
     * aware, just like drag), mouseup persists. Top-left position
     * stays fixed; only the SE corner moves. Min width/height
     * 60px so the user can't accidentally collapse a layer to zero.
     */
    private _buildLayerResizeHandle(layer: JsonLayer, layerEl: HTMLElement): void {
        const handle = document.createElement('div');
        handle.className = 'db-layer-resize';
        handle.title = 'Drag to resize';
        handle.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button !== 0) {return;}
            e.preventDefault();
            e.stopPropagation();
            const startScreenX = e.clientX;
            const startScreenY = e.clientY;
            const startW = layer.width;
            const startH = layer.height;
            const zoom = this._zoomLevel || 1;
            const MIN = 60;
            let moved = false;

            const onMove = (ev: MouseEvent): void => {
                const dx = (ev.clientX - startScreenX) / zoom;
                const dy = (ev.clientY - startScreenY) / zoom;
                if (!moved && Math.hypot(dx, dy) < 4) {return;}
                moved = true;
                const nw = Math.max(MIN, Math.round(startW + dx));
                const nh = Math.max(MIN, Math.round(startH + dy));
                layerEl.style.width = `${nw}px`;
                layerEl.style.height = `${nh}px`;
                layer.width = nw;
                layer.height = nh;
            };
            const onUp = (): void => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                if (!moved) {return;}
                this._mutate(p => this._api.updateLayer(p.unid, layer.unid, {width: layer.width, height: layer.height}))
                .then(() => this._reload());
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });
        layerEl.append(handle);
    }

    /**
     * Drag a whole layer rectangle. Mousedown on the label
     * background (not on the name span or menu button) starts the
     * drag; mousemove updates `layerEl.style.left/top` directly so
     * the move feels immediate; mouseup commits via `updateLayer` if
     * the cursor moved past a small threshold (so a plain click
     * doesn't fire a no-op API call).
     *
     * Mouse delta is in screen pixels — we divide by `_zoomLevel`
     * because the layer sits inside the zoom-scaled wrapper, so a
     * 100px screen drag at 0.5× zoom should advance the layer by
     * 200 canvas pixels.
     */
    private _startLayerDrag(layer: JsonLayer, layerEl: HTMLElement, downEv: MouseEvent): void {
        downEv.preventDefault();
        downEv.stopPropagation();
        const startScreenX = downEv.clientX;
        const startScreenY = downEv.clientY;
        const startPosX = layer.pos.x;
        const startPosY = layer.pos.y;
        const zoom = this._zoomLevel || 1;
        let moved = false;

        /*
         * Member tables move with the layer: anything whose
         * `layerUnid` matches gets the same delta. Visual-only-
         * overlap tables (no layerUnid) stay put — the layer is just
         * a backdrop for them. Snapshot starting positions so each
         * mousemove computes from the original, not the previous
         * frame (avoids drift accumulation).
         */
        const memberCards: {tableUnid: string; card: {element: HTMLElement;}; startX: number; startY: number; isPrimary: boolean;}[] = [];
        if (this._activeProject && this._activeContainerUnid) {
            const container = this._findContainer(this._activeProject.data, this._activeContainerUnid);
            if (container) {
                for (const t of this._collectTables(container)) {
                    if (!DbEditor._tableInLayer(t, layer.unid)) {continue;}
                    const card = this._tables.get(t.unid);
                    if (!card) {continue;}
                    /*
                     * Start position is the table's effective
                     * position in THIS diagram — placement entry
                     * wins, else top-level `pos` (primary). On
                     * commit we write back to whichever slot the
                     * value came from, so a placement-based member
                     * doesn't accidentally overwrite the primary
                     * `pos` that's used outside diagram scope.
                     */
                    const eff = DbEditor._effectivePos(t, layer.unid);
                    memberCards.push({
                        tableUnid: t.unid,
                        card: {element: card.element},
                        startX: eff.x,
                        startY: eff.y,
                        isPrimary: t.layerUnid === layer.unid
                    });
                }
            }
        }

        const onMove = (e: MouseEvent): void => {
            const dx = (e.clientX - startScreenX) / zoom;
            const dy = (e.clientY - startScreenY) / zoom;
            if (!moved && Math.hypot(dx, dy) < 4) {return;}
            moved = true;
            const nx = Math.round(startPosX + dx);
            const ny = Math.round(startPosY + dy);
            layerEl.style.left = `${nx}px`;
            layerEl.style.top = `${ny}px`;
            layer.pos.x = nx;
            layer.pos.y = ny;
            for (const m of memberCards) {
                const tx = Math.round(m.startX + dx);
                const ty = Math.round(m.startY + dy);
                m.card.element.style.left = `${tx}px`;
                m.card.element.style.top = `${ty}px`;
            }
        };
        const onUp = (): void => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            if (!moved) {return;}
            /*
             * Persist the layer move + every dragged-along table.
             * Sequential because each `updateTable` re-validates
             * server-side and we want the snapshot consistent.
             */
            const tableMoves = memberCards.map(m => {
                const finalX = Math.round(m.startX + (layer.pos.x - startPosX));
                const finalY = Math.round(m.startY + (layer.pos.y - startPosY));
                return {
                    tableUnid: m.tableUnid,
                    pos: {x: finalX, y: finalY},
                    isPrimary: m.isPrimary
                };
            });
            (async(): Promise<void> => {
                await this._mutate(p => this._api.updateLayer(p.unid, layer.unid, {pos: {x: layer.pos.x, y: layer.pos.y}}));
                for (const move of tableMoves) {
                    if (move.isPrimary) {
                        // eslint-disable-next-line no-await-in-loop
                        await this._mutate(p => this._api.updateTable(p.unid, move.tableUnid, {pos: move.pos}));
                    } else {
                        /*
                         * Placement member: rewrite the matching
                         * placement entry, keep the primary `pos`
                         * (the table's home view) untouched. We
                         * have to re-read the current placements
                         * because earlier iterations in this loop
                         * may already have mutated them.
                         */
                        const current = this._findTableInProject(move.tableUnid);
                        const nextPlacements = current
                            ? DbEditor._upsertPlacement(current.layerPlacements ?? [], layer.unid, move.pos)
                            : [{layerUnid: layer.unid, pos: move.pos}];
                        // eslint-disable-next-line no-await-in-loop
                        await this._mutate(p => this._api.updateTable(p.unid, move.tableUnid, {layerPlacements: nextPlacements}));
                    }
                }
                await this._reload();
            })().catch((err: unknown): void => console.error('[DbEditor] layer drag persist failed:', err));
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }

    /**
     * Open the native color picker for a layer. Stored color carries
     * an alpha suffix (`26` ≈ 15%) so the layer renders translucent
     * and table cards on top stay readable. Picker only edits the
     * RGB part — alpha is fixed by the backdrop convention.
     */
    private async _pickLayerColor(layer: JsonLayer): Promise<void> {
        const result = await new LayerColorDialog(layer.name, extractHex(layer.color)).show();
        if (result === null) {return;}
        const stored = `${result}26`;
        await this._mutate(p => this._api.updateLayer(p.unid, layer.unid, {color: stored}));
        await this._reload();
    }

    private _startLayerRename(nameSpan: HTMLSpanElement, layer: JsonLayer): void {
        const input = document.createElement('input');
        input.className = 'db-layer-label-input';
        input.value = layer.name;
        nameSpan.replaceWith(input);
        input.focus();
        input.select();
        let committed = false;
        const commit = (): void => {
            if (committed) {return;}
            committed = true;
            const next = input.value.trim();
            input.replaceWith(nameSpan);
            if (next && next !== layer.name) {
                window.dispatchEvent(new CustomEvent(EditorEvents.renameLayer, {detail: {unid: layer.unid, name: next}}));
            }
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {e.preventDefault(); input.blur();}
            else if (e.key === 'Escape') {e.preventDefault(); committed = true; input.replaceWith(nameSpan);}
            e.stopPropagation();
        });
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('click', (e) => e.stopPropagation());
    }

    /**
     * Update selection state and the visual marker. Pass null to clear.
     * If the selected table isn't on the active canvas (e.g. after a
     * container switch that no longer contains it), the state is kept
     * but no card receives the class — `_applySelection` will pick
     * the right card up the next time it's rendered.
     */
    /**
     * Selection update. `mode` semantics:
     *   - `replace`: clear, then select `tableUnid` (null = just clear).
     *   - `add`: extend the selection (Shift-click).
     *   - `toggle`: flip the membership of `tableUnid` (Ctrl/Cmd-click).
     */
    private _setSelection(tableUnid: string | null, mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
        const before = new Set(this._selectedTableUnids);
        if (mode === 'replace') {
            this._selectedTableUnids.clear();
            if (tableUnid) {this._selectedTableUnids.add(tableUnid);}
        } else if (mode === 'add' && tableUnid) {
            this._selectedTableUnids.add(tableUnid);
        } else if (mode === 'toggle' && tableUnid) {
            if (this._selectedTableUnids.has(tableUnid)) {this._selectedTableUnids.delete(tableUnid);}
            else {this._selectedTableUnids.add(tableUnid);}
        }
        /* No-op if nothing changed: avoid DOM thrash. */
        if (before.size === this._selectedTableUnids.size) {
            let same = true;
            for (const u of before) {
                if (!this._selectedTableUnids.has(u)) {same = false; break;}
            }
            if (same) {return;}
        }
        this._applySelection();
    }

    /** Convenience for older single-select call-sites where the caller knows exactly one card should be selected. */
    private _selectOne(tableUnid: string | null): void {
        this._setSelection(tableUnid, 'replace');
    }

    private _applySelection(): void {
        for (const [unid, card] of this._tables) {
            card.element.classList.toggle('db-table--selected', this._selectedTableUnids.has(unid));
        }
        this._applyFkHighlight();
    }

    /**
     * Dim FK lines that don't touch the current selection so the user
     * can trace connections in a busy schema. No-op when nothing is
     * selected — every line returns to full opacity. The class lives
     * on each connector's SVG `canvas` element (jsPlumb's term for
     * the rendered path); CSS in `main.css` handles the fade.
     *
     * Best-effort: jsPlumb's internal `connector.canvas` is stable in
     * 6.x but isn't a typed public field, so we feature-test before
     * touching it.
     */
    private _applyFkHighlight(): void {
        const hasSelection = this._selectedTableUnids.size > 0;
        const apply = (entries: {srcTableUnid: string; dstTableUnid: string; conn: any;}[]): void => {
            for (const e of entries) {
                const canvas = e.conn?.connector?.canvas as HTMLElement | undefined;
                if (!canvas) {continue;}
                const related = !hasSelection
                    || this._selectedTableUnids.has(e.srcTableUnid)
                    || this._selectedTableUnids.has(e.dstTableUnid);
                canvas.classList.toggle('jtk-connector--related', hasSelection && related);
                canvas.classList.toggle('jtk-connector--dimmed', hasSelection && !related);
            }
        };
        apply(this._fkConnections);
        apply(this._junctionConnections.map(j => ({
            srcTableUnid: j.outerAUnid,
            dstTableUnid: j.outerBUnid,
            conn: j.conn
        })));
    }

    /**
     * Heuristic junction-table detection: a table with exactly two FKs
     * whose union of FK columns equals the table's primary-key column
     * set. For each match, draw an extra logical "N:N" line between the
     * two outer tables. The junction stays visible — the line is purely
     * a readability aid.
     *
     * Handles composite FKs (each FK can be multi-column). Allows extra
     * non-PK columns (created_at, etc.) since real-world junction tables
     * often carry metadata. The N:N line is anchored on the first
     * referenced column of each FK.
     */
    private _detectAndRenderJunctions(tables: JsonTable[]): void {
        if (!this._showJunctionLines) {return;}
        for (const t of tables) {
            if (t.foreignKeys.length !== 2) {continue;}
            const [fk1, fk2] = t.foreignKeys;
            /*
             * Avoid self-loops; a junction whose outer tables are the same
             * table (a graph-edges table) would draw a line to itself.
             */
            if (fk1.refTableUnid === fk2.refTableUnid) {continue;}
            if (!fk1.columns.length || !fk2.columns.length) {continue;}

            const fkColUnids = new Set<string>([
                ...fk1.columns.map(p => p.columnUnid),
                ...fk2.columns.map(p => p.columnUnid)
            ]);
            const pkCols = t.columns.filter(c => c.primaryKey);
            if (pkCols.length !== fkColUnids.size) {continue;}
            if (!pkCols.every(c => fkColUnids.has(c.unid))) {continue;}

            const outerA = tables.find(x => x.unid === fk1.refTableUnid);
            const outerB = tables.find(x => x.unid === fk2.refTableUnid);
            if (!outerA || !outerB) {continue;}
            const outerACol = outerA.columns.find(c => c.unid === fk1.columns[0].refColumnUnid);
            const outerBCol = outerB.columns.find(c => c.unid === fk2.columns[0].refColumnUnid);
            if (!outerACol || !outerBCol) {continue;}
            this._renderJunctionLine(t, outerA, outerACol, outerB, outerBCol);
        }
    }

    private _renderJunctionLine(
        junction: JsonTable,
        outerA: JsonTable, outerACol: JsonColumn,
        outerB: JsonTable, outerBCol: JsonColumn
    ): void {
        const aCard = this._tables.get(outerA.unid);
        const bCard = this._tables.get(outerB.unid);
        if (!aCard || !bCard) {return;}

        const aRect = aCard.element.getBoundingClientRect();
        const bRect = bCard.element.getBoundingClientRect();
        let aSide: 'left' | 'right';
        let bSide: 'left' | 'right';
        if (aRect.right < bRect.left)      { aSide = 'right'; bSide = 'left'; }
        else if (bRect.right < aRect.left) { aSide = 'left';  bSide = 'right'; }
        else                                { aSide = 'right'; bSide = 'left'; }

        const aAnchor = aCard.getColumnAnchor(outerACol.unid, aSide);
        const bAnchor = bCard.getColumnAnchor(outerBCol.unid, bSide);
        const aProngs = aSide === 'right' ? 'left' : 'right';
        const bProngs = bSide === 'right' ? 'left' : 'right';

        const STROKE = 'var(--c-uk, #8a3e9c)';
        const overlays: any[] = [
            { type: 'Custom', options: { create: () => crowsFoot(aProngs, STROKE), location: 0 } },
            { type: 'Custom', options: { create: () => crowsFoot(bProngs, STROKE), location: 1 } },
            { type: 'Label', options: { label: `N:N via ${junction.name}`, location: 0.5, cssClass: 'jtk-overlay jtk-overlay-nn' } }
        ];

        const conn = getJsPlumbInstance().connect({
            source: aCard.element,
            target: bCard.element,
            anchors: [aAnchor, bAnchor],
            overlays: overlays,
            paintStyle: { stroke: STROKE, strokeWidth: 1.25, dashstyle: '6 4' } as any,
            detachable: false
        } as any);
        if (conn) {
            (conn as any).data = { kind: 'nn', junctionUnid: junction.unid };
            this._junctionConnections.push({
                outerAUnid: outerA.unid,
                outerBUnid: outerB.unid,
                junctionUnid: junction.unid,
                conn: conn
            });
        }
    }

    /**
     * Render one persisted FK with column-level anchors and ER notation:
     *  - "many" end: crow's foot, prongs fanning into the source/FK table
     *  - "one"  end: single perpendicular bar
     *  - 1:1 (every FK col is PK or UNIQUE): bar at both ends, no crow's foot
     *  - nullable (any FK col is nullable): dashed line; otherwise solid
     *
     * Composite FKs render one line per column pair. The label is shown
     * on the middle pair only (with `(×N)` suffix) so multi-column FKs
     * don't clutter the canvas with N copies of the same constraint name.
     */
    private _renderForeignKey(srcTable: JsonTable, fk: JsonForeignKey, allTables: JsonTable[]): void {
        const dstTable = allTables.find(x => x.unid === fk.refTableUnid);
        if (!dstTable) {return;}
        const srcCard = this._tables.get(srcTable.unid);
        const dstCard = this._tables.get(dstTable.unid);
        if (!srcCard || !dstCard) {return;}
        if (!fk.columns.length) {return;}

        // Resolve all column pairs up front; bail if any reference is stale.
        const resolved: { srcCol: JsonColumn; dstCol: JsonColumn; }[] = [];
        for (const pair of fk.columns) {
            const srcCol = srcTable.columns.find(c => c.unid === pair.columnUnid);
            const dstCol = dstTable.columns.find(c => c.unid === pair.refColumnUnid);
            if (!srcCol || !dstCol) {return;}
            resolved.push({ srcCol: srcCol, dstCol: dstCol });
        }

        /*
         * Pick anchor sides from current rect positions: emerge on the side
         * facing the other card. Falls back to right/left when overlapping.
         */
        const srcRect = srcCard.element.getBoundingClientRect();
        const dstRect = dstCard.element.getBoundingClientRect();
        let srcSide: 'left' | 'right';
        let dstSide: 'left' | 'right';
        if (srcRect.right < dstRect.left)      { srcSide = 'right'; dstSide = 'left'; }
        else if (dstRect.right < srcRect.left) { srcSide = 'left';  dstSide = 'right'; }
        else                                    { srcSide = 'right'; dstSide = 'left'; }

        /*
         * Composite cardinality: 1:1 iff the FK column tuple is guaranteed
         * unique on the source side — either equal to the PK column set or
         * covered by a UNIQUE index with the same column set. See
         * `Util/FkCardinality.ts` for the full case analysis.
         */
        const oneToOne = isOneToOneFk(srcTable, resolved.map(r => r.srcCol.unid));
        const nullable = resolved.some(r => !r.srcCol.notNull);

        /*
         * Crow's foot prongs always point AWAY from the line endpoint
         * INTO the source/destination table. The table sits opposite
         * the side the line emerges from.
         */
        const srcProngs = srcSide === 'right' ? 'left' : 'right';

        const labelIdx = Math.floor(resolved.length / 2);
        const labelText = resolved.length > 1 ? `${fk.name} (×${resolved.length})` : fk.name;
        const jsp = getJsPlumbInstance();

        resolved.forEach(({ srcCol, dstCol }, idx) => {
            const overlays: any[] = [
                {
                    type: 'Custom',
                    options: {
                        create: () => oneToOne ? oneBar(srcSide) : crowsFoot(srcProngs),
                        location: 0
                    }
                },
                {
                    type: 'Custom',
                    options: {
                        create: () => oneBar(dstSide),
                        location: 1
                    }
                }
            ];
            if (idx === labelIdx) {
                overlays.push({
                    type: 'Label',
                    options: { label: labelText, location: 0.5, cssClass: 'jtk-overlay' }
                });
            }

            const conn = jsp.connect({
                source: srcCard.element,
                target: dstCard.element,
                anchors: [srcCard.getColumnAnchor(srcCol.unid, srcSide),
                    dstCard.getColumnAnchor(dstCol.unid, dstSide)],
                overlays: overlays,
                paintStyle: {
                    stroke: 'var(--c-fk, #3e9c8a)',
                    strokeWidth: 1.5,
                    dashstyle: nullable ? '4 3' : undefined
                } as any,
                detachable: false
            } as any);
            if (conn) {
                (conn as any).data = {
                    fkUnid: fk.unid,
                    tableUnid: srcTable.unid,
                    fkName: fk.name,
                    /*
                     * Carry the column unids on each connection so
                     * the hover handler can highlight the two paired
                     * rows visually — addresses the "I want to see
                     * which columns are connected" affordance the
                     * straight-line routing already supports.
                     */
                    srcColumnUnid: srcCol.unid,
                    dstColumnUnid: dstCol.unid
                };
                this._fkConnections.push({
                    srcTableUnid: srcTable.unid,
                    dstTableUnid: dstTable.unid,
                    fkUnid: fk.unid,
                    conn: conn
                });
                this._wireFkHoverHighlight(conn, srcTable.unid, srcCol.unid, dstTable.unid, dstCol.unid);
            }
        });
    }

    /**
     * Add row-highlight on FK hover. When the user mouses over a
     * connection line, the two paired column rows light up so the
     * source ↔ destination pairing is unambiguous at a glance —
     * even on composite FKs where multiple parallel lines run
     * between the same two tables.
     */
    private _wireFkHoverHighlight(
        conn: any,
        srcTableUnid: string,
        srcColumnUnid: string,
        dstTableUnid: string,
        dstColumnUnid: string
    ): void {
        const find = (tableUnid: string, columnUnid: string): HTMLElement | null => {
            const card = this._tables.get(tableUnid)?.element;
            return (card?.querySelector(`.db-table-column[data-column-unid="${columnUnid}"]`) as HTMLElement | null) ?? null;
        };
        const toggle = (on: boolean): void => {
            for (const row of [find(srcTableUnid, srcColumnUnid), find(dstTableUnid, dstColumnUnid)]) {
                row?.classList.toggle('db-table-column--fk-hover', on);
            }
        };
        conn.bind('mouseover', () => toggle(true));
        conn.bind('mouseout', () => toggle(false));
    }

    /**
     * Re-render FK and junction-N:N connections that touch `tableUnid`
     * (as source / referenced / outer table). Called after a drag-stop
     * so anchor sides can flip when the table has moved past its
     * partner.
     */
    private _rerenderFksFor(tableUnid: string): void {
        if (!this._activeProject || !this._activeContainerUnid) {return;}
        const container = this._findContainer(this._activeProject.data, this._activeContainerUnid);
        if (!container) {return;}
        const tables = this._collectTables(container);
        const jsp = getJsPlumbInstance();

        const affectedFk = this._fkConnections.filter(e => {
            if (e.srcTableUnid === tableUnid) {return true;}
            const t = tables.find(x => x.unid === e.srcTableUnid);
            const fk = t?.foreignKeys.find(f => f.unid === e.fkUnid);
            return fk?.refTableUnid === tableUnid;
        });
        if (affectedFk.length) {
            for (const e of affectedFk) {
                try {
                    jsp.deleteConnection(e.conn);
                } catch {
                    // already gone
                }
            }
            this._fkConnections = this._fkConnections.filter(e => !affectedFk.includes(e));
            /*
             * Dedupe by (srcTable, fk) so a composite FK with N column
             * pairs is re-rendered once (not N times).
             */
            const uniqueFks = new Map<string, { srcTableUnid: string; fkUnid: string; }>();
            for (const e of affectedFk) {uniqueFks.set(`${e.srcTableUnid}:${e.fkUnid}`, e);}
            for (const e of uniqueFks.values()) {
                const t = tables.find(x => x.unid === e.srcTableUnid);
                const fk = t?.foreignKeys.find(f => f.unid === e.fkUnid);
                if (t && fk) {this._renderForeignKey(t, fk, tables);}
            }
        }

        /*
         * N:N lines connect the two outer tables, not the junction itself,
         * so a junction-table move doesn't change anchor sides — only an
         * outer-table move does.
         */
        const affectedNN = this._junctionConnections.filter(j =>
            j.outerAUnid === tableUnid || j.outerBUnid === tableUnid);
        if (affectedNN.length) {
            for (const j of affectedNN) {
                try {
                    jsp.deleteConnection(j.conn);
                } catch {
                    // already gone
                }
            }
            this._junctionConnections = this._junctionConnections.filter(j => !affectedNN.includes(j));
            for (const j of affectedNN) {
                const junction = tables.find(t => t.unid === j.junctionUnid);
                const fk1 = junction?.foreignKeys[0];
                const fk2 = junction?.foreignKeys[1];
                if (!junction || !fk1 || !fk2) {continue;}
                const outerA = tables.find(t => t.unid === fk1.refTableUnid);
                const outerB = tables.find(t => t.unid === fk2.refTableUnid);
                if (!outerA || !outerB) {continue;}
                const outerACol = outerA.columns.find(c => c.unid === fk1.columns[0]?.refColumnUnid);
                const outerBCol = outerB.columns.find(c => c.unid === fk2.columns[0]?.refColumnUnid);
                if (!outerACol || !outerBCol) {continue;}
                this._renderJunctionLine(junction, outerA, outerACol, outerB, outerBCol);
            }
        }
    }

    /**
     * Bind jsPlumb-level events once. Two responsibilities:
     *  1. drag-create: when the user drags from a column grip and drops
     *     on a column row, jsPlumb fires `connection` with `originalEvent`
     *     set. We delete the temp connection (it has no anchors/overlays
     *     yet) and prompt for FK details.
     *  2. click-to-edit: clicking a persisted connection opens the FK
     *     edit dialog (which also offers Delete).
     */
    private _bindJsPlumb(jsp: ReturnType<typeof getJsPlumbInstance>): void {
        jsp.bind('connection', (info: any, originalEvent: any) => {
            // programmatic — that's our render path
            if (!originalEvent) {return;}
            /*
             * Source/target selectors set `extract` in `jsPlumbInstance.ts`,
             * which calls `mergeParameters` on each endpoint with the
             * unids pulled from the matched DOM element. We read them off
             * here rather than trying to recover them from the connection's
             * source/target which point at the managed card elements.
             */
            const sParams = info.sourceEndpoint?.parameters ?? {};
            const tParams = info.targetEndpoint?.parameters ?? {};
            const draftConn = info.connection;
            /*
             * Tear down the draft line. jsPlumb is still finalising the
             * connection at this point (its post-fire code touches
             * `jpc.endpoints`), so deleting synchronously trips a null
             * deref. Defer to the next tick.
             */
            setTimeout((): void => {
                try {
                    jsp.deleteConnection(draftConn);
                } catch {
                    // already gone
                }
            }, 0);

            const sourceColUnid = sParams.columnUnid as string | undefined;
            const targetColUnid = tParams.columnUnid as string | undefined;
            const sourceTableUnid = sParams.tableUnid as string | undefined;
            const targetTableUnid = tParams.tableUnid as string | undefined;
            if (!sourceColUnid || !sourceTableUnid || !targetTableUnid) {return;}
            /*
             * No target column = dropped on the card header (the second
             * target-selector). Branch to the auto-column flow: create a
             * new column on the target table that mirrors the source's
             * type, then create the FK pointing at it.
             */
            if (!targetColUnid) {
                if (sourceTableUnid === targetTableUnid) {return;}
                this._handleFkDraftAutoColumn(sourceTableUnid, sourceColUnid, targetTableUnid);
                return;
            }
            if (sourceTableUnid === targetTableUnid && sourceColUnid === targetColUnid) {return;}
            this._handleFkDraft(sourceTableUnid, sourceColUnid, targetTableUnid, targetColUnid);
        });

        /*
         * Live anchor flip mid-drag. jsPlumb fires `drag:move` for every
         * pointer event during a card drag. We re-anchor the affected FK
         * lines on every animation frame (not every move event) so the
         * line follows the cursor without stutter and the anchor side
         * flips the moment the dragged card crosses the other's centre.
         *
         * `_pendingDragRerender` flag de-bounces the rAF call so a burst
         * of mousemove events still triggers at most one re-render per
         * frame.
         */
        let pendingDragRerender = false;
        let lastDraggedUnid: string | null = null;
        jsp.bind('drag:move', (payload: any) => {
            const el = payload?.el as HTMLElement | undefined;
            const unid = el?.dataset?.tableUnid;
            if (!unid) {return;}
            lastDraggedUnid = unid;
            if (pendingDragRerender) {return;}
            pendingDragRerender = true;
            requestAnimationFrame(() => {
                pendingDragRerender = false;
                if (lastDraggedUnid) {this._rerenderFksFor(lastDraggedUnid);}
            });
        });

        jsp.bind('click', (connection: any) => {
            const data = connection?.data as { fkUnid?: string; tableUnid?: string; fkName?: string; } | undefined;
            if (!data?.fkUnid || !data?.tableUnid) {return;}
            this._editFk(data.tableUnid, data.fkUnid);
        });
    }

    private async _handleFkDraft(srcTableUnid: string, srcColUnid: string, dstTableUnid: string, dstColUnid: string): Promise<void> {
        if (!this._activeProject) {return;}
        const all = this._collectAllTables(this._activeProject.data);
        const srcTable = all.find(t => t.unid === srcTableUnid);
        const dstTable = all.find(t => t.unid === dstTableUnid);
        if (!srcTable || !dstTable) {return;}
        const srcCol = srcTable.columns.find(c => c.unid === srcColUnid);
        const dstCol = dstTable.columns.find(c => c.unid === dstColUnid);
        if (!srcCol || !dstCol) {return;}

        const result = await new DbForeignKeyDialog(srcTable.name, srcCol.name, dstTable.name, dstCol.name).show();
        if (!result || result.kind !== 'save') {return;}

        await this._mutate(p => this._api.addForeignKey(p.unid, srcTableUnid, {
            name: result.name,
            refTableUnid: dstTableUnid,
            columns: [{ columnUnid: srcColUnid, refColumnUnid: dstColUnid }],
            onDelete: result.onDelete,
            onUpdate: result.onUpdate
        }));
        await this._reload();
    }

    /**
     * Card-drop variant: the FK draft was released onto the target card's
     * header rather than a column row, so the target column doesn't exist
     * yet. The dialog adds a "New target column" input pre-filled with a
     * sensible name; on Save we create the column (mirroring the source's
     * type, length, NOT NULL — never PK/AI/UNIQUE) and then the FK.
     *
     * If a column with the proposed name already exists on the target
     * table, we skip the addColumn step and just create the FK pointing
     * to the existing one — useful when the user dragged twice or the
     * column was already there for another reason.
     */
    private async _handleFkDraftAutoColumn(srcTableUnid: string, srcColUnid: string, dstTableUnid: string): Promise<void> {
        if (!this._activeProject) {return;}
        const all = this._collectAllTables(this._activeProject.data);
        const srcTable = all.find(t => t.unid === srcTableUnid);
        const dstTable = all.find(t => t.unid === dstTableUnid);
        if (!srcTable || !dstTable) {return;}
        const srcCol = srcTable.columns.find(c => c.unid === srcColUnid);
        if (!srcCol) {return;}

        const proposedName = `${srcTable.name}_${srcCol.name}`;
        const result = await new DbForeignKeyDialog(
            srcTable.name, srcCol.name,
            dstTable.name, proposedName,
            undefined,
            {proposedColumnName: proposedName}
        ).show();
        if (!result || result.kind !== 'save') {return;}
        const newColName = result.newColumnName?.trim();
        if (!newColName) {return;}

        const existing = dstTable.columns.find(c => c.name === newColName)?.unid;
        const dstColUnid = existing ?? await this._createAutoColumn(dstTableUnid, newColName, srcCol);
        if (!dstColUnid) {return;}

        await this._mutate(p => this._api.addForeignKey(p.unid, srcTableUnid, {
            name: result.name,
            refTableUnid: dstTableUnid,
            columns: [{columnUnid: srcColUnid, refColumnUnid: dstColUnid}],
            onDelete: result.onDelete,
            onUpdate: result.onUpdate
        }));
        await this._reload();
    }

    private async _createAutoColumn(dstTableUnid: string, name: string, srcCol: JsonColumn): Promise<string | undefined> {
        const colRes = await this._mutate(p => this._api.addColumn(p.unid, dstTableUnid, {
            name: name,
            type: srcCol.type,
            length: srcCol.length,
            notNull: srcCol.notNull
        }));
        return colRes?.data?.unid as string | undefined;
    }

    /**
     * Open the edit dialog for an existing FK. The dialog also has a
     * Delete button — picking it routes to the same confirmation +
     * remove path as before.
     */
    private async _editFk(tableUnid: string, fkUnid: string): Promise<void> {
        if (!this._activeProject) {return;}
        const all = this._collectAllTables(this._activeProject.data);
        const srcTable = all.find(t => t.unid === tableUnid);
        const fk = srcTable?.foreignKeys.find(f => f.unid === fkUnid);
        if (!srcTable || !fk) {return;}
        const dstTable = all.find(t => t.unid === fk.refTableUnid);
        if (!dstTable) {return;}
        const pair = fk.columns[0];
        if (!pair) {return;}
        const srcCol = srcTable.columns.find(c => c.unid === pair.columnUnid);
        const dstCol = dstTable.columns.find(c => c.unid === pair.refColumnUnid);
        if (!srcCol || !dstCol) {return;}

        const result = await new DbForeignKeyDialog(
            srcTable.name, srcCol.name, dstTable.name, dstCol.name,
            { name: fk.name, onDelete: fk.onDelete, onUpdate: fk.onUpdate }
        ).show();
        if (!result) {return;}

        if (result.kind === 'delete') {
            const ok = await ConfirmDialog.showConfirm('Delete foreign key',
                `Delete foreign key "${fk.name}"?`, 'danger');
            if (!ok) {return;}
            await this._mutate(p => this._api.removeForeignKey(p.unid, tableUnid, fkUnid));
            await this._reload();
            return;
        }

        // No-op if nothing actually changed.
        if (result.name === fk.name &&
            (result.onDelete ?? undefined) === (fk.onDelete ?? undefined) &&
            (result.onUpdate ?? undefined) === (fk.onUpdate ?? undefined)) {return;}

        await this._mutate(p => this._api.updateForeignKey(p.unid, tableUnid, fkUnid, {
            name: result.name,
            onDelete: result.onDelete,
            onUpdate: result.onUpdate
        }));
        await this._reload();
    }

    private _renderEmptyCanvas(title: string, hint: string): void {
        if (!this._grid) {return;}
        this._grid.querySelectorAll('.empty-state').forEach(e => e.remove());
        const wrap = document.createElement('div');
        wrap.className = 'empty-state';
        const t = document.createElement('strong');
        t.textContent = title;
        const h = document.createElement('span');
        h.textContent = hint;
        wrap.append(t, h);
        this._grid.append(wrap);
    }

    /*
     * -----------------------------------------------------------------
     * events
     * -----------------------------------------------------------------
     */

    private _wireTopbar(): void {
        this._wireMenubar();
        const undoBtn = document.getElementById('undoBtn') as HTMLButtonElement | null;
        const redoBtn = document.getElementById('redoBtn') as HTMLButtonElement | null;
        undoBtn?.addEventListener('click', () => this._undo());
        redoBtn?.addEventListener('click', () => this._redo());
        /*
         * Keyboard: Ctrl/Cmd + Z = undo; Ctrl/Cmd + Shift + Z = redo
         * (we also accept Ctrl + Y for redo, the legacy Windows shortcut).
         * Suppress when a text input is focused — the user is editing a
         * name and the browser's native undo should win.
         */
        window.addEventListener('keydown', (e: KeyboardEvent): void => {
            if (!(e.ctrlKey || e.metaKey)) {return;}
            if (this._isTextEditing(e.target)) {return;}
            const key = e.key.toLowerCase();
            if (key === 'z' && !e.shiftKey) {
                e.preventDefault();
                this._undo();
            } else if ((key === 'z' && e.shiftKey) || key === 'y') {
                e.preventDefault();
                this._redo();
            }
        });
    }

    /**
     * Refresh the topbar Undo/Redo buttons' enabled state from the
     * active project's undo/redo stack flags. Mirrors what the Edit
     * menu does at open time, but for the always-visible buttons it
     * has to be pushed on every reload (and every mutation that
     * shifts the stack depth).
     */
    private _renderUndoRedoButtons(): void {
        const undoBtn = document.getElementById('undoBtn') as HTMLButtonElement | null;
        const redoBtn = document.getElementById('redoBtn') as HTMLButtonElement | null;
        if (undoBtn) {undoBtn.disabled = !this._activeProject?.canUndo;}
        if (redoBtn) {redoBtn.disabled = !this._activeProject?.canRedo;}
    }

    /**
     * Wire each `.menubar-item` to open a context menu populated by
     * `_buildMenu`. The menu reads live state (canUndo/canRedo, NN
     * toggle, …) at open time, so we don't have to push state changes
     * back into the topbar after every reload.
     */
    private _wireMenubar(): void {
        const bar = document.getElementById('menubar');
        if (!bar) {return;}
        const items = bar.querySelectorAll<HTMLButtonElement>('.menubar-item');
        for (const btn of Array.from(items)) {
            const name = btn.dataset.menu ?? '';
            btn.addEventListener('click', (e): void => {
                e.stopPropagation();
                btn.classList.add('menubar-item--open');
                const menu = this._buildMenu(name);
                openContextMenu(btn, menu);
                /*
                 * Strip the open-state class once the menu closes.
                 * `openContextMenu` doesn't expose a close callback,
                 * so we observe the menu's removal from the DOM via
                 * a small MutationObserver on body — cheap because
                 * only one menu can be open at a time.
                 */
                const obs = new MutationObserver((): void => {
                    if (!document.querySelector('.context-menu')) {
                        btn.classList.remove('menubar-item--open');
                        obs.disconnect();
                    }
                });
                obs.observe(document.body, {childList: true});
            });
        }
    }

    private _buildMenu(name: string): ContextMenuItem[] {
        const canUndo = Boolean(this._activeProject?.canUndo);
        const canRedo = Boolean(this._activeProject?.canRedo);
        switch (name) {
            case 'file':
                return [
                    {label: 'Import JSON…', onClick: (): void => this._importSchema()},
                    {label: 'Export JSON', onClick: (): void => this._exportSchema()},
                    {kind: 'separator'},
                    {label: 'Import .mwb…', onClick: (): void => this._importMwb()},
                    {label: 'Export .mwb', onClick: (): void => this._exportMwb()}
                ];
            case 'edit':
                return [
                    {label: 'Undo', hint: 'Ctrl+Z', disabled: !canUndo, onClick: (): void => this._undo()},
                    {label: 'Redo', hint: 'Ctrl+Shift+Z', disabled: !canRedo, onClick: (): void => this._redo()}
                ];
            case 'insert':
                return [
                    {label: 'Add Table…', onClick: (): void => { this._addTablePrompt().catch((err: unknown): void => console.error('[DbEditor] add table failed:', err)); }},
                    {label: 'Add View…', onClick: (): void => { this._addViewPrompt().catch((err: unknown): void => console.error('[DbEditor] add view failed:', err)); }},
                    {label: 'Add Enum…', onClick: (): void => { this._addEnumPrompt().catch((err: unknown): void => console.error('[DbEditor] add enum failed:', err)); }},
                    {label: 'Add Routine…', onClick: (): void => { this._addRoutinePrompt().catch((err: unknown): void => console.error('[DbEditor] add routine failed:', err)); }},
                    {kind: 'separator'},
                    {label: 'Add Folder…', onClick: (): void => { this._addFolderPrompt().catch((err: unknown): void => console.error('[DbEditor] add folder failed:', err)); }},
                    {label: 'Add EER diagram…', onClick: (): void => { this._addLayerPrompt().catch((err: unknown): void => console.error('[DbEditor] add EER diagram failed:', err)); }}
                ];
            case 'view':
                return [
                    {label: 'Arrange tables by FK', onClick: (): void => this._arrange()},
                    {
                        label: this._showJunctionLines ? 'Hide N:N relations' : 'Show N:N relations',
                        onClick: (): void => this._toggleNN()
                    }
                ];
            case 'generate':
                return [
                    {label: 'Generate SQL', onClick: (): void => this._generate()},
                    {
                        label: 'Copy selected SQL',
                        hint: 'Ctrl+Shift+C',
                        onClick: (): void => {
                            this._copySelectionSql().catch((err: unknown): void => console.error('[DbEditor] copy SQL failed:', err));
                        }
                    },
                    {kind: 'separator'},
                    {
                        label: 'Generate docs (Markdown)',
                        onClick: (): void => {
                            this._generateDocs(false).catch((err: unknown): void => console.error('[DbEditor] generate docs failed:', err));
                        }
                    },
                    {
                        label: 'Preview docs',
                        onClick: (): void => {
                            this._generateDocs(true).catch((err: unknown): void => console.error('[DbEditor] preview docs failed:', err));
                        }
                    }
                ];
            case 'project':
                return [
                    {
                        label: 'Project info…',
                        onClick: (): void => {
                            this._openProjectInfo().catch((err: unknown): void => console.error('[DbEditor] info failed:', err));
                        }
                    },
                    {
                        label: 'Project settings…',
                        onClick: (): void => {
                            this._openProjectSettings().catch((err: unknown): void => console.error('[DbEditor] settings failed:', err));
                        }
                    },
                    {kind: 'separator'},
                    {
                        label: 'Edit project…',
                        onClick: (): void => {
                            this._editProject().catch((err: unknown): void => console.error('[DbEditor] edit-project failed:', err));
                        }
                    },
                    {
                        label: 'Add project…',
                        onClick: (): void => {
                            this._addProject().catch((err: unknown): void => console.error('[DbEditor] add-project failed:', err));
                        }
                    },
                    {
                        label: 'Remove project…',
                        danger: true,
                        onClick: (): void => {
                            this._removeProject().catch((err: unknown): void => console.error('[DbEditor] remove-project failed:', err));
                        }
                    }
                ];
            case 'help':
                return [
                    {
                        label: 'Keyboard shortcuts…',
                        hint: '?',
                        onClick: (): void => {
                            new ShortcutHelpDialog().show().catch((err: unknown): void => console.error('[DbEditor] help failed:', err));
                        }
                    }
                ];
            default:
                return [];
        }
    }

    /**
     * Flip the "show N:N relationship lines" toggle and persist it.
     * Used by the View menu — the bare-button affordance has been
     * folded into the menubar.
     */
    private _toggleNN(): void {
        this._showJunctionLines = !this._showJunctionLines;
        localStorage.setItem('dbeditor.showNN', this._showJunctionLines ? '1' : '0');
        this._renderCanvas();
    }

    private _undo(): void {
        if (!this._activeProject) {return;}
        this._mutate(p => this._api.undo(p.unid))
        .then(async(res): Promise<void> => {
            if (!res) {return;}
            await this._reload();
        })
        .catch((err: unknown): void => console.error('[DbEditor] undo failed:', err));
    }

    private _redo(): void {
        if (!this._activeProject) {return;}
        this._mutate(p => this._api.redo(p.unid))
        .then(async(res): Promise<void> => {
            if (!res) {return;}
            await this._reload();
        })
        .catch((err: unknown): void => console.error('[DbEditor] redo failed:', err));
    }

    private _wireEvents(): void {
        window.addEventListener(EditorEvents.activateContainer, (e) => {
            const unid = (e as CustomEvent).detail.unid;
            // only switch if it's actually a container (database/folder) in our tree
            const c = this._activeProject ? this._findContainer(this._activeProject.data, unid) : null;
            if (c) {
                this._activeContainerUnid = unid;
                /* Switching containers always clears the layer scope. */
                this._activeLayerUnid = null;
                this._renderCanvas();
            }
        });
        window.addEventListener(EditorEvents.scopeToLayer, (e) => {
            const {layerUnid, containerUnid} = (e as CustomEvent).detail as {layerUnid: string; containerUnid: string;};
            const c = this._activeProject ? this._findContainer(this._activeProject.data, containerUnid) : null;
            if (!c) {return;}
            this._activeContainerUnid = containerUnid;
            this._activeLayerUnid = layerUnid;
            this._renderCanvas();
        });
        window.addEventListener(EditorEvents.focusTable, (e) => {
            const { tableUnid, containerUnid } = (e as CustomEvent).detail as { tableUnid: string; containerUnid?: string; };
            this._focusTable(tableUnid, containerUnid);
            /*
             * Treeview navigation always replaces — focusing a specific
             * table from the sidebar isn't a multi-select gesture.
             */
            this._selectOne(tableUnid);
        });
        window.addEventListener(EditorEvents.selectTable, (e) => {
            const detail = (e as CustomEvent).detail as { tableUnid?: string | null; additive?: boolean; toggle?: boolean; };
            const unid = detail?.tableUnid ?? null;
            let mode: 'replace' | 'add' | 'toggle' = 'replace';
            if (detail?.toggle) {mode = 'toggle';}
            else if (detail?.additive) {mode = 'add';}
            /*
             * Shift/Ctrl-click on an *already-selected* card with no
             * modifier-aware intent (i.e. a plain replace re-click) is a
             * no-op so the user's existing multi-selection isn't blown
             * away just because they re-clicked one of its members during
             * a drag-start gesture.
             */
            if (mode === 'replace' && unid && this._selectedTableUnids.has(unid) && this._selectedTableUnids.size > 1) {
                return;
            }
            this._setSelection(unid, mode);
        });
        window.addEventListener(EditorEvents.tableMoved, (e) => {
            const { tableUnid, x, y } = (e as CustomEvent).detail;
            this._rerenderFksFor(tableUnid);
            const current = this._findTableInProject(tableUnid);
            if (!current) {return;}

            /*
             * Drag commit splits three ways:
             *
             *   1) Layer-scoped view: write to the placement entry
             *      for the active diagram. If active diagram is the
             *      primary one (`t.layerUnid === activeLayer`), top-
             *      level `pos` is the canonical home; otherwise we
             *      append/replace the matching placement entry.
             *
             *   2) Unscoped view + drop-on-diagram: if the new
             *      position falls inside a diagram rectangle the
             *      table isn't yet in, add a placement at that
             *      position (multi-membership). The home `pos` ALSO
             *      moves — that's what the user dragged.
             *
             *   3) Unscoped view, no diagram under cursor: just
             *      move `pos`. Doesn't change membership.
             */
            const activeLayer = this._activeLayerUnid;
            if (activeLayer) {
                if (current.layerUnid === activeLayer) {
                    this._mutate(p => this._api.updateTable(p.unid, tableUnid, {pos: {x: x, y: y}}));
                } else {
                    const nextPlacements = DbEditor._upsertPlacement(current.layerPlacements ?? [], activeLayer, {x: x, y: y});
                    this._mutate(p => this._api.updateTable(p.unid, tableUnid, {layerPlacements: nextPlacements}));
                }
                return;
            }

            const droppedOn = this._layerAtPoint(x, y);
            const patch: {pos: {x: number; y: number;}; layerPlacements?: {layerUnid: string; pos: {x: number; y: number;};}[];} = { pos: { x: x, y: y } };
            if (droppedOn && current.layerUnid !== droppedOn) {
                /*
                 * Multi-diagram add: instead of overwriting the
                 * primary `layerUnid`, append a placement for the
                 * dropped-on diagram (existing primary stays). If a
                 * placement for this diagram already exists, update
                 * its pos. This gives the user MWB-style "same table
                 * in two diagrams" behaviour without clobbering the
                 * primary home view.
                 */
                patch.layerPlacements = DbEditor._upsertPlacement(current.layerPlacements ?? [], droppedOn, {x: x, y: y});
            }
            this._mutate(p => this._api.updateTable(p.unid, tableUnid, patch));
        });
        window.addEventListener(EditorEvents.viewMoved, (e) => {
            const { viewUnid, x, y } = (e as CustomEvent).detail;
            this._mutate(p => this._api.updateView(p.unid, viewUnid, { pos: { x: x, y: y } }));
        });
        window.addEventListener(EditorEvents.generateScoped, (e) => {
            const detail = (e as CustomEvent).detail as {
                databaseUnid?: string;
                tableUnid?: string;
                layerUnid?: string;
                layerName?: string;
            };
            this._generateScoped(detail).catch((err: unknown): void => console.error('[DbEditor] scoped generate failed:', err));
        });
        window.addEventListener(EditorEvents.deleteTable, (e) => {
            const { tableUnid } = (e as CustomEvent).detail;
            this._mutate(p => this._api.deleteTable(p.unid, tableUnid)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.duplicateTable, (e) => {
            const { tableUnid } = (e as CustomEvent).detail;
            this._mutate(p => this._api.duplicateTable(p.unid, tableUnid))
            .then(async(res): Promise<void> => {
                if (!res) {return;}
                await this._reload();
                /*
                 * Switch the canvas selection to the clone so the user
                 * sees where it landed and can immediately rename it
                 * via F2 if they want.
                 */
                const newUnid = (res as {data?: {unid?: string;};}).data?.unid;
                if (newUnid) {this._selectOne(newUnid);}
            });
        });
        window.addEventListener(EditorEvents.renameTable, (e) => {
            const { tableUnid, name } = (e as CustomEvent).detail;
            this._mutate(p => this._api.updateTable(p.unid, tableUnid, { name: name })).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.editTableOptions, (e) => {
            const { tableUnid } = (e as CustomEvent).detail;
            this._editTableOptions(tableUnid);
        });
        window.addEventListener(EditorEvents.addColumn, (e) => {
            const { tableUnid, column } = (e as CustomEvent).detail;
            this._mutate(p => this._api.addColumn(p.unid, tableUnid, column)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.updateColumn, (e) => {
            const { tableUnid, columnUnid, patch } = (e as CustomEvent).detail;
            this._mutate(p => this._api.updateColumn(p.unid, tableUnid, columnUnid, patch)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.removeColumn, (e) => {
            const { tableUnid, columnUnid } = (e as CustomEvent).detail;
            this._mutate(p => this._api.removeColumn(p.unid, tableUnid, columnUnid)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.addIndex, (e) => {
            const { tableUnid, index } = (e as CustomEvent).detail;
            this._mutate(p => this._api.addIndex(p.unid, tableUnid, index)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.updateIndex, (e) => {
            const { tableUnid, indexUnid, patch } = (e as CustomEvent).detail;
            this._mutate(p => this._api.updateIndex(p.unid, tableUnid, indexUnid, patch)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.removeIndex, (e) => {
            const { tableUnid, indexUnid } = (e as CustomEvent).detail;
            this._mutate(p => this._api.removeIndex(p.unid, tableUnid, indexUnid)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.reorderColumn, (e) => {
            const { tableUnid, columnUnid, beforeColumnUnid } = (e as CustomEvent).detail;
            const order = this._buildReorderedColumnOrder(tableUnid, columnUnid, beforeColumnUnid);
            if (!order) {return;}
            this._mutate(p => this._api.reorderColumns(p.unid, tableUnid, order)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.createContainer, (e) => {
            const { parentUnid, type, name } = (e as CustomEvent).detail;
            this._mutate(p => this._api.createContainer(p.unid, parentUnid, name, type)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.renameContainer, (e) => {
            const { unid, name } = (e as CustomEvent).detail;
            this._mutate(p => this._api.updateContainer(p.unid, unid, { name: name })).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.deleteContainer, (e) => {
            const { unid } = (e as CustomEvent).detail;
            /*
             * If the deleted container was the active one, clear the
             * selection so _reload picks the first remaining database.
             */
            if (this._activeContainerUnid === unid) {this._activeContainerUnid = null;}
            this._mutate(p => this._api.deleteContainer(p.unid, unid)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.createTableIn, (e) => {
            const { containerUnid, name } = (e as CustomEvent).detail;
            this._mutate(p => this._api.createTable(p.unid, containerUnid, name, { x: 80, y: 80 })).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.createEnumIn, (e) => {
            const { containerUnid, name } = (e as CustomEvent).detail;
            this._mutate(p => this._api.createEnum(p.unid, containerUnid, name, { x: 80, y: 80 })).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.assignTableToLayer, (e) => {
            const { tableUnid, layerUnid } = (e as CustomEvent).detail as {tableUnid: string; layerUnid: string;};
            const current = this._findTableInProject(tableUnid);
            /*
             * Multi-diagram-aware drop semantics:
             *   - no primary yet  → set this as the primary
             *   - same as primary → no-op (drag onto own diagram)
             *   - already a placement for it → no-op (already member)
             *   - otherwise → ADD placement (table becomes member of
             *     a second diagram, primary stays intact)
             */
            if (!current) {return;}
            if (!current.layerUnid) {
                this._mutate(p => this._api.updateTable(p.unid, tableUnid, {layerUnid: layerUnid})).then(() => this._reload());
                return;
            }
            if (current.layerUnid === layerUnid) {return;}
            if ((current.layerPlacements ?? []).some(p => p.layerUnid === layerUnid)) {return;}
            const nextPlacements = DbEditor._upsertPlacement(current.layerPlacements ?? [], layerUnid, current.pos);
            this._mutate(p => this._api.updateTable(p.unid, tableUnid, {layerPlacements: nextPlacements})).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.removeTableFromLayer, (e) => {
            const { tableUnid, layerUnid } = (e as CustomEvent).detail as {tableUnid: string; layerUnid: string;};
            const current = this._findTableInProject(tableUnid);
            if (!current) {return;}
            /*
             * Symmetric to assignTableToLayer: take whichever membership
             * exists (primary, placement, or both) and clear it. The
             * table remains in the model and still renders unscoped; it
             * just no longer belongs to this EER diagram. We patch only
             * the fields that change so we don't accidentally clobber
             * concurrent edits to the rest of the table.
             */
            const patch: {layerUnid?: string | null; layerPlacements?: {layerUnid: string; pos: {x: number; y: number;};}[];} = {};
            if (current.layerUnid === layerUnid) {
                patch.layerUnid = '';
            }
            const placements = current.layerPlacements ?? [];
            if (placements.some(p => p.layerUnid === layerUnid)) {
                patch.layerPlacements = placements.filter(p => p.layerUnid !== layerUnid);
            }
            if (patch.layerUnid === undefined && patch.layerPlacements === undefined) {return;}
            this._mutate(p => this._api.updateTable(p.unid, tableUnid, patch as Record<string, unknown>))
            .then(() => this._reload());
        });
        window.addEventListener(EditorEvents.createLayerIn, (e) => {
            const { containerUnid, name } = (e as CustomEvent).detail;
            /*
             * Default-size diagram positioned at (80,80) — same shape as
             * Insert-menu's "Add EER diagram", so the user lands a
             * standard 400×300 backdrop regardless of how they invoked
             * the creation.
             */
            this._mutate(p => this._api.createLayer(p.unid, containerUnid, name, {
                pos: {x: 80, y: 80},
                width: 400,
                height: 300
            })).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.renameEnum, (e) => {
            const { unid, name } = (e as CustomEvent).detail;
            this._mutate(p => this._api.updateEnum(p.unid, unid, { name: name })).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.deleteEnum, (e) => {
            const { unid } = (e as CustomEvent).detail;
            this._mutate(p => this._api.deleteEnum(p.unid, unid)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.editEnum, (e) => {
            const { unid } = (e as CustomEvent).detail;
            this._editEnum(unid);
        });
        window.addEventListener(EditorEvents.createViewIn, (e) => {
            const { containerUnid, name } = (e as CustomEvent).detail;
            this._mutate(p => this._api.createView(p.unid, containerUnid, name, { x: 80, y: 80 })).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.renameView, (e) => {
            const { unid, name } = (e as CustomEvent).detail;
            this._mutate(p => this._api.updateView(p.unid, unid, { name: name })).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.deleteView, (e) => {
            const { unid } = (e as CustomEvent).detail;
            this._mutate(p => this._api.deleteView(p.unid, unid)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.editView, (e) => {
            const { unid } = (e as CustomEvent).detail;
            this._editView(unid);
        });
        window.addEventListener(EditorEvents.createRoutineIn, (e) => {
            const { containerUnid, name, kind } = (e as CustomEvent).detail;
            this._mutate(p => this._api.createRoutine(p.unid, containerUnid, name, kind, { x: 80, y: 80 })).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.renameRoutine, (e) => {
            const { unid, name } = (e as CustomEvent).detail;
            this._mutate(p => this._api.updateRoutine(p.unid, unid, { name: name })).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.deleteRoutine, (e) => {
            const { unid } = (e as CustomEvent).detail;
            this._mutate(p => this._api.deleteRoutine(p.unid, unid)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.editRoutine, (e) => {
            const { unid } = (e as CustomEvent).detail;
            this._editRoutine(unid);
        });
        window.addEventListener(EditorEvents.renameLayer, (e) => {
            const { unid, name } = (e as CustomEvent).detail;
            this._mutate(p => this._api.updateLayer(p.unid, unid, { name: name })).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.deleteLayer, (e) => {
            const { unid } = (e as CustomEvent).detail;
            this._mutate(p => this._api.deleteLayer(p.unid, unid)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.pickLayerForTables, (e) => {
            const { tableUnids } = (e as CustomEvent).detail as {tableUnids: string[];};
            this._pickLayerForTables(tableUnids).catch((err: unknown): void => console.error('[DbEditor] layer pick failed:', err));
        });
        window.addEventListener(EditorEvents.pickLayerForView, (e) => {
            const { viewUnid } = (e as CustomEvent).detail as {viewUnid: string;};
            this._pickLayerForView(viewUnid).catch((err: unknown): void => console.error('[DbEditor] view layer pick failed:', err));
        });
        window.addEventListener(EditorEvents.removeViewFromLayer, (e) => {
            const { viewUnid, layerUnid } = (e as CustomEvent).detail as {viewUnid: string; layerUnid: string;};
            const view = this._findViewInProject(viewUnid);
            if (!view || view.layerUnid !== layerUnid) {return;}
            this._mutate(p => this._api.updateView(p.unid, viewUnid, {layerUnid: ''}))
            .then(() => this._reload());
        });
        window.addEventListener(EditorEvents.addForeignKey, (e) => {
            const { tableUnid, fk } = (e as CustomEvent).detail;
            this._mutate(p => this._api.addForeignKey(p.unid, tableUnid, fk)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.removeForeignKey, (e) => {
            const { tableUnid, fkUnid } = (e as CustomEvent).detail;
            this._mutate(p => this._api.removeForeignKey(p.unid, tableUnid, fkUnid)).then(() => this._reload());
        });
        window.addEventListener(EditorEvents.reload, () => { this._reload(); });

        window.addEventListener(EditorEvents.refreshLive, async(e) => {
            const databaseUnid = (e as CustomEvent).detail?.databaseUnid;
            if (!this._activeProject || !databaseUnid) {return;}
            try {
                const res = await this._api.refreshLive(this._activeProject.unid, databaseUnid);
                this._liveByDatabaseUnid.set(databaseUnid, res.data as JsonDataDB);
                this._renderTreeview();
            } catch (err) {
                await AlertDialog.showAlert('Refresh failed', String(err));
            }
        });

        window.addEventListener(EditorEvents.openSyncDialog, async(e) => {
            if (!this._activeProject) {return;}
            const detail = (e as CustomEvent).detail ?? {};
            let databaseUnid = detail.databaseUnid as string | undefined;
            const layerUnid = typeof detail.layerUnid === 'string' && detail.layerUnid !== '' ? detail.layerUnid : undefined;
            const layerName = typeof detail.layerName === 'string' ? detail.layerName : undefined;
            /*
             * Layer-scoped dispatch from the treeview's layer ⋯ menu
             * doesn't supply `databaseUnid` (the menu doesn't know
             * which database the layer belongs to). Resolve it by
             * walking the project tree to find the database whose
             * `layers[]` contains this unid.
             */
            if (!databaseUnid && layerUnid) {
                const dbFound = this._findDatabaseOfLayer(this._activeProject.data, layerUnid);
                if (dbFound) {databaseUnid = dbFound.unid;}
            }
            if (!databaseUnid) {return;}
            /*
             * Reject layer-scoped sync if the parent database has no
             * connection — preview would 400 with "no live connection
             * configured" which is a confusing path to discovery.
             */
            if (!this._activeProject.connectableDatabaseUnids.includes(databaseUnid)) {
                await AlertDialog.showAlert(
                    'No connection configured',
                    'This database has no live connection in dbeditor.json. Open Project info → Add connection to set one up.'
                );
                return;
            }
            const container = this._findContainer(this._activeProject.data, databaseUnid);
            const label = container?.name ?? databaseUnid;
            const dlg = new SyncDialog(this._api, this._activeProject.unid, databaseUnid, label, layerUnid, layerName);
            await dlg.show();
        });

        window.addEventListener(EditorEvents.openDatabaseProperties, async(e) => {
            if (!this._activeProject) {return;}
            const unid = (e as CustomEvent).detail?.unid as string | undefined;
            if (!unid) {return;}
            const container = this._findContainer(this._activeProject.data, unid);
            if (!container || container.type !== JsonDataDBType.database) {return;}
            const patch = await new DatabasePropertiesDialog(container.name, {
                defaultEngine: container.defaultEngine,
                defaultCharset: container.defaultCharset,
                defaultCollation: container.defaultCollation
            }).show();
            if (!patch) {return;}
            if (Object.keys(patch).length === 0) {return;}
            try {
                await this._api.updateDatabaseDefaults(this._activeProject.unid, unid, patch);
                await this._reload();
            } catch (err) {
                await AlertDialog.showAlert('Update failed', String((err as Error).message ?? err));
            }
        });
    }

    /*
     * --------- canvas zoom ---------
     * The visible scale is applied to `#dbgrid-zoom` (the inner wrapper)
     * via CSS transform; jsPlumb's setZoom() keeps drag math + anchor
     * coordinates in the *unscaled* coordinate system. Persistence rides
     * on the existing `editor.zoom` field, debounced by the auto-save
     * indicator path like every other editor-settings mutation.
     */
    private _wireZoomControls(): void {
        const out = document.getElementById('zoomOutBtn') as HTMLButtonElement | null;
        const reset = document.getElementById('zoomResetBtn') as HTMLButtonElement | null;
        const inn = document.getElementById('zoomInBtn') as HTMLButtonElement | null;
        const fit = document.getElementById('zoomFitBtn') as HTMLButtonElement | null;
        if (!out || !reset || !inn) {return;}
        this._zoomLabel = reset;
        out.addEventListener('click', () => this._stepZoom(-1));
        inn.addEventListener('click', () => this._stepZoom(1));
        reset.addEventListener('click', () => this._setZoom(ZOOM_DEFAULT, true));
        fit?.addEventListener('click', () => this._fitToView());
        this._wireWheelZoom();
        this._wireMiddleMousePan();
    }

    /**
     * Fit every visible card (tables + views + layers) into the
     * viewport. Computes the unscaled-canvas bbox by walking the
     * tracker maps + the layer DOM, picks the largest zoom that
     * fits with a 40px padding margin, then scrolls to centre the
     * bbox in the visible area. No-op when there's nothing to
     * frame (empty canvas).
     */
    private _fitToView(): void {
        if (!this._grid || !this._zoomLayer) {return;}
        const PAD = 40;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const observe = (el: HTMLElement): void => {
            const left = el.offsetLeft;
            const top = el.offsetTop;
            const right = left + el.offsetWidth;
            const bottom = top + el.offsetHeight;
            if (left < minX) {minX = left;}
            if (top < minY) {minY = top;}
            if (right > maxX) {maxX = right;}
            if (bottom > maxY) {maxY = bottom;}
        };
        for (const card of this._tables.values()) {observe(card.element);}
        for (const card of this._views.values()) {observe(card.element);}
        this._zoomLayer.querySelectorAll<HTMLElement>('.db-layer').forEach(observe);
        if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {return;}

        const bboxW = (maxX - minX) + (2 * PAD);
        const bboxH = (maxY - minY) + (2 * PAD);
        const viewW = this._grid.clientWidth;
        const viewH = this._grid.clientHeight;
        const scale = Math.min(viewW / bboxW, viewH / bboxH);
        const next = clampZoom(snapToStep(scale));
        this._setZoom(next, true);

        /*
         * Centre the bbox in the viewport. After setZoom the wrapper's
         * dimensions reflect `unscaledExtent × next + pad`, so scroll
         * coordinates are in scaled (visible) pixels.
         */
        const centreX = ((minX + maxX) / 2) * next;
        const centreY = ((minY + maxY) / 2) * next;
        this._grid.scrollLeft = Math.max(0, centreX - (viewW / 2));
        this._grid.scrollTop = Math.max(0, centreY - (viewH / 2));
    }

    /*
     * Ctrl + wheel on the canvas zooms around the cursor. Without Ctrl,
     * the wheel falls through to the browser's native scroll. We snap the
     * new zoom onto the step ladder so successive wheel turns land on
     * round percentages — same end state as clicking the +/- buttons.
     */
    private _wireWheelZoom(): void {
        if (!this._grid) {return;}
        this._grid.addEventListener('wheel', (e: WheelEvent): void => {
            if (!e.ctrlKey) {return;}
            if (!this._grid) {return;}
            e.preventDefault();
            const direction: 1 | -1 = e.deltaY < 0 ? 1 : -1;
            const next = snapToStep(stepZoom(this._zoomLevel, direction));
            if (next === this._zoomLevel) {return;}
            const rect = this._grid.getBoundingClientRect();
            const cursorX = e.clientX - rect.left;
            const cursorY = e.clientY - rect.top;
            const target = zoomFocalScroll(
                this._zoomLevel, next,
                cursorX, cursorY,
                this._grid.scrollLeft, this._grid.scrollTop
            );
            this._setZoom(next, true);
            /*
             * Apply the new scroll after setZoom so the wrapper's new
             * dimensions are already in place when we adjust scroll.
             * Browser clamps out-of-range values silently.
             */
            this._grid.scrollLeft = target.scrollX;
            this._grid.scrollTop = target.scrollY;
        }, {passive: false});
    }

    /*
     * Middle-mouse drag — or space-held + primary-button drag — pans the
     * canvas. Standard vector-tool affordance; we don't add a dedicated
     * "Hand" mode because the schema editor is rarely large enough to
     * need a persistent pan mode.
     */
    /*
     * Rubber-band rectangle selection: drag from the canvas background
     * to select every table card whose bounding rect intersects the
     * rubber-band. Shift extends the selection, Ctrl/Cmd toggles, neither
     * replaces. A plain click (no movement past `MOVE_THRESHOLD`) clears
     * the selection — same affordance as before, just deferred to mouseup.
     *
     * All measurements use viewport (`getBoundingClientRect`) coordinates,
     * so the zoom transform on `#dbgrid-zoom` is honoured automatically.
     */
    private _wireRubberBand(): void {
        if (!this._grid) {return;}
        const grid = this._grid;
        const MOVE_THRESHOLD = 4;
        let startX = 0;
        let startY = 0;
        let active = false;
        let bandEl: HTMLDivElement | null = null;
        let downModifiers = {shift: false, toggle: false, alt: false};

        const removeBand = (): void => {
            if (bandEl) {
                bandEl.remove();
                bandEl = null;
            }
        };
        const ensureBand = (): HTMLDivElement => {
            if (bandEl) {return bandEl;}
            const el = document.createElement('div');
            el.className = downModifiers.alt ? 'rubber-band rubber-band--layer' : 'rubber-band';
            document.body.append(el);
            bandEl = el;
            return el;
        };

        grid.addEventListener('mousedown', (e: MouseEvent): void => {
            if (e.target !== grid) {return;}
            if (e.button !== 0) {return;}
            /*
             * The pan handler also listens on grid mousedown; pan gestures
             * are middle-button or space+primary and we don't want to
             * fight them. Pan handler returns immediately when those
             * conditions aren't met, so this branch is safe to ride on
             * the same event.
             */
            startX = e.clientX;
            startY = e.clientY;
            active = false;
            downModifiers = {shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey, alt: e.altKey};
        });

        window.addEventListener('mousemove', (e: MouseEvent): void => {
            if (e.buttons === 0) {return;}
            if (startX === 0 && startY === 0 && !active) {return;}
            const dx = Math.abs(e.clientX - startX);
            const dy = Math.abs(e.clientY - startY);
            if (!active && (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD)) {
                active = true;
            }
            if (!active) {return;}
            const rect = rectFromCorners({x: startX, y: startY}, {x: e.clientX, y: e.clientY});
            const el = ensureBand();
            el.style.left = `${rect.left}px`;
            el.style.top = `${rect.top}px`;
            el.style.width = `${rect.right - rect.left}px`;
            el.style.height = `${rect.bottom - rect.top}px`;
        });

        window.addEventListener('mouseup', (e: MouseEvent): void => {
            if (e.button !== 0) {return;}
            if (!active) {
                /*
                 * Plain click with no drag: only meaningful when the user
                 * actually clicked on the grid background. We reset the
                 * tracking state and clear selection.
                 */
                if (startX !== 0 || startY !== 0) {
                    startX = 0;
                    startY = 0;
                    /*
                     * Don't blow away the selection if Shift or Ctrl is
                     * held — those modifiers are "I want to keep current".
                     */
                    if (!downModifiers.shift && !downModifiers.toggle) {
                        this._setSelection(null);
                    }
                }
                return;
            }
            const bandRect = rectFromCorners({x: startX, y: startY}, {x: e.clientX, y: e.clientY});
            const wasAlt = downModifiers.alt;
            removeBand();
            startX = 0;
            startY = 0;
            active = false;

            if (wasAlt) {
                /*
                 * Alt+drag = sketch a new layer. Translate the
                 * viewport-coords bbox into canvas coords (subtract
                 * the zoom-layer's screen rect, divide by zoom) so
                 * the new layer lands exactly under the gesture. No
                 * selection change.
                 */
                this._createLayerFromBand(bandRect);
                return;
            }

            /* Replace mode clears first; add/toggle extend the existing selection. */
            let mode: 'replace' | 'add' | 'toggle' = 'replace';
            if (downModifiers.toggle) {mode = 'toggle';}
            else if (downModifiers.shift) {mode = 'add';}
            if (mode === 'replace') {this._setSelection(null);}

            for (const card of this._tables.values()) {
                const cardRect = card.element.getBoundingClientRect();
                if (!rectsIntersect(bandRect, cardRect)) {continue;}
                this._setSelection(card.unid, mode === 'replace' ? 'add' : mode);
            }
        });
    }

    /**
     * Create a layer from a viewport-coords rubber-band rectangle
     * sketched with Alt+drag. We round to integer canvas coords +
     * enforce a minimum size so a tiny drag doesn't silently produce
     * a sub-60px layer the user can't see. Pre-fills the prompt with
     * "New Layer" — the user types a name and the layer appears.
     */
    private _createLayerFromBand(bandRect: {left: number; top: number; right: number; bottom: number;}): void {
        if (!this._activeProject || !this._activeContainerUnid) {return;}
        const z = this._zoomLayer;
        if (!z) {return;}
        const zr = z.getBoundingClientRect();
        const zoom = this._zoomLevel || 1;
        const x = Math.round((bandRect.left - zr.left) / zoom);
        const y = Math.round((bandRect.top - zr.top) / zoom);
        const w = Math.max(60, Math.round((bandRect.right - bandRect.left) / zoom));
        const h = Math.max(60, Math.round((bandRect.bottom - bandRect.top) / zoom));
        InputDialog.showInput('New EER diagram', 'Diagram name', 'New diagram').then(name => {
            if (!name) {return;}
            this._mutate(p => this._api.createLayer(p.unid, this._activeContainerUnid!, name, {
                pos: {x: x, y: y},
                width: w,
                height: h
            })).then(() => this._reload());
        }).catch((err: unknown): void => console.error('[DbEditor] layer create failed:', err));
    }

    private _wireMiddleMousePan(): void {
        if (!this._grid) {return;}
        const grid = this._grid;
        let panning = false;
        let lastX = 0;
        let lastY = 0;
        let spaceHeld = false;

        window.addEventListener('keydown', (e: KeyboardEvent): void => {
            if (e.code === 'Space' && !this._isTextEditing(e.target)) {spaceHeld = true;}
        });
        window.addEventListener('keyup', (e: KeyboardEvent): void => {
            if (e.code === 'Space') {spaceHeld = false;}
        });

        grid.addEventListener('mousedown', (e: MouseEvent): void => {
            const isPanGesture = e.button === 1 || (e.button === 0 && spaceHeld && e.target === grid);
            if (!isPanGesture) {return;}
            e.preventDefault();
            panning = true;
            lastX = e.clientX;
            lastY = e.clientY;
            grid.style.cursor = 'grabbing';
        });
        window.addEventListener('mousemove', (e: MouseEvent): void => {
            if (!panning) {return;}
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            grid.scrollLeft -= dx;
            grid.scrollTop -= dy;
        });
        window.addEventListener('mouseup', (): void => {
            if (!panning) {return;}
            panning = false;
            grid.style.cursor = '';
        });
    }

    private _stepZoom(direction: 1 | -1): void {
        this._setZoom(stepZoom(this._zoomLevel, direction), true);
    }

    private _setZoom(level: number, persist: boolean): void {
        const next = clampZoom(level);
        this._zoomLevel = next;
        if (this._zoomLayer) {
            this._zoomLayer.style.transform = isAtDefault(next) ? '' : `scale(${next})`;
        }
        this._applyCanvasExtent();
        try {
            getJsPlumbInstance().setZoom(next);
        } catch (err) {
            console.error('[DbEditor] jsPlumb setZoom failed:', err);
        }
        if (this._zoomLabel) {
            this._zoomLabel.textContent = formatZoom(next);
            this._zoomLabel.classList.toggle('btn-active', !isAtDefault(next));
        }
        if (persist) {
            this._mutate(p => this._api.updateEditorSettings(p.unid, {zoom: next}))
            .catch((err: unknown): void => console.error('[DbEditor] persist zoom failed:', err));
        }
    }

    /*
     * Recompute the zoom wrapper's layout dimensions so the parent
     * `#dbgrid`'s scrollbars accommodate the visual extent (cards × zoom).
     *
     * Because of `transform: scale(z)` on the wrapper, the cards keep
     * their unscaled (left, top, width, height) values but are visually
     * scaled by `z`. The parent only sees the wrapper's CSS-layout size
     * — so we set `width/height = unscaledExtent × z + pad` which gives
     * the parent a scrollable extent matching the rendered canvas.
     */
    private _applyCanvasExtent(): void {
        if (!this._zoomLayer) {return;}
        const pad = 200;
        let maxRight = 0;
        let maxBottom = 0;
        const observe = (el: HTMLElement): void => {
            const right = el.offsetLeft + el.offsetWidth;
            const bottom = el.offsetTop + el.offsetHeight;
            if (right > maxRight) {maxRight = right;}
            if (bottom > maxBottom) {maxBottom = bottom;}
        };
        for (const card of this._tables.values()) {observe(card.element);}
        for (const card of this._views.values()) {observe(card.element);}
        if (this._zoomLayer) {
            this._zoomLayer.querySelectorAll<HTMLElement>('.db-layer').forEach(observe);
        }
        const w = (maxRight + pad) * this._zoomLevel;
        const h = (maxBottom + pad) * this._zoomLevel;
        this._zoomLayer.style.width = `${w}px`;
        this._zoomLayer.style.height = `${h}px`;
    }

    private _loadZoomFromActiveProject(): void {
        const persisted = this._activeProject?.data.editor?.zoom;
        const level = typeof persisted === 'number' ? clampZoom(persisted) : ZOOM_DEFAULT;
        this._setZoom(level, false);
    }

    private async _mutate<T>(fn: (p: LoadedProject) => Promise<T>): Promise<T | null> {
        if (!this._activeProject) {return null;}
        try { return await fn(this._activeProject); }
        catch (err) {
            console.error(err);
            await AlertDialog.showAlert('Request failed', String(err));
            return null;
        }
    }

    private _onSseEvent(_ev: DbSseEvent): void {
        // simplest possible reconciliation: re-fetch on any remote change
        this._reload();
    }

    /*
     * -----------------------------------------------------------------
     * user actions
     * -----------------------------------------------------------------
     */

    private async _requireActiveContainer(): Promise<boolean> {
        if (!this._activeProject || !this._activeContainerUnid) {
            await AlertDialog.showAlert('No active database',
                'Pick a database (or folder) from the tree first.');
            return false;
        }
        return true;
    }

    private async _addTablePrompt(): Promise<void> {
        if (!await this._requireActiveContainer()) {return;}
        const name = await InputDialog.showInput('Add table', 'Table name', 'new_table');
        if (!name) {return;}
        await this._mutate(p => this._api.createTable(p.unid, this._activeContainerUnid!, name, { x: 80, y: 80 }));
        await this._reload();
    }

    private async _addEnumPrompt(): Promise<void> {
        if (!await this._requireActiveContainer()) {return;}
        const name = await InputDialog.showInput('Add enum', 'Enum name', 'new_enum');
        if (!name) {return;}
        await this._mutate(p => this._api.createEnum(p.unid, this._activeContainerUnid!, name, { x: 80, y: 80 }));
        await this._reload();
    }

    private async _addViewPrompt(): Promise<void> {
        if (!await this._requireActiveContainer()) {return;}
        const name = await InputDialog.showInput('Add view', 'View name', 'new_view');
        if (!name) {return;}
        await this._mutate(p => this._api.createView(p.unid, this._activeContainerUnid!, name, { x: 80, y: 80 }));
        await this._reload();
    }

    private async _addRoutinePrompt(): Promise<void> {
        if (!await this._requireActiveContainer()) {return;}
        const name = await InputDialog.showInput('Add routine', 'Routine name', 'new_routine');
        if (!name) {return;}
        await this._mutate(p => this._api.createRoutine(p.unid, this._activeContainerUnid!, name, 'procedure', { x: 80, y: 80 }));
        await this._reload();
    }

    private async _addFolderPrompt(): Promise<void> {
        if (!await this._requireActiveContainer()) {return;}
        const name = await InputDialog.showInput('Add folder', 'Folder name', 'new_folder');
        if (!name) {return;}
        await this._mutate(p => this._api.createContainer(p.unid, this._activeContainerUnid!, name, JsonDataDBType.folder));
        await this._reload();
    }

    private async _addLayerPrompt(): Promise<void> {
        if (!await this._requireActiveContainer()) {return;}
        const name = await InputDialog.showInput('Add EER diagram', 'Diagram name', 'New diagram');
        if (!name) {return;}
        /*
         * Default size is generous so the user can immediately drop
         * a few tables onto it; the SE corner handle resizes if it's
         * too big. Initial position is top-left — user drags from
         * the label to wherever they want.
         */
        await this._mutate(p => this._api.createLayer(p.unid, this._activeContainerUnid!, name, {
            pos: {x: 80, y: 80},
            width: 400,
            height: 300
        }));
        await this._reload();
    }

    private async _generate(): Promise<void> {
        if (!this._activeProject) {return;}
        try {
            const result = await this._api.generate(this._activeProject.unid);
            await new SqlPreviewDialog(
                this._activeProject.name,
                this._activeProject.dialect,
                result.root,
                result.files
            ).show();
        } catch (err) {
            await AlertDialog.showAlert('Generate failed', String(err));
        }
    }

    /**
     * Generate Markdown documentation for every database in the
     * project. When `dryRun=true`, the server returns the rendered
     * content without writing to disk — used by the "Preview docs"
     * menu entry so the user can inspect output before committing.
     * Reuses `SqlPreviewDialog` with `displayKind: 'docs'` so the
     * file list + preview pane + copy button all work for free.
     */
    private async _generateDocs(dryRun: boolean): Promise<void> {
        if (!this._activeProject) {return;}
        try {
            const result = await this._api.generateDocs(this._activeProject.unid, dryRun);
            await new SqlPreviewDialog(
                this._activeProject.name,
                this._activeProject.dialect,
                dryRun ? `${result.root} (preview only — not written)` : result.root,
                result.files,
                'docs'
            ).show();
        } catch (err) {
            await AlertDialog.showAlert(dryRun ? 'Preview docs failed' : 'Generate docs failed', String(err));
        }
    }

    /**
     * Multi-table scoped generate → concatenate every returned file's
     * content → write to the clipboard. Used by the Copy-SQL topbar button
     * and the Ctrl+Shift+C shortcut. When no tables are selected we surface
     * an alert instead of silently doing nothing — discoverability beats
     * "did anything just happen?".
     */
    private async _copySelectionSql(): Promise<void> {
        if (!this._activeProject) {return;}
        const unids = [...this._selectedTableUnids];
        if (unids.length === 0) {
            await AlertDialog.showAlert(
                'No tables selected',
                'Select one or more tables (click + Shift / Ctrl / drag-rubber-band) then try again.'
            );
            return;
        }
        try {
            const res = await this._api.generateScoped(this._activeProject.unid, {tableUnids: unids});
            const concatenated = res.files.map(f => f.content.trimEnd()).join('\n\n');
            if (!concatenated) {
                await AlertDialog.showAlert('Nothing to copy', 'Generator returned no SQL.');
                return;
            }
            await navigator.clipboard.writeText(concatenated);
        } catch (err) {
            await AlertDialog.showAlert('Copy SQL failed', String(err));
        }
    }

    private async _generateScoped(detail: {
        databaseUnid?: string;
        tableUnid?: string;
        layerUnid?: string;
        layerName?: string;
    }): Promise<void> {
        if (!this._activeProject) {return;}
        const {databaseUnid, tableUnid, layerUnid, layerName} = detail;
        if (!databaseUnid && !tableUnid && !layerUnid) {return;}

        /*
         * Layer scope: resolve to the set of `tableUnids` whose
         * `layerUnid` matches, then route through the existing
         * tableUnids-based generate. If no tables are assigned to the
         * layer the user gets a polite alert instead of an empty
         * preview.
         */
        let tableUnids: string[] | undefined;
        if (layerUnid) {
            const all = this._collectAllTables(this._activeProject.data);
            tableUnids = all.filter(t => t.layerUnid === layerUnid).map(t => t.unid);
            if (tableUnids.length === 0) {
                await AlertDialog.showAlert(
                    'Empty EER diagram',
                    `EER diagram "${layerName ?? layerUnid}" has no tables assigned. Use "Assign to EER diagram…" first.`
                );
                return;
            }
        }

        try {
            const result = await this._api.generateScoped(this._activeProject.unid, {
                databaseUnid: databaseUnid,
                tableUnid: tableUnid,
                tableUnids: tableUnids
            });
            /*
             * Preview-only — the server didn't write to disk. We surface
             * a label suffix so the user knows this isn't the same as the
             * full project's generated output.
             */
            let scopeLabel = ' · scoped to database';
            if (layerUnid) {scopeLabel = ` · scoped to EER diagram "${layerName ?? layerUnid}"`;}
            else if (tableUnid) {scopeLabel = ' · scoped to table';}
            await new SqlPreviewDialog(
                this._activeProject.name + scopeLabel,
                this._activeProject.dialect,
                result.root,
                result.files
            ).show();
        } catch (err) {
            await AlertDialog.showAlert('Generate failed', String(err));
        }
    }

    /**
     * Build a JSON snapshot of the current project's data tree and trigger
     * a download via an anchor + Blob URL. Pure client-side — no backend
     * round-trip. We capture the *whole* `data` object (fs + editor + sync
     * if present) so the user can carry their layout preferences along;
     * the import side only adopts `fs` though.
     */
    private _exportSchema(): void {
        if (!this._activeProject) {return;}
        const p = this._activeProject;
        const payload = {
            schemaVersion: 1,
            project: p.name,
            dialect: p.dialect,
            exportedAt: new Date().toISOString(),
            data: {fs: p.data, editor: p.editor}
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const ts = new Date().toISOString().replace(/[:T.]/gu, '-').slice(0, 19);
        const safe = p.name.replace(/[^a-zA-Z0-9_-]+/gu, '_') || 'schema';
        const a = document.createElement('a');
        a.href = url;
        a.download = `${safe}-${ts}.dbeditor.json`;
        document.body.append(a);
        a.click();
        a.remove();
        /* revoke after a tick so Firefox/Safari actually start the download */
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /**
     * File-picker import. Reads the file as text, parses JSON, validates
     * its shape (must have a `.data.fs` or top-level `.fs`), summarises
     * the new schema for the confirm dialog, then `replaceFs`. Lands as a
     * single undo step — if the user picks the wrong file or imports a
     * bad schema, Ctrl+Z brings the previous state back.
     */
    private async _openProjectInfo(): Promise<void> {
        if (!this._activeProject) {return;}
        try {
            const res = await this._api.getProjectInfo(this._activeProject.unid);
            const pid = this._activeProject.unid;
            const dialog = new ProjectInfoDialog(res.info, {
                testConnection: (databaseUnid: string): Promise<{success: boolean;}> => this._api.testConnection(pid, databaseUnid),
                restartServer: (): Promise<{success: boolean;}> => this._api.restartServer(),
                confirmReload: (message: string): Promise<boolean> => ConfirmDialog.showConfirm('Reload config', message, 'danger'),
                addConnection: (): Promise<void> => this._openAddConnectionDialog(pid, res.info),
                editConnection: (databaseUnid: string): Promise<void> => this._openEditConnectionDialog(pid, res.info, databaseUnid),
                rebindConnection: (databaseUnid: string): Promise<void> => this._openRebindConnectionDialog(pid, res.info, databaseUnid),
                removeConnection: async(databaseUnid: string): Promise<void> => {
                    await this._api.removeConnection(pid, databaseUnid);
                    /*
                     * Server is restarting — the browser will full-
                     * page-reload via Vite's client. No further work
                     * needed.
                     */
                },
                confirmRemoveConnection: (databaseName: string | null, databaseUnid: string): Promise<boolean> => {
                    const label = databaseName ?? databaseUnid;
                    return ConfirmDialog.showConfirm(
                        'Remove connection',
                        `Remove the connection for "${label}"?\n\nThe dev server will restart and the page will reload.`,
                        'danger'
                    );
                }
            });
            await dialog.show();
        } catch (err) {
            await AlertDialog.showAlert('Failed to load project info', String(err));
        }
    }

    /**
     * Open the AddConnectionDialog with the list of model databases
     * that don't yet have a connection on the active project. POSTs
     * to `/api/projects/:pid/config/connections` on save — the server
     * writes dbeditor.json and restarts; the page full-page-reloads.
     */
    private async _openAddConnectionDialog(pid: string, info: ProjectInfo): Promise<void> {
        if (!this._activeProject) {return;}
        const taken = new Set(info.connections.map(c => c.databaseUnid));
        const all = this._collectDatabasesInProject(this._activeProject.data);
        const candidates: AddConnectionDatabaseChoice[] = all
        .filter(d => !taken.has(d.unid))
        .map(d => ({unid: d.unid, name: d.name}));
        const input = await new AddConnectionDialog(
            candidates,
            info.dialect,
            (probe): Promise<{success: boolean;}> => this._api.testAdHocConnection(probe)
        ).show();
        if (!input) {return;}
        try {
            await this._api.addConnection(pid, input);
            /* Server-side restart will full-page-reload the browser. */
        } catch (err) {
            await AlertDialog.showAlert('Failed to add connection', String((err as Error).message ?? err));
        }
    }

    /**
     * Open EditConnectionDialog pre-filled with the named
     * connection's current fields. On save, PATCH the changed-only
     * subset; server-side restart full-page-reloads the browser.
     */
    private async _openEditConnectionDialog(pid: string, info: ProjectInfo, databaseUnid: string): Promise<void> {
        const conn = info.connections.find(c => c.databaseUnid === databaseUnid);
        if (!conn) {
            await AlertDialog.showAlert('Connection not found', `No connection for ${databaseUnid} on this project.`);
            return;
        }
        const patch = await new EditConnectionDialog(
            conn,
            info.dialect,
            (probe): Promise<{success: boolean;}> => this._api.testAdHocConnection(probe),
            (dbUnid, p): Promise<{success: boolean;}> => this._api.testConnectionWithPatch(pid, dbUnid, p)
        ).show();
        if (!patch) {return;}
        if (Object.keys(patch).length === 0) {
            /*
             * Nothing changed — skip the round-trip + restart. Saves
             * the user a forced full-page-reload on an accidental
             * Save click.
             */
            return;
        }
        /*
         * Server-redirect guard: if the user changed `host`, `port`,
         * or `database`, the connection is now pointing at different
         * data. A subsequent `Sync with DB → Apply` would run DDL
         * against the new target — which is almost certainly NOT
         * what's intended if the host change was a typo. Force an
         * explicit confirmation. Other field changes (user, password,
         * ssl, readOnly) reuse the same target and don't need the
         * guard.
         */
        const targetChanges: string[] = [];
        if (patch.host !== undefined && patch.host !== conn.host) {
            targetChanges.push(`Host: ${conn.host} → ${patch.host}`);
        }
        if (patch.port !== undefined && patch.port !== conn.port) {
            targetChanges.push(`Port: ${conn.port} → ${patch.port}`);
        }
        if (patch.database !== undefined && patch.database !== conn.database) {
            targetChanges.push(`Database: ${conn.database} → ${patch.database}`);
        }
        if (targetChanges.length > 0) {
            const ok = await ConfirmDialog.showConfirm(
                'Change connection target?',
                `You're redirecting this connection to a different server / database:\n\n  ${targetChanges.join('\n  ')}\n\nAfter save, "Sync with DB → Apply" would run DDL against the NEW target instead of the previous one. Continue?`,
                'danger'
            );
            if (!ok) {return;}
        }
        try {
            await this._api.updateConnection(pid, databaseUnid, patch);
            /* Server-side restart will full-page-reload the browser. */
        } catch (err) {
            await AlertDialog.showAlert('Failed to update connection', String((err as Error).message ?? err));
        }
    }

    /**
     * Open RebindConnectionDialog with every model database in this
     * project as candidates, minus the ones that already host another
     * connection (the current connection's binding stays in the list
     * so the user can cancel by re-selecting it). On save, PATCHes the
     * `/rebind` route; the server writes dbeditor.json + restarts +
     * the browser full-page-reloads.
     */
    private async _openRebindConnectionDialog(pid: string, info: ProjectInfo, databaseUnid: string): Promise<void> {
        if (!this._activeProject) {return;}
        const conn = info.connections.find(c => c.databaseUnid === databaseUnid);
        if (!conn) {
            await AlertDialog.showAlert('Connection not found', `No connection for ${databaseUnid} on this project.`);
            return;
        }
        const takenByOthers = new Set(
            info.connections.filter(c => c.databaseUnid !== databaseUnid).map(c => c.databaseUnid)
        );
        const all = this._collectDatabasesInProject(this._activeProject.data);
        const candidates: AddConnectionDatabaseChoice[] = all
        .filter(d => !takenByOthers.has(d.unid))
        .map(d => ({unid: d.unid, name: d.name}));
        const picked = await new RebindConnectionDialog(databaseUnid, conn.databaseName, candidates).show();
        if (!picked) {return;}
        if (picked === databaseUnid) {return;}
        try {
            await this._api.rebindConnection(pid, databaseUnid, picked);
            /* Server-side restart will full-page-reload the browser. */
        } catch (err) {
            await AlertDialog.showAlert('Failed to rebind connection', String((err as Error).message ?? err));
        }
    }

    /**
     * Find the database container that owns a given layerUnid. Used
     * to resolve `databaseUnid` for layer-scoped sync, where the
     * treeview-side menu doesn't carry the parent database in its
     * event detail. Returns `null` if no database in the project
     * has a matching layer.
     */
    private _findDatabaseOfLayer(root: JsonDataDB, layerUnid: string): JsonDataDB | null {
        if (root.type === JsonDataDBType.database) {
            for (const l of root.layers ?? []) {
                if (l.unid === layerUnid) {return root;}
            }
        }
        for (const child of root.entrys ?? []) {
            const hit = this._findDatabaseOfLayer(child, layerUnid);
            if (hit) {return hit;}
        }
        return null;
    }

    /**
     * Walks the project's `JsonDataDB` tree and returns every
     * `database`-type container. Used by the add-connection dialog
     * to populate its "Model database" select; one connection per
     * database is the invariant.
     */
    private _collectDatabasesInProject(root: JsonDataDB): {unid: string; name: string;}[] {
        const out: {unid: string; name: string;}[] = [];
        const walk = (node: JsonDataDB): void => {
            if (node.type === JsonDataDBType.database) {
                out.push({unid: node.unid, name: node.name});
            }
            for (const child of node.entrys ?? []) {walk(child);}
        };
        walk(root);
        return out;
    }

    /**
     * Append a new project to `dbeditor.json` and let the dev server
     * restart pick it up. Browser will full-page-reload via the Vite
     * client once the new server is up, so the new project surfaces
     * on the next `/api/load-schema` call. No optimistic UI update —
     * the boot path is the source of truth for which projects exist.
     */
    private async _addProject(): Promise<void> {
        const input = await new AddProjectDialog().show();
        if (!input) {return;}
        try {
            await this._api.addProject(input);
            /*
             * Server is restarting; the Vite client will full-page-
             * reload the moment it comes back. Nothing else to do
             * here.
             */
        } catch (err) {
            await AlertDialog.showAlert(
                'Failed to add project',
                `${String((err as Error).message ?? err)}\n\nCheck dbeditor.json for syntax issues and try again.`
            );
        }
    }

    /**
     * Remove the active project from dbeditor.json after a destructive
     * confirm. The schema file on disk is intentionally NOT touched —
     * surfaced in the confirm message so the user understands. Server
     * restart full-page-reloads; if this was the only project, the
     * resulting "no projects" state is handled by the regular boot
     * path (`/api/load-schema` returns empty projects[]).
     */
    private async _removeProject(): Promise<void> {
        if (!this._activeProject) {return;}
        const name = this._activeProject.name;
        const ok = await ConfirmDialog.showConfirm(
            'Remove project',
            `Drop "${name}" from dbeditor.json?\n\nThe project's schema file and any generated SQL stay on disk — only the entry in dbeditor.json is removed. The dev server will restart and the page will reload. You can re-add the project later by pointing at the same schema path.`,
            'danger'
        );
        if (!ok) {return;}
        try {
            await this._api.removeProject(this._activeProject.unid);
            /* Restart → full-page-reload. */
        } catch (err) {
            await AlertDialog.showAlert('Failed to remove project', String((err as Error).message ?? err));
        }
    }

    /**
     * Open `EditProjectDialog` pre-filled with the active project's
     * current dbeditor.json fields. Submits a diff-only PATCH; the
     * server-side restart full-page-reloads the browser.
     */
    private async _editProject(): Promise<void> {
        if (!this._activeProject) {return;}
        let info;
        try {
            const res = await this._api.getProjectInfo(this._activeProject.unid);
            info = res.info;
        } catch (err) {
            await AlertDialog.showAlert('Failed to load project info', String(err));
            return;
        }
        const patch = await new EditProjectDialog({
            name: info.name,
            schemaPath: info.schemaPath,
            dialect: info.dialect,
            outputMode: info.output.mode,
            outputDestinationPath: info.output.destinationPath,
            autoGenerate: info.autoGenerate
        }).show();
        if (!patch) {return;}
        if (Object.keys(patch).length === 0) {
            /* No-op — skip the restart entirely. */
            return;
        }
        try {
            await this._api.updateProject(this._activeProject.unid, patch);
            /* Restart → full-page-reload. */
        } catch (err) {
            await AlertDialog.showAlert('Failed to update project', String((err as Error).message ?? err));
        }
    }

    private async _openProjectSettings(): Promise<void> {
        if (!this._activeProject) {return;}
        const projectUnid = this._activeProject.unid;
        const projectName = this._activeProject.name;
        let current;
        try {
            const res = await this._api.getOutputSettings(projectUnid);
            current = res.output;
        } catch (err) {
            await AlertDialog.showAlert('Failed to load settings', String(err));
            return;
        }
        const patch = await new ProjectSettingsDialog(projectName, current).show();
        if (!patch || Object.keys(patch).length === 0) {return;}
        try {
            await this._mutate(p => this._api.updateOutputSettings(p.unid, patch));
            await this._reload();
        } catch (err) {
            await AlertDialog.showAlert('Failed to save settings', String(err));
        }
    }

    /**
     * File-picker import for `.mwb` (MySQL Workbench) files. Server-side
     * parses the ZIP+XML, builds a fresh fs root with the imported
     * databases as children, and replaces `data.fs` (so undo reverts the
     * whole import as one step). Confirms via `ConfirmDialog` showing the
     * counts the server gave us back, so the user sees what's about to land.
     */
    private _importMwb(): void {
        if (!this._activeProject) {return;}
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.mwb,application/octet-stream';
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (!file) {return;}
            this._handleMwbFile(file).catch((err: unknown): void => console.error('[DbEditor] mwb import failed:', err));
        });
        input.click();
    }

    private _pickMwbImportMode(filename: string): Promise<'replace' | 'append' | null> {
        return ChoiceDialog.showChoice<'replace' | 'append'>(
            'Import Workbench .mwb',
            [
                `How should "${filename}" be imported?`,
                '',
                'Replace — discard the current schema entirely and start from the .mwb file.',
                'Append — keep the current schema and add the .mwb file\'s databases as new entries.',
                '',
                'Either way, Ctrl+Z undoes the import as a single step.'
            ].join('\n'),
            [
                {value: 'append',  label: 'Append',  kind: 'primary'},
                {value: 'replace', label: 'Replace', kind: 'danger'}
            ]
        );
    }

    private async _handleMwbFile(file: File): Promise<void> {
        if (!this._activeProject) {return;}
        const mode = await this._pickMwbImportMode(file.name);
        if (!mode) {return;}
        try {
            const bytes = await file.arrayBuffer();
            const res = await this._mutate(p => this._api.importMwb(p.unid, bytes, mode));
            if (!res) {return;}
            const pos = res.stats.positionedTableCount;
            const vpos = res.stats.positionedViewCount;
            const placedParts: string[] = [];
            if (pos > 0) {
                placedParts.push(`${pos} of ${res.stats.tableCount} table${res.stats.tableCount === 1 ? '' : 's'}`);
            }
            if (vpos > 0) {
                placedParts.push(`${vpos} of ${res.stats.viewCount} view${res.stats.viewCount === 1 ? '' : 's'}`);
            }
            const posSuffix = placedParts.length > 0
                ? ` Placed ${placedParts.join(' and ')} from the Workbench diagram.`
                : '';
            const extras: string[] = [];
            if (res.stats.viewCount > 0)    {extras.push(`${res.stats.viewCount} view${res.stats.viewCount === 1 ? '' : 's'}`);}
            if (res.stats.routineCount > 0) {extras.push(`${res.stats.routineCount} routine${res.stats.routineCount === 1 ? '' : 's'}`);}
            if (res.stats.triggerCount > 0) {extras.push(`${res.stats.triggerCount} trigger${res.stats.triggerCount === 1 ? '' : 's'}`);}
            if (res.stats.layerCount > 0)   {extras.push(`${res.stats.layerCount} EER diagram${res.stats.layerCount === 1 ? '' : 's'} as layers`);}
            if (res.stats.multiDiagramTableCount > 0) {
                extras.push(`${res.stats.multiDiagramTableCount} table${res.stats.multiDiagramTableCount === 1 ? '' : 's'} on multiple diagrams`);
            }
            const extraSuffix = extras.length ? ` Also: ${extras.join(', ')}.` : '';
            const modeWord = res.mode === 'append' ? 'Appended' : 'Imported';
            await AlertDialog.showAlert(
                'Import complete',
                `${modeWord} ${res.stats.schemaCount} schema${res.stats.schemaCount === 1 ? '' : 's'}, ${res.stats.tableCount} tables, ${res.stats.columnCount} columns, ${res.stats.indexCount} indexes, ${res.stats.foreignKeyCount} foreign keys.${posSuffix}${extraSuffix}`
            );
            await this._reload();
            /*
             * Auto-fit-to-view after import: Workbench coordinates can
             * land WAY off-screen (sometimes thousands of px from
             * origin). Without this, users land on an empty grey
             * canvas and have to hunt for their tables. The fit-to-
             * view runs after a brief tick so the rendered cards are
             * measured against their final positions, not pre-render
             * defaults.
             */
            setTimeout(() => this._fitToView(), 100);
        } catch (err) {
            await AlertDialog.showAlert('Import failed', String(err));
        }
    }

    /**
     * Export the project schema as a `.mwb` archive. Pure download — no
     * persistence change, no confirm dialog. Filename mirrors the
     * Schema-Export pattern: `<sanitisedProjectName>-<ts>.mwb`. Lossy:
     * Workbench-specific fields we don't model (sequences, layers,
     * canvas positions for non-imported models, etc.) are dropped.
     */
    private _exportMwb(): void {
        if (!this._activeProject) {return;}
        const pid = this._activeProject.unid;
        const safeName = (this._activeProject.name || 'project').replace(/[^A-Za-z0-9._-]+/gu, '_');
        const ts = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
        this._api.exportMwb(pid).then(blob => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${safeName}-${ts}.mwb`;
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }).catch(async(err: unknown): Promise<void> => {
            await AlertDialog.showAlert('Export failed', String(err));
        });
    }

    private _importSchema(): void {
        if (!this._activeProject) {return;}
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (!file) {return;}
            this._handleImportFile(file).catch((err: unknown): void => console.error('[DbEditor] import failed:', err));
        });
        input.click();
    }

    private async _handleImportFile(file: File): Promise<void> {
        if (!this._activeProject) {return;}
        let parsed: unknown;
        try {
            parsed = JSON.parse(await file.text());
        } catch (err) {
            await AlertDialog.showAlert('Import failed', `Not valid JSON: ${(err as Error).message}`);
            return;
        }
        /*
         * Accept either the export-wrapper shape (`{data: {fs}}`) or a raw
         * `{fs}` payload. Anything else is a wrong file.
         */
        const wrapped = parsed as { data?: { fs?: unknown; }; fs?: unknown; };
        const fs = wrapped?.data?.fs ?? wrapped?.fs;
        if (!fs || typeof fs !== 'object') {
            await AlertDialog.showAlert('Import failed', 'JSON has no `fs` field — not an exported schema.');
            return;
        }
        const tablesIn = DbEditor._countDeep(fs as any, 'tables');
        const viewsIn = DbEditor._countDeep(fs as any, 'views');
        const enumsIn = DbEditor._countDeep(fs as any, 'enums');
        const ok = await ConfirmDialog.showConfirm(
            'Import schema',
            [
                'Replace the current schema with:',
                `  • ${tablesIn} table${tablesIn === 1 ? '' : 's'}`,
                `  • ${viewsIn} view${viewsIn === 1 ? '' : 's'}`,
                `  • ${enumsIn} enum${enumsIn === 1 ? '' : 's'}`,
                '',
                'Your layout preferences and ignore patterns are preserved.',
                'Use Ctrl+Z to undo if wrong.'
            ].join('\n'),
            'danger'
        );
        if (!ok) {return;}
        try {
            await this._mutate(p => this._api.replaceFs(p.unid, fs));
            await this._reload();
        } catch (err) {
            await AlertDialog.showAlert('Import failed', String(err));
        }
    }

    /**
     * Walk an `fs` tree (the import payload's shape, not type-checked yet)
     * and count entries in the named collection across every nested
     * database / folder. Used only for the import confirm-dialog summary,
     * so it's lenient about shape — bad inputs return 0 instead of throwing.
     */
    private static _countDeep(node: any, key: 'tables' | 'views' | 'enums'): number {
        if (!node || typeof node !== 'object') {return 0;}
        let n = Array.isArray(node[key]) ? node[key].length : 0;
        if (Array.isArray(node.entrys)) {
            for (const c of node.entrys) {n += DbEditor._countDeep(c, key);}
        }
        return n;
    }

    /**
     * Layered arrangement following FK direction: a table sits one
     * column to the right of every table it references. So referenced
     * (parent) tables end up on the left, referencing (child) tables
     * on the right — matching the conventional ER reading direction.
     *
     * Levels are computed by relaxation (capped at N iterations) so
     * cycles converge instead of looping forever. Self-FKs are ignored
     * for level assignment. Tables that reference something outside
     * the current container (cross-database FK) collapse to level 0.
     */
    private _arrange(): void {
        if (!this._grid || !this._activeProject || !this._activeContainerUnid) {return;}
        const container = this._findContainer(this._activeProject.data, this._activeContainerUnid);
        if (!container) {return;}
        let tables = this._collectTables(container);
        /*
         * If the canvas is scoped to a layer, only arrange that
         * layer's tables — leave the hidden ones alone. Without this
         * filter, the layer-scope user would re-arrange the entire
         * database invisibly and silently dirty the schema file.
         */
        if (this._activeLayerUnid) {
            const layerUnid = this._activeLayerUnid;
            tables = tables.filter(t => DbEditor._tableInLayer(t, layerUnid));
        }
        if (!tables.length) {return;}
        const tableSet = new Set(tables.map(t => t.unid));

        const level = new Map<string, number>();
        for (const t of tables) {level.set(t.unid, 0);}
        const ITERATIONS = Math.max(8, tables.length);
        for (let i = 0; i < ITERATIONS; i++) {
            let changed = false;
            for (const t of tables) {
                let max = 0;
                for (const fk of t.foreignKeys) {
                    // skip self-FK and cross-container references
                    if (fk.refTableUnid === t.unid) {continue;}
                    if (!tableSet.has(fk.refTableUnid)) {continue;}
                    const refLevel = level.get(fk.refTableUnid) ?? 0;
                    if (refLevel + 1 > max) {max = refLevel + 1;}
                }
                if (max !== level.get(t.unid)) {
                    level.set(t.unid, max);
                    changed = true;
                }
            }
            if (!changed) {break;}
        }

        // Group by level, sort within a level by name for determinism.
        const byLevel = new Map<number, JsonTable[]>();
        for (const t of tables) {
            const l = level.get(t.unid) ?? 0;
            if (!byLevel.has(l)) {byLevel.set(l, []);}
            byLevel.get(l)!.push(t);
        }
        for (const arr of byLevel.values()) {arr.sort((a, b) => a.name.localeCompare(b.name));}

        const COL_WIDTH = 320;
        const ROW_HEIGHT = 220;
        const X0 = 40;
        const Y0 = 40;
        const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
        for (const l of sortedLevels) {
            const arr = byLevel.get(l)!;
            arr.forEach((t, idx): void => {
                const x = X0 + (l * COL_WIDTH);
                const y = Y0 + (idx * ROW_HEIGHT);
                /*
                 * Update the in-memory data so the immediate _renderCanvas
                 * pass below sees the new positions; also persist via API.
                 */
                t.pos = { x: x, y: y };
                this._mutate(p => this._api.updateTable(p.unid, t.unid, { pos: { x: x, y: y } }));
            });
        }
        /*
         * Recompute FK anchor sides from the new card positions. Just
         * re-rendering the canvas is the cheapest way that gets crow's
         * foot directions right; SSE filters our own changes out so we
         * can't rely on _reload being called.
         */
        this._renderCanvas();
    }

    /**
     * Bring a table into view on the canvas. Switches the active
     * container first if it doesn't currently host the table — the
     * canvas only renders cards for the active container's subtree.
     * Re-rendering the canvas tears down `this._tables`, so the
     * scroll/flash has to wait for the next frame; rAF + a small
     * timeout is enough for jsPlumb's post-render layout.
     */
    private async _openSearchPalette(): Promise<void> {
        if (!this._activeProject) {return;}
        const index = buildSearchIndex(this._activeProject.data);
        const pick = await new SearchPalette(index).show();
        if (!pick) {return;}
        /*
         * Layer pick: switch the active container if needed and flash
         * the layer's backdrop. Layers don't have a selection model
         * (they're pure visual hints), so we don't `_selectOne` them.
         */
        if (pick.kind === 'layer' && pick.layerUnid) {
            this._focusLayer(pick.layerUnid, pick.containerUnid);
            return;
        }
        if (!pick.tableUnid) {return;}
        /*
         * `_focusTable` switches the active container if needed, then
         * scrolls + flashes the card. Selecting it too gives the user a
         * persistent landing cue. For a column pick we additionally
         * flash the row inside the card after a tick so the canvas has
         * had time to render.
         */
        this._focusTable(pick.tableUnid, pick.containerUnid);
        this._selectOne(pick.tableUnid);
        if (pick.kind === 'column' && pick.columnUnid) {
            const columnUnid = pick.columnUnid;
            const tableUnid = pick.tableUnid;
            setTimeout(() => this._flashColumn(tableUnid, columnUnid), 200);
        }
    }

    /**
     * Bring a layer into view: switch the active container if needed,
     * then scroll the layer rectangle into view + briefly outline it.
     * No selection model for layers — this is purely a navigation
     * affordance triggered from the search palette.
     */
    private _focusLayer(layerUnid: string, containerUnid: string): void {
        if (this._activeContainerUnid !== containerUnid) {
            this._activeContainerUnid = containerUnid;
            this._renderCanvas();
        }
        /* Wait for the canvas render so the layer div exists. */
        setTimeout(() => {
            const el = this._zoomLayer?.querySelector(`.db-layer[data-layer-unid="${layerUnid}"]`) as HTMLElement | null;
            if (!el) {return;}
            el.scrollIntoView({behavior: 'smooth', block: 'center', inline: 'center'});
            el.classList.add('db-layer--flash');
            setTimeout(() => el.classList.remove('db-layer--flash'), 1600);
        }, 50);
    }

    private _flashColumn(tableUnid: string, columnUnid: string): void {
        const card = this._tables.get(tableUnid);
        if (!card) {return;}
        const row = card.element.querySelector(`.db-table-column[data-column-unid="${columnUnid}"]`) as HTMLElement | null;
        if (!row) {return;}
        row.classList.add('db-table-column--flash');
        row.scrollIntoView({block: 'nearest', behavior: 'smooth'});
        setTimeout(() => row.classList.remove('db-table-column--flash'), 1600);
    }

    private _focusTable(tableUnid: string, hintedContainerUnid?: string): void {
        if (!this._activeProject) {return;}

        let needsRender = false;
        const tablePresent = (): boolean => Boolean(this._tables.get(tableUnid));
        if (!tablePresent()) {
            const target = hintedContainerUnid ?? this._findTableContainerUnid(this._activeProject.data, tableUnid);
            if (target && target !== this._activeContainerUnid) {
                this._activeContainerUnid = target;
                needsRender = true;
            }
        }
        if (needsRender) {this._renderCanvas();}

        requestAnimationFrame(() => {
            const card = this._tables.get(tableUnid);
            if (!card) {return;}
            card.element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
            card.element.classList.remove('db-table--flash');
            /*
             * Re-add on the next frame so the animation restarts even
             * if the user clicks the same warning twice in a row.
             */
            requestAnimationFrame(() => {
                card.element.classList.add('db-table--flash');
                setTimeout((): void => card.element.classList.remove('db-table--flash'), 1600);
            });
        });
    }

    /** Find the deepest container (database/folder) holding the table; null if not found. */
    private _findTableContainerUnid(node: JsonDataDB, tableUnid: string): string | null {
        if (node.tables.some(t => t.unid === tableUnid)) {return node.unid;}
        for (const c of node.entrys as JsonDataDB[]) {
            const hit = this._findTableContainerUnid(c, tableUnid);
            if (hit) {return hit;}
        }
        return null;
    }

    private _wireResizer(): void {
        const r = document.getElementById('resizer');
        const main = document.getElementById('main');
        if (!r || !main) {return;}
        let dragging = false;
        r.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'col-resize'; });
        window.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; });
        window.addEventListener('mousemove', (e) => {
            if (!dragging) {return;}
            const w = Math.max(180, Math.min(600, e.clientX));
            main.style.gridTemplateColumns = `${w}px 4px 1fr`;
        });
    }

    /*
     * -----------------------------------------------------------------
     * helpers
     * -----------------------------------------------------------------
     */

    private _findFirstDatabase(node: JsonDataDB): JsonDataDB | null {
        if (node.type === JsonDataDBType.database) {return node;}
        for (const c of node.entrys as JsonDataDB[]) {
            const hit = this._findFirstDatabase(c);
            if (hit) {return hit;}
        }
        return null;
    }

    private _findContainer(root: JsonDataDB, unid: string): JsonDataDB | null {
        if (root.unid === unid) {return root;}
        for (const c of root.entrys as JsonDataDB[]) {
            const hit = this._findContainer(c, unid);
            if (hit) {return hit;}
        }
        return null;
    }

    /** Collect tables from this container and its subfolders (but not other databases). */
    private _collectTables(node: JsonDataDB): JsonTable[] {
        const out = [...node.tables];
        for (const c of node.entrys as JsonDataDB[]) {
            if (c.type === JsonDataDBType.folder) {out.push(...this._collectTables(c));}
        }
        return out;
    }

    /** Collect views from this container and its subfolders (but not other databases). */
    private _collectViews(node: JsonDataDB): JsonView[] {
        const out = [...node.views];
        for (const c of node.entrys as JsonDataDB[]) {
            if (c.type === JsonDataDBType.folder) {out.push(...this._collectViews(c));}
        }
        return out;
    }

    /** Collect *every* table in the project, across all databases/folders. */
    private _collectAllTables(node: JsonDataDB): JsonTable[] {
        const out = [...node.tables];
        for (const c of node.entrys as JsonDataDB[]) {out.push(...this._collectAllTables(c));}
        return out;
    }

    /** Collect enums from this container and its subfolders. */
    private _collectEnums(node: JsonDataDB): JsonEnum[] {
        const out = [...node.enums];
        for (const c of node.entrys as JsonDataDB[]) {
            if (c.type === JsonDataDBType.folder) {out.push(...this._collectEnums(c));}
        }
        return out;
    }

    /**
     * Membership check: is this table inside the given EER diagram?
     * Multi-membership semantics — primary `layerUnid` OR any entry
     * in `layerPlacements` counts.
     */
    private static _tableInLayer(t: JsonTable, layerUnid: string): boolean {
        if (t.layerUnid === layerUnid) {return true;}
        if (t.layerPlacements) {
            for (const p of t.layerPlacements) {
                if (p.layerUnid === layerUnid) {return true;}
            }
        }
        return false;
    }

    /**
     * Resolve the position to use when rendering `t` inside diagram
     * `layerUnid`. Placement entry wins if present (this is how a
     * table can sit at different coordinates in different diagrams);
     * otherwise fall back to the table's top-level `pos`.
     */
    private static _effectivePos(t: JsonTable, layerUnid: string): {x: number; y: number;} {
        if (t.layerPlacements) {
            const hit = t.layerPlacements.find(p => p.layerUnid === layerUnid);
            if (hit) {return hit.pos;}
        }
        return t.pos;
    }

    /**
     * Shallow-clone the table with `pos` swapped to the placement's
     * position (when one exists for `layerUnid`). DbTable reads
     * `pos` once at construction time + on `setData`; never mutates
     * it back, so handing it a clone is safe and isolates per-
     * diagram position state from the underlying canonical table.
     */
    private static _tableWithEffectivePos(t: JsonTable, layerUnid: string): JsonTable {
        const eff = DbEditor._effectivePos(t, layerUnid);
        if (eff === t.pos) {return t;}
        return {...t, pos: eff};
    }

    /**
     * Return a new `layerPlacements` array with `layerUnid` set to
     * `pos`. Replaces an existing entry in-place if present (so a
     * second drop on the same diagram doesn't accumulate duplicates),
     * otherwise appends. Pure / immutable so the caller can hand the
     * result straight to `_api.updateTable({layerPlacements: ...})`.
     */
    private static _upsertPlacement(
        placements: {layerUnid: string; pos: {x: number; y: number;};}[],
        layerUnid: string,
        pos: {x: number; y: number;}
    ): {layerUnid: string; pos: {x: number; y: number;};}[] {
        const idx = placements.findIndex(p => p.layerUnid === layerUnid);
        if (idx < 0) {return [...placements, {layerUnid: layerUnid, pos: pos}];}
        const out = [...placements];
        out[idx] = {layerUnid: layerUnid, pos: pos};
        return out;
    }

    /** Collect layers from this container and its subfolders. */
    private _collectLayers(node: JsonDataDB): JsonLayer[] {
        const out = [...node.layers ?? []];
        for (const c of node.entrys as JsonDataDB[]) {
            if (c.type === JsonDataDBType.folder) {out.push(...this._collectLayers(c));}
        }
        return out;
    }

    /**
     * Geometric hit test: which layer rectangle (if any) contains the
     * given canvas point? Returns the first match in the active
     * container's layer list. When the canvas is scoped to a single
     * layer (`_activeLayerUnid` set), only that layer is tested so a
     * stray drop onto a hidden-elsewhere layer doesn't silently move
     * the table to it.
     */
    private _layerAtPoint(x: number, y: number): string | null {
        if (!this._activeProject || !this._activeContainerUnid) {return null;}
        const container = this._findContainer(this._activeProject.data, this._activeContainerUnid);
        if (!container) {return null;}
        const all = this._collectLayers(container);
        const candidates = this._activeLayerUnid
            ? all.filter(l => l.unid === this._activeLayerUnid)
            : all;
        for (const l of candidates) {
            const left = l.pos.x;
            const top = l.pos.y;
            const right = left + l.width;
            const bottom = top + l.height;
            if (x >= left && x <= right && y >= top && y <= bottom) {
                return l.unid;
            }
        }
        return null;
    }

    private _findTableInProject(tableUnid: string): JsonTable | null {
        if (!this._activeProject) {return null;}
        for (const t of this._collectAllTables(this._activeProject.data)) {
            if (t.unid === tableUnid) {return t;}
        }
        return null;
    }

    private _collectAllViews(node: JsonDataDB): JsonView[] {
        const out = [...node.views];
        for (const c of node.entrys as JsonDataDB[]) {out.push(...this._collectAllViews(c));}
        return out;
    }

    private _findViewInProject(viewUnid: string): JsonView | null {
        if (!this._activeProject) {return null;}
        for (const v of this._collectAllViews(this._activeProject.data)) {
            if (v.unid === viewUnid) {return v;}
        }
        return null;
    }

    /**
     * Single-membership picker for a view. Opens the same
     * `LayerPickerDialog` used for bulk-table assignment so the UI is
     * consistent. Empty selection clears the assignment. Views don't
     * yet support multi-diagram membership, hence the single-select
     * flavour.
     */
    private async _pickLayerForView(viewUnid: string): Promise<void> {
        if (!this._activeProject) {return;}
        const view = this._findViewInProject(viewUnid);
        if (!view) {return;}
        const container = this._activeContainerUnid
            ? this._findContainer(this._activeProject.data, this._activeContainerUnid)
            : null;
        const layers = container ? this._collectLayers(container) : [];
        if (layers.length === 0) {return;}
        const result = await new LayerPickerDialog(layers, 1, view.layerUnid ?? null).show();
        if (result === null) {return;}
        await this._mutate(p => this._api.updateView(p.unid, viewUnid, {layerUnid: result}));
        await this._reload();
    }

    /**
     * Open the table-options editor for one table and persist the
     * full new options object via `updateTable`. The repo treats
     * `options` as a replacement, so we always send the complete
     * dialog result rather than a diff.
     */
    private async _editTableOptions(tableUnid: string): Promise<void> {
        if (!this._activeProject) {return;}
        const all = this._collectAllTables(this._activeProject.data);
        const table = all.find(t => t.unid === tableUnid);
        if (!table) {return;}
        const result = await new DbTableOptionsDialog(table.name, table.options).show();
        if (!result) {return;}
        await this._mutate(p => this._api.updateTable(p.unid, tableUnid, { options: result }));
        await this._reload();
    }

    /**
     * Open the enum value editor and diff its result against the
     * current state, firing the necessary add/update/remove API calls.
     * Single reload at the end so the canvas/treeview both refresh.
     */
    private async _editEnum(unid: string): Promise<void> {
        if (!this._activeProject) {return;}
        const enumNode = this._findEnum(this._activeProject.data, unid);
        if (!enumNode) {return;}

        const result = await new DbEnumDialog(enumNode).show();
        if (!result) {return;}

        const pid = this._activeProject.unid;
        const oldByUnid = new Map(enumNode.values.map(v => [v.unid, v.value]));
        const keptUnids = new Set<string>();

        try {
            if (result.name !== enumNode.name) {
                await this._api.updateEnum(pid, unid, { name: result.name });
            }
            for (const v of result.values) {
                if (v.unid === null) {
                    // eslint-disable-next-line no-await-in-loop -- sequential to preserve order
                    await this._api.addEnumValue(pid, unid, v.value);
                } else {
                    keptUnids.add(v.unid);
                    if (oldByUnid.get(v.unid) !== v.value) {
                        // eslint-disable-next-line no-await-in-loop -- sequential to preserve order
                        await this._api.updateEnumValue(pid, unid, v.unid, v.value);
                    }
                }
            }
            for (const old of enumNode.values) {
                if (!keptUnids.has(old.unid)) {
                    // eslint-disable-next-line no-await-in-loop -- sequential to preserve order
                    await this._api.removeEnumValue(pid, unid, old.unid);
                }
            }
        } catch (err) {
            console.error('[DbEditor] enum edit failed', err);
            await AlertDialog.showAlert('Enum edit failed', String(err));
        }
        await this._reload();
    }

    /** Locate an enum node anywhere in the data tree. */
    private _findEnum(node: JsonDataDB, unid: string): JsonEnum | null {
        for (const e of node.enums) {if (e.unid === unid) {return e;}}
        for (const child of node.entrys as JsonDataDB[]) {
            const hit = this._findEnum(child, unid);
            if (hit) {return hit;}
        }
        return null;
    }

    /** Locate a view node anywhere in the data tree. */
    private _findView(node: JsonDataDB, unid: string): JsonView | null {
        for (const v of node.views) {if (v.unid === unid) {return v;}}
        for (const child of node.entrys as JsonDataDB[]) {
            const hit = this._findView(child, unid);
            if (hit) {return hit;}
        }
        return null;
    }

    /**
     * Open the view editor (name + SELECT body + materialized) and
     * persist via `updateView`. Single dialog → single API call → reload.
     */
    private async _editView(unid: string): Promise<void> {
        if (!this._activeProject) {return;}
        const view = this._findView(this._activeProject.data, unid);
        if (!view) {return;}
        const result = await new DbViewDialog(view).show();
        if (!result) {return;}
        await this._mutate(p => this._api.updateView(p.unid, unid, {
            name: result.name,
            select: result.select,
            materialized: result.materialized,
            description: result.description
        }));
        await this._reload();
    }

    private _findRoutine(node: JsonDataDB, unid: string): JsonRoutine | null {
        for (const r of node.routines ?? []) {if (r.unid === unid) {return r;}}
        for (const child of node.entrys as JsonDataDB[]) {
            const hit = this._findRoutine(child, unid);
            if (hit) {return hit;}
        }
        return null;
    }

    private async _editRoutine(unid: string): Promise<void> {
        if (!this._activeProject) {return;}
        const routine = this._findRoutine(this._activeProject.data, unid);
        if (!routine) {return;}
        const result = await new DbRoutineDialog(routine).show();
        if (!result) {return;}
        await this._mutate(p => this._api.updateRoutine(p.unid, unid, {
            name: result.name,
            kind: result.kind,
            body: result.body,
            description: result.description
        }));
        await this._reload();
    }

    /**
     * Build the new full column-order array for a reorder request.
     * `beforeColumnUnid` is null when the column is being moved to the
     * end. Returns null if the table or column can't be located.
     */
    private _buildReorderedColumnOrder(tableUnid: string, columnUnid: string, beforeColumnUnid: string | null): string[] | null {
        if (!this._activeProject) {return null;}
        const tables = this._collectAllTables(this._activeProject.data);
        const table = tables.find(t => t.unid === tableUnid);
        if (!table) {return null;}
        const remaining = table.columns.filter(c => c.unid !== columnUnid).map(c => c.unid);
        if (beforeColumnUnid === null) {return [...remaining, columnUnid];}
        const idx = remaining.indexOf(beforeColumnUnid);
        if (idx === -1) {return null;}
        return [...remaining.slice(0, idx), columnUnid, ...remaining.slice(idx)];
    }

}