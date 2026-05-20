import {BrowserJsPlumbInstance} from '@jsplumb/browser-ui';
import {JsonView} from '../../../editor_schemas/JsonData.js';
import {EditorEventBus, EditorEvents} from '../Base/EditorEvents.js';
import {ContextMenu} from '../Base/ContextMenu.js';
import {ConfirmDialog} from '../Base/ConfirmDialog.js';
import {Icons} from '../Util/Icons.js';
import {ActiveDiagramContext} from '../Diagram/ActiveDiagramContext.js';

/**
 * Draggable view card on the canvas. Mirrors `DbTable` but much simpler:
 * a view has a name, an optional `materialized` flag, and a SELECT body
 * we render read-only in a monospace pane. Users edit via the `⋯` menu
 * (opens `DbViewDialog`) — the card itself never receives in-place column
 * editing because views have no columns to edit.
 *
 * The controller owns the data; this class re-renders from data when
 * `setData()` is called. jsPlumb manages the element so it participates
 * in the same drag/zoom system as tables.
 */
export class DbView {

    private _el: HTMLDivElement;
    private _data: JsonView;
    private readonly _jsp: BrowserJsPlumbInstance;
    private readonly _activeLayer: ActiveDiagramContext | null;

    public constructor(
        view: JsonView,
        jsp: BrowserJsPlumbInstance,
        activeLayer: ActiveDiagramContext | null = null
    ) {
        this._data = view;
        this._jsp = jsp;
        this._activeLayer = activeLayer;
        this._el = document.createElement('div');
        this._el.className = 'db-view';
        this._el.dataset.viewUnid = view.unid;
        this._el.style.left = `${view.pos.x}px`;
        this._el.style.top = `${view.pos.y}px`;
        this._render();
    }

    public get element(): HTMLDivElement { return this._el; }
    public get unid(): string { return this._data.unid; }

    public setData(view: JsonView): void {
        this._data = view;
        this._el.style.left = `${view.pos.x}px`;
        this._el.style.top = `${view.pos.y}px`;
        this._render();
        this._jsp.revalidate(this._el);
    }

    public attach(parent: HTMLElement): void {
        parent.append(this._el);
        this._jsp.manage(this._el);
        /*
         * Mirror `DbTable.attach`: only emit viewMoved when the position
         * actually changed since mousedown, so plain clicks don't trigger
         * a no-op persist.
         */
        let downX = 0; let downY = 0;
        this._el.addEventListener('mousedown', () => {
            downX = parseFloat(this._el.style.left || '0');
            downY = parseFloat(this._el.style.top || '0');
        });
        this._el.addEventListener('mouseup', () => {
            const left = parseFloat(this._el.style.left || '0');
            const top = parseFloat(this._el.style.top || '0');
            if (left === downX && top === downY) {return;}
            EditorEventBus.dispatch(EditorEvents.viewMoved, { viewUnid: this._data.unid, x: left, y: top });
        });
    }

    public destroy(): void {
        this._jsp.unmanage(this._el);
        this._el.remove();
    }

    /* --------------------------------------------------------------- */

    private _render(): void {
        this._el.classList.toggle('db-view--materialized', Boolean(this._data.materialized));
        this._el.replaceChildren(this._renderHeader(), this._renderBody());
    }

    private _renderHeader(): HTMLDivElement {
        const h = document.createElement('div');
        h.className = 'db-view-header';

        const kind = document.createElement('span');
        kind.className = 'db-view-kind';
        kind.textContent = this._data.materialized ? 'MATERIALIZED VIEW' : 'VIEW';

        const title = document.createElement('span');
        title.className = 'db-view-title';
        title.textContent = this._data.name;
        title.title = 'Click to edit body';
        title.addEventListener('click', (e) => {
            e.stopPropagation();
            EditorEventBus.dispatch(EditorEvents.editView, {unid: this._data.unid});
        });

        const actions = document.createElement('span');
        actions.className = 'db-view-header-actions';
        const more = document.createElement('button');
        more.replaceChildren(Icons.ellipsis());
        more.className = 'db-view-header-action';
        more.title = 'More actions';
        more.addEventListener('click', (e) => {
            e.stopPropagation();
            const items: Parameters<typeof ContextMenu.open>[1] = [
                {label: 'Edit body…',  onClick: (): void => EditorEventBus.dispatch(EditorEvents.editView, {unid: this._data.unid})},
                {label: 'Assign to EER diagram…', onClick: (): void => EditorEventBus.dispatch(EditorEvents.pickDiagramForView, {viewUnid: this._data.unid})}
            ];
            if (this._activeLayer) {
                const diagram = this._activeLayer;
                items.push({label: `Remove from "${diagram.name}"`, onClick: (): void => EditorEventBus.dispatch(EditorEvents.removeViewFromDiagram, {
                    viewUnid: this._data.unid,
                    diagramUnid: diagram.unid
                })});
            }
            items.push(
                {kind: 'separator'},
                {label: 'Delete view', danger: true, onClick: (): void => { this._confirmDelete(); }}
            );
            ContextMenu.open(more, items);
        });
        actions.append(more);

        h.append(kind, title, actions);
        return h;
    }

    private _renderBody(): HTMLDivElement {
        const body = document.createElement('div');
        body.className = 'db-view-body';
        const text = this._data.select.trim();
        if (!text) {
            body.classList.add('db-view-body--empty');
            body.textContent = '— empty SELECT — click ⋯ → Edit body to define it —';
            return body;
        }
        const pre = document.createElement('pre');
        pre.textContent = text;
        body.append(pre);
        return body;
    }

    private async _confirmDelete(): Promise<void> {
        const ok = await ConfirmDialog.showConfirm(
            'Delete view',
            `Delete view "${this._data.name}"?`,
            'danger'
        );
        if (!ok) {return;}
        EditorEventBus.dispatch(EditorEvents.deleteView, {unid: this._data.unid});
    }

}