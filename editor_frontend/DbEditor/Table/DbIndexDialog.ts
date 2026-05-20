import {BaseDialog} from '../Base/BaseDialog.js';
import {JsonColumn, JsonIndex, JsonIndexColumn, JsonIndexType} from '../../../editor_schemas/JsonData.js';

const TYPES: {value: string; label: string;}[] = [
    {value: JsonIndexType.index,    label: 'INDEX'},
    {value: JsonIndexType.unique,   label: 'UNIQUE'},
    {value: JsonIndexType.fulltext, label: 'FULLTEXT'},
    {value: JsonIndexType.spatial,  label: 'SPATIAL'}
];

export type IndexDialogResult = Omit<JsonIndex, 'unid'> | null;

/**
 * Add/edit one index. Columns are picked from the table's existing
 * column list with optional ASC/DESC and prefix length. Returns the
 * index body on save (without unid) or null on cancel.
 */
export class DbIndexDialog extends BaseDialog<IndexDialogResult> {

    private _name: HTMLInputElement;
    private _type: HTMLSelectElement;
    private _where: HTMLInputElement;
    private _comment: HTMLInputElement;
    private _columnRows: {
        col: JsonColumn;
        checkbox: HTMLInputElement;
        order: HTMLSelectElement;
        length: HTMLInputElement;
    }[] = [];

    public constructor(initial: Partial<JsonIndex> | null, allColumns: JsonColumn[]) {
        super(initial && initial.name ? `Edit index · ${initial.name}` : 'Add index');

        this._name = this.addInput('Name', initial?.name ?? '');
        this._type = this.addSelect('Type', TYPES, initial?.type ?? JsonIndexType.index);

        const initialCols = new Map<string, JsonIndexColumn>();
        for (const c of initial?.columns ?? []) {
            initialCols.set(c.columnUnid, c);
        }

        const {row: colsRow} = this.addRow('Columns');
        const list = document.createElement('div');
        list.className = 'index-dialog-columns';
        for (const c of allColumns) {
            const existing = initialCols.get(c.unid);
            const colRow = document.createElement('div');
            colRow.className = 'index-dialog-column-row';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = Boolean(existing);

            const labelText = document.createElement('label');
            labelText.className = 'index-dialog-column-name';
            labelText.textContent = c.name;
            labelText.addEventListener('click', (): void => {
                checkbox.checked = !checkbox.checked;
            });

            const order = document.createElement('select');
            for (const o of ['ASC', 'DESC']) {
                const opt = document.createElement('option');
                opt.value = o;
                opt.textContent = o;
                order.append(opt);
            }
            order.value = (existing?.order ?? 'ASC').toUpperCase();

            const length = document.createElement('input');
            length.type = 'text';
            length.placeholder = 'len';
            length.title = 'Optional prefix length (MySQL)';
            length.value = existing?.length ? String(existing.length) : '';

            colRow.append(checkbox, labelText, order, length);
            list.append(colRow);
            this._columnRows.push({col: c, checkbox: checkbox, order: order, length: length});
        }
        colsRow.append(list);

        this._where = this.addInput('WHERE (partial index, postgres/sqlite)', initial?.where ?? '');
        this._comment = this.addInput('Comment', initial?.comment ?? '');

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton('Save', 'primary', (): void => this._submit());
    }

    private _submit(): void {
        const name = this._name.value.trim();
        if (!name) {
            this._name.focus();
            return;
        }
        const columns: JsonIndexColumn[] = [];
        for (const r of this._columnRows) {
            if (!r.checkbox.checked) {
                continue;
            }
            const lenRaw = r.length.value.trim();
            const len = lenRaw ? Number(lenRaw) : NaN;
            const colEntry: JsonIndexColumn = {columnUnid: r.col.unid, order: r.order.value};
            if (Number.isFinite(len)) {
                colEntry.length = len;
            }
            columns.push(colEntry);
        }
        if (!columns.length) {
            return;
        }
        const out: Omit<JsonIndex, 'unid'> = {
            name: name,
            type: this._type.value,
            columns: columns,
            where: this._where.value.trim() || undefined,
            comment: this._comment.value.trim() || undefined
        };
        for (const k of Object.keys(out) as (keyof typeof out)[]) {
            if (out[k] === undefined) {
                delete (out as Record<string, unknown>)[k];
            }
        }
        this.close(out);
    }

}