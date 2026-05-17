import {JsonDataDB, JsonDataDBType, JsonRoutineKind} from '../JsonData.js';
import {dispatch, EditorEvents} from '../Base/EditorEvents.js';
import {openContextMenu, ContextMenuItem} from '../Base/ContextMenu.js';
import {ConfirmDialog} from '../Base/ConfirmDialog.js';
import {
    iconChevronDown,
    iconChevronRight,
    iconDatabase,
    iconDiamondHollow,
    iconDot,
    iconEllipsis,
    iconEye,
    iconFolder,
    iconProject,
    iconRect,
    iconTable
} from '../Util/Icons.js';

export type TreeviewMode = 'model' | 'live';

/**
 * Sidebar tree. Renders projects → databases → folders → tables/enums.
 * Clicking a database (or any container) sets it as the active container
 * shown on the canvas. Each row has a `⋯` button that opens a context
 * menu with type-appropriate actions (add child, rename, delete).
 *
 * In `live` mode, the data comes from the live-DB introspector rather
 * than the model file. Edit actions are hidden — only "Refresh from DB"
 * remains. The mode toggle sits at the top of the panel.
 */
export class Treeview {

    private _el: HTMLElement;
    private _activeUnid: string | null = null;
    private _activeDiagramUnid: string | null = null;
    private _filter = '';
    private _mode: TreeviewMode = 'model';
    private _connectableDatabaseUnids = new Set<string>();
    private _onModeChange: ((mode: TreeviewMode) => void) | null = null;

    public constructor(el: HTMLElement) {
        this._el = el;
    }

    public get activeUnid(): string | null { return this._activeUnid; }
    public get mode(): TreeviewMode { return this._mode; }

    /** Provide the controller's callback so the toggle can trigger a re-render with live data. */
    public setOnModeChange(fn: (mode: TreeviewMode) => void): void {
        this._onModeChange = fn;
    }

    /** Which database containers (by `unid`) have a live-DB connection configured. */
    public setConnectableDatabaseUnids(unids: string[]): void {
        this._connectableDatabaseUnids = new Set(unids);
    }

    public setMode(mode: TreeviewMode): void {
        this._mode = mode;
    }

    public render(projects: { unid: string; name: string; data: JsonDataDB; }[]): void {
        this._el.replaceChildren();
        this._el.append(this._renderModeBar());
        if (!projects.length) {
            const empty = document.createElement('div');
            empty.className = 'treeview-empty';
            empty.textContent = 'No projects configured.\nAdd one in dbeditor.json.';
            this._el.append(empty);
            return;
        }
        for (const p of projects) {
            this._el.append(this._renderProjectNode(p));
        }
        // auto-activate the first database we find if nothing is active yet
        if (!this._activeUnid) {
            const firstDb = this._findFirstDatabase(projects[0].data);
            if (firstDb) {this.setActive(firstDb.unid);}
        }
        this._applyFilter();
    }

