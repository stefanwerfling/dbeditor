import {BrowserJsPlumbInstance} from '@jsplumb/browser-ui';
import {JsonTable, JsonColumn, JsonEnum, JsonIndex} from '../JsonData.js';
import {dispatch, EditorEvents} from '../Base/EditorEvents.js';
import {ConfirmDialog} from '../Base/ConfirmDialog.js';
import {openContextMenu} from '../Base/ContextMenu.js';
import {DbColumnDialog} from './DbColumnDialog.js';
import {DbIndexDialog} from './DbIndexDialog.js';
import {iconDiamondFilled, iconDiamondHollow, iconEllipsis} from '../Util/Icons.js';

/**
 * One draggable table card on the canvas. Owns the DOM, registers the
 * card with jsPlumb so it can be a connection source/target for FKs,
 * and emits high-level intent events (`addColumn`, `deleteTable`,
 * `tableMoved`, …) — never API-callable details.
 *
 * The controller owns the data; this class re-renders from data when
 * `setData()` is called.
 */
export type ActiveLayerContext = { unid: string; name: string; };

export class DbTable {

    private _el: HTMLDivElement;
    private _data: JsonTable;
    private readonly _jsp: BrowserJsPlumbInstance;
    private readonly _enums: JsonEnum[];
    private readonly _activeLayer: ActiveLayerContext | null;

    public constructor(
        table: JsonTable,
        jsp: BrowserJsPlumbInstance,
        enums: JsonEnum[],
        activeLayer: ActiveLayerContext | null = null
    ) {
        this._data = table;
        this._jsp = jsp;
        this._enums = enums;
        this._activeLayer = activeLayer;
        this._el = document.createElement('div');
        this._el.className = 'db-table';
        this._el.dataset.tableUnid = table.unid;
        this._el.style.left = `${table.pos.x}px`;
        this._el.style.top = `${table.pos.y}px`;
        this._render();
    }

    public get element(): HTMLDivElement { return this._el; }
    public get unid(): string { return this._data.unid; }
    public get data(): JsonTable { return this._data; }

    /**
     * Compute a jsPlumb anchor `[x, y, dx, dy]` that emerges from the
     * given column row's vertical center on the requested side of the
     * card. Falls back to mid-height if the row isn't found yet (during
     * initial layout passes when the DOM hasn't been measured).
     *
     * Uses `getBoundingClientRect` instead of `offsetTop / offsetHeight`
     * because the `.db-table-columns` wrapper carries `position:
     * relative` (for the drag-reorder drop indicator), which makes IT
     * the row's `offsetParent` — so `offsetTop` measures from inside
     * the columns wrapper, not from the card top. The relative-to-
     * card delta from getBoundingClientRect sidesteps that.
     */
    public getColumnAnchor(columnUnid: string, side: 'left' | 'right'): [number, number, number, number] {
        const x = side === 'right' ? 1 : 0;
        const dx = side === 'right' ? 1 : -1;
        const row = this._el.querySelector(`.db-table-column[data-column-unid="${columnUnid}"]`) as HTMLElement | null;
        const cardRect = this._el.getBoundingClientRect();
        const cardH = cardRect.height || 1;
        if (!row) {return [x, 0.5, dx, 0];}
        const rowRect = row.getBoundingClientRect();
        const rowCenter = (rowRect.top - cardRect.top) + (rowRect.height / 2);
        const yRatio = Math.max(0, Math.min(1, rowCenter / cardH));
        return [x, yRatio, dx, 0];
    }

    public setData(table: JsonTable): void {
        this._data = table;
        this._el.style.left = `${table.pos.x}px`;
        this._el.style.top = `${table.pos.y}px`;
        this._render();
        this._jsp.revalidate(this._el);
    }

