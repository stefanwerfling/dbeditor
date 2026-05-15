import {BaseDialog} from '../Base/BaseDialog.js';
import {iconWarning} from '../Util/Icons.js';

export type BulkRenameResult = Map<string, string> | null;

/**
 * Apply a pattern to rename N tables at once. Pattern supports two
 * placeholders:
 *   `{name}`  — the original table name (no transform).
 *   `{name:lower}` / `{name:upper}` / `{name:snake}` — common case
 *      conversions for users importing inconsistent naming.
 *
 * Live preview shows before → after for every target so the user can
 * verify before applying. Collisions (two targets mapping to the same
 * new name) are surfaced as a warning beneath the preview; apply
 * proceeds anyway — the API may reject duplicates per-DB but that's
 * the caller's call.
 *
 * Returns a `Map<tableUnid, newName>` on apply, `null` on cancel.
 */
export class DbBulkRenameDialog extends BaseDialog<BulkRenameResult> {

    private readonly _input: HTMLInputElement;
    private readonly _preview: HTMLDivElement;
    private readonly _warn: HTMLDivElement;
    private readonly _items: {unid: string; name: string;}[];

    public constructor(items: {unid: string; name: string;}[]) {
        super(`Bulk rename · ${items.length} tables`);
        this._dialog.classList.add('bulk-rename-dialog');
        this._items = items;

        const intro = document.createElement('p');
        intro.className = 'dialog-intro';
        intro.textContent = 'Pattern uses {name} as the original name. Suffixes available: {name:lower}, {name:upper}, {name:snake}.';
        this._body.append(intro);

        this._input = this.addInput('Pattern', '{name}');
        this._input.placeholder = 'e.g. tbl_{name} or {name}_v2 or {name:snake}';
        this._input.addEventListener('input', () => this._renderPreview());

        this._preview = document.createElement('div');
        this._preview.className = 'bulk-rename-preview';
        this._body.append(this._preview);

        this._warn = document.createElement('div');
        this._warn.className = 'bulk-rename-warn';
        this._body.append(this._warn);

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton('Apply', 'primary', (): void => this._submit());

        this._renderPreview();
    }

    private _renderPreview(): void {
        const pattern = this._input.value;
        this._preview.innerHTML = '';
        const targetCounts = new Map<string, number>();
        for (const it of this._items) {
            const next = this._apply(pattern, it.name);
            targetCounts.set(next, (targetCounts.get(next) ?? 0) + 1);
            const row = document.createElement('div');
            row.className = 'bulk-rename-row';
            const oldEl = document.createElement('span');
            oldEl.className = 'bulk-rename-old';
            oldEl.textContent = it.name;
            const arrow = document.createElement('span');
            arrow.className = 'bulk-rename-arrow';
            arrow.textContent = '→';
            const newEl = document.createElement('span');
            newEl.className = 'bulk-rename-new';
            newEl.textContent = next;
            if (next === it.name) {newEl.classList.add('bulk-rename-new--unchanged');}
            row.append(oldEl, arrow, newEl);
            this._preview.append(row);
        }
        /*
         * Highlight collision targets — two source tables renamed to the
         * same destination is almost always a mistake (per-DB names must
         * be unique).
         */
        const collisions = [...targetCounts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
        if (collisions.length) {
            const text = ` ${collisions.length} target name${collisions.length === 1 ? '' : 's'} collide: ${collisions.join(', ')}`;
            this._warn.replaceChildren(iconWarning(), document.createTextNode(text));
        } else {
            this._warn.replaceChildren();
        }
    }

    private _apply(pattern: string, name: string): string {
        return pattern
        .replace(/\{name:lower\}/gu, name.toLowerCase())
        .replace(/\{name:upper\}/gu, name.toUpperCase())
        .replace(/\{name:snake\}/gu, name.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase())
        .replace(/\{name\}/gu, name);
    }

    private _submit(): void {
        const pattern = this._input.value;
        const out = new Map<string, string>();
        for (const it of this._items) {
            const next = this._apply(pattern, it.name).trim();
            if (next && next !== it.name) {out.set(it.unid, next);}
        }
        if (out.size === 0) {this.close(null); return;}
        this.close(out);
    }

}