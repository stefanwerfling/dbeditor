import {BaseDialog} from '../Base/BaseDialog.js';
import {JsonEnum} from '../JsonData.js';

export type EnumDialogResult = {
    name: string;
    values: {unid: string | null; value: string;}[];
} | null;

/**
 * Edit one enum: rename + add/remove/edit values inline. Returns the
 * desired new state on save (with `unid: null` for newly-added values
 * so the controller can tell apart inserts from updates) or null on
 * cancel. Reorder isn't exposed yet — values render in array order and
 * stay there.
 */
export class DbEnumDialog extends BaseDialog<EnumDialogResult> {

    private _name: HTMLInputElement;
    private _list: HTMLDivElement;
    private _rows: {unid: string | null; input: HTMLInputElement; row: HTMLDivElement;}[] = [];

    public constructor(initial: JsonEnum) {
        super(`Edit enum · ${initial.name}`);
        this._name = this.addInput('Name', initial.name);

        const {row: listRow} = this.addRow('Values');
        this._list = document.createElement('div');
        this._list.className = 'enum-dialog-values';
        listRow.append(this._list);

        for (const v of initial.values) {
            this._appendValueRow(v.unid, v.value);
        }

        const addRow = document.createElement('button');
        addRow.type = 'button';
        addRow.textContent = '+ add value';
        addRow.className = 'enum-dialog-add-value';
        addRow.addEventListener('click', (): void => {
            const inputRow = this._appendValueRow(null, '');
            inputRow.input.focus();
        });
        listRow.append(addRow);

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton('Save', 'primary', (): void => this._submit());
    }

    private _appendValueRow(unid: string | null, value: string): {input: HTMLInputElement;} {
        const row = document.createElement('div');
        row.className = 'enum-dialog-value-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value;
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'enum-dialog-value-remove';
        del.textContent = '×';
        del.title = 'Remove value';
        del.addEventListener('click', (): void => {
            row.remove();
            this._rows = this._rows.filter((r) => r.row !== row);
        });
        row.append(input, del);
        this._list.append(row);
        const entry = {unid: unid, input: input, row: row};
        this._rows.push(entry);
        return entry;
    }

    private _submit(): void {
        const name = this._name.value.trim();
        if (!name) {
            this._name.focus();
            return;
        }
        const values = this._rows
        .map((r) => ({unid: r.unid, value: r.input.value.trim()}))
        .filter((v) => v.value.length > 0);
        this.close({name: name, values: values});
    }

}