    public attach(parent: HTMLElement): void {
        parent.append(this._el);
        this._jsp.manage(this._el);
        /*
         * dragstop: persist new position. We only fire tableMoved when
         * the position actually changed since the last mousedown — every
         * click on a card fires mouseup, and a no-op move would cause
         * FK re-anchoring to flicker on plain clicks.
         *
         * mousedown also marks this card as the canvas selection so
         * F2/Del shortcuts know which table to act on. Selection has
         * to fire on mousedown (not click) because a drag never emits
         * a click — the user would otherwise have to click+release
         * without moving to select.
         */
        let downX = 0; let downY = 0;
        this._el.addEventListener('mousedown', (e: MouseEvent) => {
            downX = parseFloat(this._el.style.left || '0');
            downY = parseFloat(this._el.style.top || '0');
            dispatch(EditorEvents.selectTable, {
                tableUnid: this._data.unid,
                additive: e.shiftKey,
                toggle: e.ctrlKey || e.metaKey
            });
        });
        this._el.addEventListener('mouseup', () => {
            const left = parseFloat(this._el.style.left || '0');
            const top = parseFloat(this._el.style.top || '0');
            if (left === downX && top === downY) {return;}
            dispatch(EditorEvents.tableMoved, { tableUnid: this._data.unid, x: left, y: top });
        });
    }

    public destroy(): void {
        this._jsp.unmanage(this._el);
        this._el.remove();
    }

    /**
     * Trigger the same inline rename that the header click / context-menu
     * "Rename table" entry uses. Public entry point so the F2 shortcut
     * can fire it from the controller without poking at private fields.
     */
    public startRename(): void {
        const title = this._el.querySelector('.db-table-header > span:first-child') as HTMLSpanElement | null;
        if (!title) {return;}
        this._renameInline(title);
    }

    // -----------------------------------------------------------------

    private _render(): void {
        this._el.replaceChildren(this._renderHeader(), this._renderColumns(), this._renderAddRow());
        const idx = this._renderIndexesSection();
        if (idx) {this._el.append(idx);}
        const fk = this._renderForeignKeysSection();
        if (fk) {this._el.append(fk);}
    }

    private _renderHeader(): HTMLDivElement {
        const h = document.createElement('div');
        h.className = 'db-table-header';
        /*
         * The header is a jsPlumb target-selector (see `jsPlumbInstance.ts`)
         * for the "drop FK on card → auto-create column" flow. jsPlumb's
         * `extract` reads attributes off the matched element directly, so
         * we mirror the table's unid here even though the card already
         * carries it.
         */
        h.dataset.tableUnid = this._data.unid;
        const title = document.createElement('span');
        title.textContent = this._data.name;
        title.style.cursor = 'text';
        title.title = 'Click to rename';
        title.addEventListener('click', (e) => {
            e.stopPropagation();
            this._renameInline(title);
        });
        h.append(title);

        const actions = document.createElement('span');
        actions.className = 'db-table-header-actions';
        const more = document.createElement('button');
        more.replaceChildren(iconEllipsis());
        more.className = 'db-table-header-action';
        more.title = 'More actions';
        more.addEventListener('click', (e) => {
            e.stopPropagation();
            const items: Parameters<typeof openContextMenu>[1] = [
                {label: 'Rename table', onClick: (): void => this._renameInline(title)},
                {label: 'Table options…', onClick: (): void => dispatch(EditorEvents.editTableOptions, {tableUnid: this._data.unid})},
                {label: 'Assign to EER diagram…', onClick: (): void => dispatch(EditorEvents.pickLayerForTables, {tableUnids: [this._data.unid]})}
            ];
            /*
             * Symmetric "remove from this diagram" only when the canvas
             * is currently scoped to a single diagram. Without that
             * scope, "this diagram" is ambiguous so the option would be
             * confusing. The handler clears primary `layerUnid` if it
             * matches and drops any matching `layerPlacements` entry —
             * the table stays in the model, just no longer belongs to
             * this EER diagram.
             */
            if (this._activeLayer) {
                const layer = this._activeLayer;
                items.push({label: `Remove from "${layer.name}"`, onClick: (): void => dispatch(EditorEvents.removeTableFromLayer, {
                    tableUnid: this._data.unid,
                    layerUnid: layer.unid
                })});
            }
            items.push(
                {label: 'Duplicate', onClick: (): void => dispatch(EditorEvents.duplicateTable, {tableUnid: this._data.unid})},
                {kind: 'separator'},
                {label: 'Delete table', danger: true, onClick: (): void => { this._confirmDeleteTable(); }}
            );
            openContextMenu(more, items);
        });
        actions.append(more);
        h.append(actions);
        return h;
    }

