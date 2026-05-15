import {SchemaWarning} from './SchemaValidator.js';
import {dispatch, EditorEvents} from '../Base/EditorEvents.js';
import {iconCheck} from '../Util/Icons.js';

const SEV_ICON: Record<string, string> = {
    error:   '✕',
    warning: '!',
    info:    'i'
};

/**
 * Sticky panel beneath the treeview that lists schema warnings.
 * Collapsible header (click toggles). Each warning is clickable and
 * activates the relevant database/folder so the table is on the
 * canvas — saves the user from hunting it down.
 */
export class WarningsPanel {

    private _el: HTMLElement;
    private _list: HTMLDivElement;
    private _header: HTMLDivElement;
    private _collapsed = false;

    public constructor(el: HTMLElement) {
        this._el = el;
        this._el.className = 'warnings-panel';

        this._header = document.createElement('div');
        this._header.className = 'warnings-panel-header';
        this._header.addEventListener('click', (): void => {
            this._collapsed = !this._collapsed;
            this._el.classList.toggle('collapsed', this._collapsed);
        });

        this._list = document.createElement('div');
        this._list.className = 'warnings-panel-list';

        this._el.append(this._header, this._list);
        this.render([]);
    }

    public render(warnings: SchemaWarning[]): void {
        const errors = warnings.filter((w) => w.severity === 'error').length;
        const warns = warnings.filter((w) => w.severity === 'warning').length;
        const infos = warnings.filter((w) => w.severity === 'info').length;
        const total = warnings.length;

        this._header.replaceChildren();
        const title = document.createElement('span');
        title.className = 'warnings-panel-title';
        title.textContent = total === 0 ? 'No issues' : 'Issues';
        const counts = document.createElement('span');
        counts.className = 'warnings-panel-counts';
        if (errors) {
            counts.append(this._badge('error', errors));
        }
        if (warns) {
            counts.append(this._badge('warning', warns));
        }
        if (infos) {
            counts.append(this._badge('info', infos));
        }
        if (!total) {
            counts.replaceChildren(iconCheck());
        }
        this._header.append(title, counts);

        this._list.replaceChildren();
        if (!total) {
            const empty = document.createElement('div');
            empty.className = 'warnings-panel-empty';
            empty.textContent = 'Schema looks good.';
            this._list.append(empty);
            return;
        }

        const order: Record<string, number> = {error: 0, warning: 1, info: 2};
        const sorted = [...warnings].sort((a, b) =>
            order[a.severity] - order[b.severity] ||
            (a.tableName ?? '').localeCompare(b.tableName ?? ''));

        for (const w of sorted) {
            const row = document.createElement('div');
            row.className = `warnings-panel-row warnings-panel-row--${w.severity}`;
            const icon = document.createElement('span');
            icon.className = 'warnings-panel-row-icon';
            icon.textContent = SEV_ICON[w.severity] ?? '?';
            const msg = document.createElement('span');
            msg.className = 'warnings-panel-row-msg';
            msg.textContent = w.message;
            row.append(icon, msg);
            /*
             * Prefer focusing the specific table when we have its unid —
             * that way the user lands on the offending card, not just
             * its database. Container-only warnings (rare) still
             * activate the database as before.
             */
            if (w.tableUnid) {
                row.title = 'Click to focus the table';
                row.addEventListener('click', (): void => {
                    dispatch(EditorEvents.focusTable, {
                        tableUnid: w.tableUnid,
                        containerUnid: w.containerUnid
                    });
                });
            } else if (w.containerUnid) {
                row.title = 'Click to open the database';
                row.addEventListener('click', (): void => {
                    dispatch(EditorEvents.activateContainer, {unid: w.containerUnid});
                });
            }
            this._list.append(row);
        }
    }

    private _badge(severity: string, count: number): HTMLSpanElement {
        const el = document.createElement('span');
        el.className = `warnings-panel-badge warnings-panel-badge--${severity}`;
        el.textContent = String(count);
        return el;
    }

}