    private _renderModeBar(): HTMLElement {
        const bar = document.createElement('div');
        bar.className = `treeview-modebar treeview-modebar--${this._mode}`;
        const mkBtn = (label: string, mode: TreeviewMode): HTMLButtonElement => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `treeview-modebar-btn${this._mode === mode ? ' active' : ''}`;
            b.textContent = label;
            b.addEventListener('click', () => {
                if (this._mode === mode) {return;}
                this._mode = mode;
                this._onModeChange?.(mode);
            });
            return b;
        };
        const modelBtn = mkBtn('Modell', 'model');
        const liveBtn = mkBtn('Live', 'live');
        const connCount = this._connectableDatabaseUnids.size;
        if (connCount > 0) {
            const badge = document.createElement('span');
            badge.className = 'treeview-modebar-badge';
            badge.textContent = String(connCount);
            liveBtn.append(' ', badge);
            liveBtn.title = `${connCount} live DB connection${connCount === 1 ? '' : 's'} configured`;
        } else {
            liveBtn.title = 'No live DB connections — add one in dbeditor.json';
        }
        bar.append(modelBtn, liveBtn);
        return bar;
    }

    /**
     * Substring (case-insensitive) filter applied across the rendered
     * tree. An empty query shows everything. A non-empty query hides
     * any leaf row whose name doesn't match, but keeps ancestor rows
     * visible so the structure stays readable.
     */
    public setFilter(query: string): void {
        this._filter = query.trim().toLowerCase();
        this._applyFilter();
    }

    private _applyFilter(): void {
        const q = this._filter;
        const allEntries = Array.from(this._el.querySelectorAll<HTMLElement>('.treeview-entry'));
        const buckets = Array.from(this._el.querySelectorAll<HTMLElement>('.treeview-bucket'));
        if (!q) {
            for (const e of allEntries) {
                e.classList.remove('treeview-entry--hidden');
            }
            for (const b of buckets) {
                b.classList.remove('treeview-entry--hidden');
            }
            /* Restore per-bucket collapse to persisted state. */
            this._el.classList.remove('treeview--filter-active');
            return;
        }
        /*
         * Filter active. Two visibility passes — entries first, then
         * buckets get hidden if none of their contained entries match.
         * Also force-expand all buckets (via the root class) so a
         * collapsed Tables bucket containing a match still shows.
         */
        this._el.classList.add('treeview--filter-active');

        // First pass: mark every entry whose own row's name matches.
        const matched = new Set<HTMLElement>();
        for (const e of allEntries) {
            const name = e.querySelector<HTMLElement>(':scope > .treeview-entry-row .treeview-entry-name')
            ?.textContent?.toLowerCase() ?? '';
            if (name.includes(q)) {
                matched.add(e);
            }
        }
        /*
         * Second pass: also keep an entry visible if it has a matched
         * descendant — that way ancestors of matches stay readable.
         */
        const ancestorsOfMatch = new Set<HTMLElement>();
        for (const m of matched) {
            let cur: HTMLElement | null = m.parentElement?.closest('.treeview-entry') ?? null;
            while (cur) {
                ancestorsOfMatch.add(cur);
                cur = cur.parentElement?.closest('.treeview-entry') ?? null;
            }
        }
        for (const e of allEntries) {
            const visible = matched.has(e) || ancestorsOfMatch.has(e);
            e.classList.toggle('treeview-entry--hidden', !visible);
        }
        /*
         * Third pass: hide buckets with no visible child rows so the
         * "Tables (51)" header doesn't leave a misleading count when
         * the filter has narrowed it to zero matches.
         */
        for (const b of buckets) {
            const anyMatch = b.querySelector('.treeview-entry:not(.treeview-entry--hidden)');
            b.classList.toggle('treeview-entry--hidden', !anyMatch);
        }
    }

    public setActive(unid: string): void {
        this._activeUnid = unid;
        this._activeDiagramUnid = null;
        this._el.querySelectorAll('.treeview-entry-row').forEach(el => {
            el.classList.remove('active');
            el.classList.remove('diagram-scope-active');
        });
        const row = this._el.querySelector(`.treeview-entry-row[data-unid="${unid}"]`);
        if (row) {row.classList.add('active');}
        dispatch(EditorEvents.activateContainer, { unid: unid });
    }

    /**
     * Scope the canvas to one EER-diagram (diagram): activates the
     * diagram's parent database AND filters tables to those whose
     * `diagramUnid` matches. Re-paints the row markers so the diagram
     * row gets `.diagram-scope-active` and the database row gets the
     * normal `.active` marker.
     */
    public setActiveDiagram(diagramUnid: string, parentDbUnid: string): void {
        this._activeUnid = parentDbUnid;
        this._activeDiagramUnid = diagramUnid;
        this._el.querySelectorAll('.treeview-entry-row').forEach(el => {
            el.classList.remove('active');
            el.classList.remove('diagram-scope-active');
        });
        const dbRow = this._el.querySelector(`.treeview-entry-row[data-unid="${parentDbUnid}"]`);
        if (dbRow) {dbRow.classList.add('active');}
        const layerRow = this._el.querySelector(`.treeview-entry-row[data-unid="${diagramUnid}"]`);
        if (layerRow) {layerRow.classList.add('diagram-scope-active');}
        dispatch(EditorEvents.scopeToDiagram, { diagramUnid: diagramUnid, containerUnid: parentDbUnid });
    }

    private _renderProjectNode(p: { unid: string; name: string; data: JsonDataDB; }): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'treeview-entry';
        /*
         * The project row's `unid` for menu purposes is the data tree
         * root (`p.data.unid` ≈ "root"), NOT the runtime project UUID.
         * The repo's `createContainer(parentUnid, …)` looks up parents in
         * the data tree, so passing the runtime UUID would 404.
         */
        const row = this._buildRow(p.data.unid, p.name, iconProject(), JsonDataDBType.project);
        wrap.append(row);
        const children = document.createElement('div');
        children.className = 'treeview-entry-children';
        for (const child of (p.data.entrys as JsonDataDB[])) {
            children.append(this._renderNode(child));
        }
        wrap.append(children);
        return wrap;
    }

    private _renderNode(node: JsonDataDB): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'treeview-entry';
        const icon = this._iconFor(node.type as JsonDataDBType);
        const row = this._buildRow(node.unid, node.name, icon, node.type as JsonDataDBType);
        wrap.append(row);
        const isContainer = node.type === JsonDataDBType.database || node.type === JsonDataDBType.folder;
        const hasChildren = (node.entrys && node.entrys.length)
            || node.tables.length || node.enums.length || node.views.length
            || (node.routines && node.routines.length)
            || (node.diagrams && node.diagrams.length);
        /*
         * Containers always render their bucket structure so the
         * empty-state "+ Add X" hints are reachable on a fresh
         * database. Non-container leafs only render children when
         * they have any.
         */
        if (hasChildren || isContainer) {
            const children = document.createElement('div');
            children.className = 'treeview-entry-children';
            /* Folders/databases render entries (sub-containers) inline; non-container nodes don't have entrys-as-children. */
            for (const child of (node.entrys as JsonDataDB[])) {children.append(this._renderNode(child));}
            if (isContainer) {
                /*
                 * Group leafs by type into collapsible buckets so a
                 * database with 51 tables + 16 layers + a few views
                 * stays browsable. Each bucket's open/closed state
                 * persists in localStorage per (parentUnid, kind).
                 * Empty buckets are skipped — no "Views (0)" noise.
                 */
                const layers = node.diagrams ?? [];
                const routines = node.routines ?? [];
                /*
                 * Render all buckets unconditionally so empty ones can
                 * show a "+ Add X" hint and the user discovers where to
                 * click to populate the database. Each bucket carries
                 * an `addHint` config the bucket renderer falls back to
                 * when `items.length === 0`. EER diagrams are
                 * database-scoped, so the diagram bucket only renders on
                 * a database, never on a folder.
                 */
                if (node.type === JsonDataDBType.database) {
                    children.append(this._renderBucket(
                        node.unid, 'layers', 'EER diagrams', JsonDataDBType.diagram,
                        layers.map(l => ({unid: l.unid, name: l.name, parentDbUnid: node.unid})),
                        {
                            label: '+ Add EER diagram',
                            event: EditorEvents.createDiagramIn,
                            promptLabel: 'New EER diagram name?',
                            suggested: 'New diagram'
                        }
                    ));
                }
                children.append(this._renderBucket(
                    node.unid, 'tables', 'Tables', JsonDataDBType.table,
                    node.tables.map(t => ({unid: t.unid, name: t.name, parentDbUnid: node.unid})),
                    {
                        label: '+ Add table',
                        event: EditorEvents.createTableIn,
                        promptLabel: 'New table name?',
                        suggested: 'new_table'
                    }
                ));
                children.append(this._renderBucket(
                    node.unid, 'views', 'Views', JsonDataDBType.view,
                    node.views.map(v => ({unid: v.unid, name: v.name, parentDbUnid: node.unid})),
                    {
                        label: '+ Add view',
                        event: EditorEvents.createViewIn,
                        promptLabel: 'New view name?',
                        suggested: 'new_view'
                    }
                ));
                children.append(this._renderBucket(
                    node.unid, 'enums', 'Enums', JsonDataDBType.enum,
                    node.enums.map(e => ({unid: e.unid, name: e.name, parentDbUnid: node.unid})),
                    {
                        label: '+ Add enum',
                        event: EditorEvents.createEnumIn,
                        promptLabel: 'New enum name?',
                        suggested: 'new_enum'
                    }
                ));
                children.append(this._renderBucket(
                    node.unid, 'routines', 'Routines', JsonDataDBType.routine,
                    routines.map(r => ({unid: r.unid, name: r.name, parentDbUnid: node.unid})),
                    {
                        label: '+ Add routine',
                        event: EditorEvents.createRoutineIn,
                        promptLabel: 'New routine name?',
                        suggested: 'new_routine',
                        extraPayload: {kind: JsonRoutineKind.procedure}
                    }
                ));
            } else {
                /* Pre-bucket layout for non-container nodes (which don't usually have leafs anyway). */
                for (const t of node.tables) {children.append(this._renderLeaf(t.unid, t.name, JsonDataDBType.table));}
                for (const e of node.enums) {children.append(this._renderLeaf(e.unid, e.name, JsonDataDBType.enum));}
                for (const v of node.views) {children.append(this._renderLeaf(v.unid, v.name, JsonDataDBType.view));}
                for (const r of node.routines ?? []) {children.append(this._renderLeaf(r.unid, r.name, JsonDataDBType.routine));}
                for (const l of node.diagrams ?? []) {children.append(this._renderLeaf(l.unid, l.name, JsonDataDBType.diagram));}
            }
            wrap.append(children);
        }
        return wrap;
    }

    /**
     * Build a collapsible bucket: header row with toggle arrow + label
     * + count, followed by a list of leaf rows. State persists in
     * localStorage so the user's open/closed choice survives reload.
     */
    private _renderBucket(
        parentUnid: string,
        kind: string,
        label: string,
        leafType: JsonDataDBType,
        items: {unid: string; name: string; parentDbUnid: string;}[],
        addHint?: {
            label: string;
            event: string;
            promptLabel: string;
            suggested: string;
            extraPayload?: Record<string, unknown>;
        }
    ): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'treeview-bucket';
        const storageKey = `dbeditor.tv.bucket.${parentUnid}.${kind}`;
        const collapsed = localStorage.getItem(storageKey) === '0';

        const header = document.createElement('div');
        header.className = 'treeview-bucket-header';
        const toggle = document.createElement('span');
        toggle.className = 'treeview-bucket-toggle';
        toggle.replaceChildren(collapsed ? iconChevronRight() : iconChevronDown());
        const icon = document.createElement('span');
        icon.className = 'treeview-bucket-icon';
        const iconNode = this._iconFor(leafType);
        if (typeof iconNode === 'string') {icon.textContent = iconNode;}
        else {icon.replaceChildren(iconNode);}
        const lbl = document.createElement('span');
        lbl.className = 'treeview-bucket-label';
        lbl.textContent = `${label} (${items.length})`;
        header.append(toggle, icon, lbl);

        const list = document.createElement('div');
        list.className = 'treeview-bucket-list';
        if (collapsed) {list.classList.add('treeview-bucket-list--collapsed');}
        for (const item of items) {
            list.append(this._renderLeaf(item.unid, item.name, leafType, item.parentDbUnid));
        }
        /*
         * Empty-state hint: a faint "+ Add X" row that triggers the
         * same prompt + dispatch as the container's context-menu add
         * action. Hidden in live mode since the live tree is read-only
         * by design.
         */
        if (items.length === 0 && addHint && this._mode !== 'live') {
            const hint = document.createElement('div');
            hint.className = 'treeview-bucket-empty-hint';
            hint.textContent = addHint.label;
            hint.addEventListener('click', () => {
                const v = window.prompt(addHint.promptLabel, addHint.suggested);
                const trimmed = v === null ? null : v.trim() || null;
                if (!trimmed) {return;}
                const extra = addHint.extraPayload ?? {};
                dispatch(addHint.event, {
                    containerUnid: parentUnid,
                    name: trimmed,
                    ...extra
                });
            });
            list.append(hint);
        }

        header.addEventListener('click', () => {
            const next = !list.classList.contains('treeview-bucket-list--collapsed');
            list.classList.toggle('treeview-bucket-list--collapsed', next);
            toggle.replaceChildren(next ? iconChevronRight() : iconChevronDown());
            localStorage.setItem(storageKey, next ? '0' : '1');
        });

        wrap.append(header, list);
        return wrap;
    }

    private _renderLeaf(unid: string, name: string, type: JsonDataDBType, parentDbUnid?: string): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'treeview-entry';
        const row = this._buildRow(unid, name, this._iconFor(type), type, parentDbUnid);
        wrap.append(row);
        return wrap;
    }

    /**
     * Per-node-kind icon. All returned as inline SVG so they render
     * font-independently — previous SMP-emoji versions (🛢 📁 ⬜ 👁 🗄)
     * rendered as tofu boxes on Linux without an installed emoji
     * font. `routine` keeps the basic-Latin `ƒ` since it's covered
     * by every default font stack.
     */
    private _iconFor(type: JsonDataDBType): string | SVGSVGElement {
        switch (type) {
            case JsonDataDBType.database: return iconDatabase();
            case JsonDataDBType.folder:   return iconFolder();
            case JsonDataDBType.table:    return iconTable();
            case JsonDataDBType.enum:     return iconDiamondHollow();
            case JsonDataDBType.view:     return iconEye();
            case JsonDataDBType.routine:  return 'ƒ';
            case JsonDataDBType.diagram:    return iconRect();
            case JsonDataDBType.project:  return iconProject();
            default:                      return iconDot();
        }
    }

    private _buildRow(unid: string, name: string, icon: string | SVGSVGElement, type: JsonDataDBType, parentDbUnid?: string): HTMLElement {
        const row = document.createElement('div');
        row.className = 'treeview-entry-row';
        row.dataset.unid = unid;
        row.dataset.type = type;
        if (parentDbUnid) {row.dataset.parentUnid = parentDbUnid;}
        const iconEl = document.createElement('span');
        iconEl.className = 'treeview-entry-icon';
        if (typeof icon === 'string') {iconEl.textContent = icon;}
        else {iconEl.replaceChildren(icon);}
        const nameEl = document.createElement('span');
        nameEl.className = 'treeview-entry-name';
        nameEl.textContent = name;
        row.append(iconEl, nameEl);

        /*
         * Only databases and folders can be activated as the canvas
         * container. The project (root) row is informational + holds the
         * "Add database" menu.
         */
        if (type === JsonDataDBType.database || type === JsonDataDBType.folder) {
            row.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('.treeview-row-more')) {return;}
                this.setActive(unid);
            });
        }
        /*
         * Double-click a leaf to open its editor (only enum is wired up
         * for now — table editing happens on the canvas, view editor
         * doesn't exist yet).
         */
        if (type === JsonDataDBType.enum) {
            row.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                dispatch(EditorEvents.editEnum, { unid: unid });
            });
        }
        if (type === JsonDataDBType.view) {
            row.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                dispatch(EditorEvents.editView, { unid: unid });
            });
        }
        /*
         * Click an EER-diagram (diagram) row to scope the canvas to its
         * member tables only. The controller activates the parent
         * database, then filters by `diagramUnid`. Re-clicking the
         * database (or another container) clears the scope.
         */
        if (type === JsonDataDBType.diagram && parentDbUnid) {
            row.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('.treeview-row-more')) {return;}
                this.setActiveDiagram(unid, parentDbUnid);
            });
        }

        /*
         * HTML5 DnD: table rows are draggable, diagram rows are valid
         * drop targets. Drop sets the table's `diagramUnid` to the
         * target diagram's unid. The actual mutation lives in the
         * controller via the `pickDiagramForTables` flow — we cheat
         * here and dispatch a custom event that the controller
         * already knows how to handle (passing a single tableUnid +
         * diagramUnid skips the picker dialog).
         */
        if (type === JsonDataDBType.table) {
            row.draggable = true;
            row.addEventListener('dragstart', (e) => {
                if (!e.dataTransfer) {return;}
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('application/x-dbeditor-table-unid', unid);
                /* Plaintext fallback so dragging into a text editor surfaces the name. */
                e.dataTransfer.setData('text/plain', name);
            });
        }
        if (type === JsonDataDBType.diagram) {
            row.addEventListener('dragover', (e) => {
                if (!e.dataTransfer?.types.includes('application/x-dbeditor-table-unid')) {return;}
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                row.classList.add('treeview-entry-row--drop-target');
            });
            row.addEventListener('dragleave', () => {
                row.classList.remove('treeview-entry-row--drop-target');
            });
            row.addEventListener('drop', (e) => {
                row.classList.remove('treeview-entry-row--drop-target');
                const tableUnid = e.dataTransfer?.getData('application/x-dbeditor-table-unid');
                if (!tableUnid) {return;}
                e.preventDefault();
                dispatch(EditorEvents.assignTableToDiagram, {tableUnid: tableUnid, diagramUnid: unid});
            });
        }

        const more = document.createElement('button');
        more.className = 'treeview-row-more';
        more.replaceChildren(iconEllipsis());
        more.title = 'More actions';
        more.addEventListener('click', (e) => {
            e.stopPropagation();
            const items = this._menuItemsFor(type, unid, name, nameEl);
            if (items.length) {openContextMenu(more, items);}
        });
        row.append(more);
        return row;
    }

    /**
     * Replace the row's name span with an inline `<input>`. Commit on
     * Enter or blur (calls onCommit with the new name); revert on Escape.
     * Same UX as `DbTable._renameInline` — the user already knows it from
     * renaming tables on the canvas.
     */
    private _startInlineRename(nameEl: HTMLSpanElement, currentName: string, onCommit: (next: string) => void): void {
        const input = document.createElement('input');
        input.className = 'treeview-rename-input';
        input.value = currentName;
        nameEl.replaceWith(input);
        input.focus();
        input.select();

        let committed = false;
        const commit = (): void => {
            if (committed) {return;}
            committed = true;
            const next = input.value.trim();
            /*
             * Restore the span first so the next render doesn't fight a
             * stray input element if the API call/reload races.
             */
            input.replaceWith(nameEl);
            if (next && next !== currentName) {onCommit(next);}
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                committed = true;
                input.replaceWith(nameEl);
            }
            /*
             * Don't bubble — Escape would otherwise close any open menu
             * before commit/cancel runs.
             */
            e.stopPropagation();
        });
        // Stop clicks inside the input from triggering row activation.
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('click', (e) => e.stopPropagation());
    }

    private _menuItemsFor(type: JsonDataDBType, unid: string, name: string, nameEl: HTMLSpanElement): ContextMenuItem[] {
        const items: ContextMenuItem[] = [];
        const promptName = (label: string, suggested = ''): string | null => {
            const v = window.prompt(label, suggested);
            return v === null ? null : v.trim() || null;
        };
        const isLive = this._mode === 'live';

        /*
         * Live mode: only "Refresh from DB" + "Sync with DB" remain on
         * database rows. All edit actions are hidden — the live tree is
         * read-only by design.
         */
        if (isLive) {
            if (type === JsonDataDBType.database && this._connectableDatabaseUnids.has(unid)) {
                items.push({ label: 'Refresh from DB', onClick: () => {
                    dispatch(EditorEvents.refreshLive, { databaseUnid: unid });
                }});
                items.push({ label: 'Sync with DB…', onClick: () => {
                    dispatch(EditorEvents.openSyncDialog, { databaseUnid: unid });
                }});
            }
            return items;
        }

        if (type === JsonDataDBType.project) {
            items.push({ label: 'Add database', onClick: () => {
                const n = promptName('New database name?', 'new_db');
                if (n) {dispatch(EditorEvents.createContainer, { parentUnid: unid, type: JsonDataDBType.database, name: n });}
            }});
            items.push({ label: 'Add folder', onClick: () => {
                const n = promptName('New folder name?', 'new_folder');
                if (n) {dispatch(EditorEvents.createContainer, { parentUnid: unid, type: JsonDataDBType.folder, name: n });}
            }});
        } else if (type === JsonDataDBType.database || type === JsonDataDBType.folder) {
            items.push({ label: 'Add folder', onClick: () => {
                const n = promptName('New folder name?', 'new_folder');
                if (n) {dispatch(EditorEvents.createContainer, { parentUnid: unid, type: JsonDataDBType.folder, name: n });}
            }});
            items.push({ label: 'Add table', onClick: () => {
                const n = promptName('New table name?', 'new_table');
                if (n) {dispatch(EditorEvents.createTableIn, { containerUnid: unid, name: n });}
            }});
            items.push({ label: 'Add enum', onClick: () => {
                const n = promptName('New enum name?', 'new_enum');
                if (n) {dispatch(EditorEvents.createEnumIn, { containerUnid: unid, name: n });}
            }});
            items.push({ label: 'Add view', onClick: () => {
                const n = promptName('New view name?', 'new_view');
                if (n) {dispatch(EditorEvents.createViewIn, { containerUnid: unid, name: n });}
            }});
            items.push({ label: 'Add routine', onClick: () => {
                const n = promptName('New routine name?', 'new_routine');
                if (n) {dispatch(EditorEvents.createRoutineIn, { containerUnid: unid, name: n, kind: 'procedure' });}
            }});
            /*
             * Add-EER-diagram only makes sense on a database (diagrams
             * are database-scoped; folders are organisational rather
             * than visual). Sits right after the "Add view/routine"
             * group so it's adjacent to the other "structural adds".
             */
            if (type === JsonDataDBType.database) {
                items.push({ label: 'Add EER diagram', onClick: () => {
                    const n = promptName('New EER diagram name?', 'New diagram');
                    if (n) {dispatch(EditorEvents.createDiagramIn, { containerUnid: unid, name: n });}
                }});
            }
            if (type === JsonDataDBType.database && this._connectableDatabaseUnids.has(unid)) {
                items.push({ kind: 'separator' });
                items.push({ label: 'Sync with DB…', onClick: () => {
                    dispatch(EditorEvents.openSyncDialog, { databaseUnid: unid });
                }});
            }
            if (type === JsonDataDBType.database) {
                items.push({ kind: 'separator' });
                items.push({ label: 'Generate SQL (this DB)…', onClick: () => {
                    dispatch(EditorEvents.generateScoped, { databaseUnid: unid });
                }});
                /*
                 * Database-level defaults (engine / charset /
                 * collation) inherited by every contained table. Set
                 * once here, no need to fiddle with per-table
                 * options on 50+ cards.
                 */
                items.push({ label: 'Database properties…', onClick: () => {
                    dispatch(EditorEvents.openDatabaseProperties, { unid: unid });
                }});
            }
            items.push({ kind: 'separator' });
            items.push({ label: 'Rename', onClick: () => {
                this._startInlineRename(nameEl, name, (n) =>
                    dispatch(EditorEvents.renameContainer, { unid: unid, name: n }));
            }});
            items.push({ label: 'Delete', danger: true, onClick: async() => {
                const ok = await ConfirmDialog.showConfirm('Delete container',
                    `Delete "${name}" and everything inside it?`, 'danger');
                if (ok) {dispatch(EditorEvents.deleteContainer, { unid: unid });}
            }});
        } else if (type === JsonDataDBType.table) {
            items.push({ label: 'Generate SQL (this table)…', onClick: () => {
                dispatch(EditorEvents.generateScoped, { tableUnid: unid });
            }});
            items.push({ kind: 'separator' });
            /*
             * Assign-to-diagram parallels the canvas card's ⋯ menu —
             * lets the user manage diagram membership without first
             * opening the database canvas + finding the card. The
             * picker takes one or more tableUnids and the existing
             * `pickDiagramForTables` event handles it identically.
             */
            items.push({ label: 'Assign to EER diagram…', onClick: () => {
                dispatch(EditorEvents.pickDiagramForTables, { tableUnids: [unid] });
            }});
            items.push({ label: 'Duplicate', onClick: () => {
                dispatch(EditorEvents.duplicateTable, { tableUnid: unid });
            }});
            items.push({ label: 'Rename', onClick: () => {
                this._startInlineRename(nameEl, name, (n) =>
                    dispatch(EditorEvents.renameTable, { tableUnid: unid, name: n }));
            }});
            items.push({ label: 'Delete', danger: true, onClick: async() => {
                const ok = await ConfirmDialog.showConfirm('Delete table',
                    `Delete table "${name}" and all its columns?`, 'danger');
                if (ok) {dispatch(EditorEvents.deleteTable, { tableUnid: unid });}
            }});
        } else if (type === JsonDataDBType.routine) {
            items.push({ label: 'Edit body…', onClick: () => {
                dispatch(EditorEvents.editRoutine, { unid: unid });
            }});
            items.push({ kind: 'separator' });
            items.push({ label: 'Rename', onClick: () => {
                this._startInlineRename(nameEl, name, (n) =>
                    dispatch(EditorEvents.renameRoutine, { unid: unid, name: n }));
            }});
            items.push({ label: 'Delete', danger: true, onClick: async() => {
                const ok = await ConfirmDialog.showConfirm('Delete routine',
                    `Delete routine "${name}"?`, 'danger');
                if (ok) {dispatch(EditorEvents.deleteRoutine, { unid: unid });}
            }});
        } else if (type === JsonDataDBType.enum) {
            items.push({ label: 'Edit values', onClick: () => {
                dispatch(EditorEvents.editEnum, { unid: unid });
            }});
            items.push({ kind: 'separator' });
            items.push({ label: 'Rename', onClick: () => {
                this._startInlineRename(nameEl, name, (n) =>
                    dispatch(EditorEvents.renameEnum, { unid: unid, name: n }));
            }});
            items.push({ label: 'Delete', danger: true, onClick: async() => {
                const ok = await ConfirmDialog.showConfirm('Delete enum',
                    `Delete enum "${name}"?`, 'danger');
                if (ok) {dispatch(EditorEvents.deleteEnum, { unid: unid });}
            }});
        } else if (type === JsonDataDBType.view) {
            items.push({ label: 'Edit view…', onClick: () => {
                dispatch(EditorEvents.editView, { unid: unid });
            }});
            items.push({ kind: 'separator' });
            items.push({ label: 'Rename', onClick: () => {
                this._startInlineRename(nameEl, name, (n) =>
                    dispatch(EditorEvents.renameView, { unid: unid, name: n }));
            }});
            items.push({ label: 'Delete', danger: true, onClick: async() => {
                const ok = await ConfirmDialog.showConfirm('Delete view',
                    `Delete view "${name}"?`, 'danger');
                if (ok) {dispatch(EditorEvents.deleteView, { unid: unid });}
            }});
        } else if (type === JsonDataDBType.diagram) {
            items.push({ label: 'Generate SQL (this diagram)…', onClick: () => {
                dispatch(EditorEvents.generateScoped, { diagramUnid: unid, layerName: name });
            }});
            /*
             * Diagram-scoped sync: only fires if the diagram's parent
             * database has a live connection configured. The
             * controller checks `connectableDatabaseUnids` after
             * resolving the parent DB and shows an alert if no
             * connection exists, so the menu item is always present
             * (discoverability > hiding-when-unconfigured).
             */
            items.push({ label: 'Sync this diagram with DB…', onClick: () => {
                dispatch(EditorEvents.openSyncDialog, { diagramUnid: unid, layerName: name });
            }});
            items.push({ kind: 'separator' });
            items.push({ label: 'Rename', onClick: () => {
                this._startInlineRename(nameEl, name, (n) =>
                    dispatch(EditorEvents.renameDiagram, { unid: unid, name: n }));
            }});
            items.push({ label: 'Delete', danger: true, onClick: async() => {
                const ok = await ConfirmDialog.showConfirm('Delete EER diagram',
                    `Delete diagram "${name}"? Tables inside are not deleted; their diagram reference becomes empty.`, 'danger');
                if (ok) {dispatch(EditorEvents.deleteDiagram, { unid: unid });}
            }});
        }
        return items;
    }

    private _findFirstDatabase(node: JsonDataDB): JsonDataDB | null {
        if (node.type === JsonDataDBType.database) {return node;}
        for (const child of (node.entrys as JsonDataDB[])) {
            const hit = this._findFirstDatabase(child);
            if (hit) {return hit;}
        }
        return null;
    }

}