    private async _confirmDeleteTable(): Promise<void> {
        const ok = await ConfirmDialog.showConfirm('Delete table',
            `Delete table "${this._data.name}" and all its columns?`, 'danger');
        if (ok) {dispatch(EditorEvents.deleteTable, { tableUnid: this._data.unid });}
    }

    private _renderColumns(): HTMLDivElement {
        const list = document.createElement('div');
        list.className = 'db-table-columns';
        for (const col of this._data.columns) {
            list.append(this._renderColumn(col));
        }
        if (!this._data.columns.length) {
            const empty = document.createElement('div');
            empty.className = 'db-table-section';
            empty.textContent = 'no columns yet';
            list.append(empty);
        }
        return list;
    }

    private _columnDragState: {
        columnUnid: string;
        indicator: HTMLDivElement;
        listEl: HTMLElement;
        targetBefore: string | null;
    } | null = null;

    private _renderColumn(col: JsonColumn): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'db-table-column';
        row.dataset.columnUnid = col.unid;
        /*
         * Mirror the table id onto the row so jsPlumb's `extract` option
         * can read both unids off the drop-target element directly.
         */
        row.dataset.tableUnid = this._data.unid;

        const icon = document.createElement('span');
        icon.className = 'db-table-column-icon';
        if (col.primaryKey) { icon.classList.add('pk'); icon.textContent = 'PK'; }
        else if (col.unique) { icon.classList.add('uk'); icon.textContent = 'U'; }
        else {icon.textContent = '';}
        row.append(icon);

        const name = document.createElement('span');
        name.className = 'db-table-column-name';
        if (col.primaryKey) {name.classList.add('pk');}
        name.textContent = col.name;
        row.append(name);

        const type = document.createElement('span');
        type.className = 'db-table-column-type';
        type.textContent = this._displayType(col);
        row.append(type);

        const flags = document.createElement('span');
        flags.className = 'db-table-column-flags';
        const f: string[] = [];
        if (col.notNull) {f.push('NN');}
        if (col.autoIncrement) {f.push('AI');}
        if (col.unsigned) {f.push('UN');}
        flags.textContent = f.join(' ');
        row.append(flags);

        const more = document.createElement('button');
        more.className = 'db-table-column-more';
        more.replaceChildren(iconEllipsis());
        more.title = 'More actions';
        /*
         * Block mousedown so the card's drag manager doesn't grab the
         * gesture. The button still receives click.
         */
        more.addEventListener('mousedown', (e) => e.stopPropagation());
        more.addEventListener('click', (e) => {
            e.stopPropagation();
            openContextMenu(more, [
                {label: 'Rename column', onClick: (): void => this._startColumnInlineRename(name, col)},
                {label: 'Edit column…', onClick: (): void => { this._editColumn(col); }},
                {kind: 'separator'},
                {label: 'Remove column', danger: true, onClick: (): void => { this._removeColumn(col); }}
            ]);
        });
        row.append(more);

        /*
         * Connection grip: jsPlumb's source-selector matches `.db-table-column-grip`.
         * jsPlumb listens for mousedown on the container via delegation
         * (`instance.on(container, 'mousedown', SELECTOR_MANAGED_ELEMENT, …)`)
         * and decides between card-drag vs. connection-drag based on whether
         * the target matches a registered source-selector. So we must NOT
         * stop propagation here — that would prevent jsPlumb from seeing
         * the event at all.
         */
        const grip = document.createElement('span');
        grip.className = 'db-table-column-grip';
        grip.title = 'Drag to another column to create a foreign key';
        /*
         * jsPlumb's source-selector uses `extract` to pull the unids off
         * the actual mousedown target — that's the grip itself, so the
         * data attributes have to live here, not on the parent row.
         */
        grip.dataset.columnUnid = col.unid;
        grip.dataset.tableUnid = this._data.unid;
        row.append(grip);

        row.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this._editColumn(col);
        });

        /*
         * Drag-to-reorder. Skip mousedowns on grip (FK drag) and the
         * more-button (their own handlers run); otherwise wait for a few
         * pixels of movement before entering drag mode so single clicks
         * and dblclick still work normally.
         */
        row.addEventListener('mousedown', (e) => {
            const t = e.target as HTMLElement;
            if (t.closest('.db-table-column-grip, .db-table-column-more, button')) {return;}
            this._maybeStartColumnDrag(e, col, row);
        });

        return row;
    }

    private _maybeStartColumnDrag(e: MouseEvent, col: JsonColumn, row: HTMLDivElement): void {
        const startY = e.clientY;
        const threshold = 4;
        let started = false;
        const onMove = (ev: MouseEvent): void => {
            if (!started && Math.abs(ev.clientY - startY) < threshold) {return;}
            if (!started) {
                started = true;
                this._beginColumnDrag(col, row);
            }
            this._updateColumnDragTarget(ev.clientY);
        };
        const onUp = (): void => {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            if (started) {this._endColumnDrag();}
        };
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
    }

    private _beginColumnDrag(col: JsonColumn, row: HTMLDivElement): void {
        const listEl = row.parentElement as HTMLElement | null;
        if (!listEl) {return;}
        document.body.style.cursor = 'grabbing';
        row.classList.add('db-table-column--dragging');
        const indicator = document.createElement('div');
        indicator.className = 'db-table-column-drop-indicator';
        listEl.append(indicator);
        this._columnDragState = {columnUnid: col.unid, indicator: indicator, listEl: listEl, targetBefore: null};
    }

    private _updateColumnDragTarget(clientY: number): void {
        const s = this._columnDragState;
        if (!s) {return;}
        // ignore the dragged row
        const rows = Array.from(s.listEl.querySelectorAll<HTMLElement>('.db-table-column'))
        .filter(r => r.dataset.columnUnid !== s.columnUnid);
        let beforeUnid: string | null = null;
        for (const r of rows) {
            const rect = r.getBoundingClientRect();
            if (clientY < rect.top + (rect.height / 2)) {
                beforeUnid = r.dataset.columnUnid ?? null;
                break;
            }
        }
        s.targetBefore = beforeUnid;
        const listRect = s.listEl.getBoundingClientRect();
        if (beforeUnid === null) {
            const last = rows[rows.length - 1];
            if (last) {
                s.indicator.style.top = `${last.getBoundingClientRect().bottom - listRect.top}px`;
            } else {
                s.indicator.style.top = '0px';
            }
        } else {
            const beforeRow = rows.find(r => r.dataset.columnUnid === beforeUnid);
            if (beforeRow) {
                s.indicator.style.top = `${beforeRow.getBoundingClientRect().top - listRect.top}px`;
            }
        }
    }

    private _endColumnDrag(): void {
        const s = this._columnDragState;
        this._columnDragState = null;
        if (!s) {return;}
        document.body.style.cursor = '';
        s.indicator.remove();
        const dragRow = s.listEl.querySelector(`.db-table-column[data-column-unid="${s.columnUnid}"]`) as HTMLElement | null;
        dragRow?.classList.remove('db-table-column--dragging');

        /*
         * No-op detection: if the column would land in the same slot it
         * already occupies, skip the API call.
         */
        const cols = this._data.columns;
        const currentIdx = cols.findIndex(c => c.unid === s.columnUnid);
        const targetIdx = s.targetBefore === null
            ? cols.length
            : cols.findIndex(c => c.unid === s.targetBefore);
        if (currentIdx === targetIdx || currentIdx + 1 === targetIdx) {return;}

        dispatch(EditorEvents.reorderColumn, {
            tableUnid: this._data.unid,
            columnUnid: s.columnUnid,
            beforeColumnUnid: s.targetBefore
        });
    }

    private _renderAddRow(): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'db-table-add-row';
        row.textContent = '+ add column';
        row.addEventListener('click', (e) => {
            e.stopPropagation();
            this._addColumn();
        });
        return row;
    }

    private _renderIndexesSection(): HTMLDivElement | null {
        const wrap = document.createElement('div');
        const head = document.createElement('div');
        head.className = 'db-table-section db-table-section--with-add';
        const headLabel = document.createElement('span');
        headLabel.textContent = 'indexes';
        head.append(headLabel);
        const addBtn = document.createElement('button');
        addBtn.className = 'db-table-section-add';
        addBtn.textContent = '+';
        addBtn.title = 'Add index';
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._addIndex();
        });
        head.append(addBtn);
        wrap.append(head);
        for (const ix of this._data.indexes) {
            wrap.append(this._renderIndexRow(ix));
        }
        /*
         * If no indexes yet, return the section anyway so the user has
         * an add affordance — but only when there are columns to index.
         */
        if (!this._data.indexes.length && !this._data.columns.length) {return null;}
        return wrap;
    }

    private _renderIndexRow(ix: JsonIndex): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'db-table-index';
        const labelText = document.createElement('span');
        labelText.className = 'db-table-index-name';
        const marker = ix.type === 'unique' ? iconDiamondFilled() : iconDiamondHollow();
        const nameSpan = document.createElement('span');
        nameSpan.textContent = ` ${ix.name}`;
        labelText.append(marker, nameSpan);
        const cols = ix.columns.map(c => {
            const col = this._data.columns.find(c2 => c2.unid === c.columnUnid);
            return col?.name ?? '?';
        }).join(', ');
        labelText.title = cols ? `(${cols})` : '';
        row.append(labelText);

        const more = document.createElement('button');
        more.className = 'db-table-index-more';
        more.replaceChildren(iconEllipsis());
        more.title = 'More actions';
        more.addEventListener('mousedown', (e) => e.stopPropagation());
        more.addEventListener('click', (e) => {
            e.stopPropagation();
            openContextMenu(more, [
                {label: 'Edit index', onClick: (): void => { this._editIndex(ix); }},
                {kind: 'separator'},
                {label: 'Remove index', danger: true, onClick: (): void => { this._removeIndex(ix); }}
            ]);
        });
        row.append(more);
        row.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this._editIndex(ix);
        });
        return row;
    }

    /**
     * Inline-rename a column: replace its name span with an input,
     * commit on Enter/blur, revert on Escape. Mirrors the treeview /
     * table-header pattern. Dispatches `updateColumn` with just a name
     * patch so other column fields aren't touched.
     */
    private _startColumnInlineRename(nameEl: HTMLSpanElement, col: JsonColumn): void {
        const input = document.createElement('input');
        input.className = 'db-table-column-name-input';
        input.value = col.name;
        // Inherit name styling so the input visually replaces the span.
        input.classList.toggle('pk', Boolean(col.primaryKey));
        nameEl.replaceWith(input);
        input.focus();
        input.select();

        let committed = false;
        const commit = (): void => {
            if (committed) {return;}
            committed = true;
            const next = input.value.trim();
            input.replaceWith(nameEl);
            if (next && next !== col.name) {
                dispatch(EditorEvents.updateColumn, {
                    tableUnid: this._data.unid,
                    columnUnid: col.unid,
                    patch: { name: next }
                });
            }
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            else if (e.key === 'Escape') {
                e.preventDefault();
                committed = true;
                input.replaceWith(nameEl);
            }
            e.stopPropagation();
        });
        /*
         * Block mousedown propagation so the column-row drag-reorder
         * handler doesn't kick in when the user clicks inside the input.
         */
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('dblclick', (e) => e.stopPropagation());
    }

    private async _addIndex(): Promise<void> {
        if (!this._data.columns.length) {return;}
        const result = await new DbIndexDialog(null, this._data.columns).show();
        if (!result) {return;}
        dispatch(EditorEvents.addIndex, { tableUnid: this._data.unid, index: result });
    }

    private async _editIndex(ix: JsonIndex): Promise<void> {
        const result = await new DbIndexDialog(ix, this._data.columns).show();
        if (!result) {return;}
        dispatch(EditorEvents.updateIndex, { tableUnid: this._data.unid, indexUnid: ix.unid, patch: result });
    }

    private async _removeIndex(ix: JsonIndex): Promise<void> {
        const ok = await ConfirmDialog.showConfirm('Remove index',
            `Remove index "${ix.name}"?`, 'danger');
        if (ok) {dispatch(EditorEvents.removeIndex, { tableUnid: this._data.unid, indexUnid: ix.unid });}
    }

    private _renderForeignKeysSection(): HTMLDivElement | null {
        if (!this._data.foreignKeys.length) {return null;}
        const wrap = document.createElement('div');
        const head = document.createElement('div');
        head.className = 'db-table-section';
        head.textContent = 'foreign keys';
        wrap.append(head);
        for (const fk of this._data.foreignKeys) {
            const row = document.createElement('div');
            row.className = 'db-table-index';
            row.textContent = `↗ ${fk.name}`;
            wrap.append(row);
        }
        return wrap;
    }

    private _displayType(col: JsonColumn): string {
        if (col.type === 'enum' && col.enumRef) {
            const e = this._enums.find(x => x.unid === col.enumRef);
            return e ? `enum<${e.name}>` : 'enum';
        }
        return col.length ? `${col.type}(${col.length})` : col.type;
    }

    // ------- inline interactions -------

    private _renameInline(title: HTMLSpanElement): void {
        const input = document.createElement('input');
        input.value = this._data.name;
        input.style.font = 'inherit';
        input.style.color = 'inherit';
        input.style.background = 'rgba(255,255,255,0.18)';
        input.style.border = 'none';
        input.style.padding = '2px 4px';
        input.style.borderRadius = '3px';
        title.replaceWith(input);
        input.focus();
        input.select();

        const commit = (): void => {
            const next = input.value.trim();
            if (next && next !== this._data.name) {
                dispatch(EditorEvents.renameTable, {tableUnid: this._data.unid, name: next});
            } else {
                this._render();
            }
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {input.blur();}
            if (e.key === 'Escape') { input.value = this._data.name; input.blur(); }
        });
    }

    private async _addColumn(): Promise<void> {
        const result = await new DbColumnDialog(null, this._enums).show();
        if (!result) {return;}
        dispatch(EditorEvents.addColumn, { tableUnid: this._data.unid, column: result });
    }

    private async _editColumn(col: JsonColumn): Promise<void> {
        const result = await new DbColumnDialog(col, this._enums).show();
        if (!result) {return;}
        dispatch(EditorEvents.updateColumn, { tableUnid: this._data.unid, columnUnid: col.unid, patch: result });
    }

    private async _removeColumn(col: JsonColumn): Promise<void> {
        const ok = await ConfirmDialog.showConfirm('Remove column',
            `Remove column "${col.name}" from "${this._data.name}"?`, 'danger');
        if (ok) {
            dispatch(EditorEvents.removeColumn, {tableUnid: this._data.unid, columnUnid: col.unid});
        }
    }

}