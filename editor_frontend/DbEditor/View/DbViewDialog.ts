import {BaseDialog} from '../Base/BaseDialog.js';
import {JsonView} from '../../../editor_schemas/JsonData.js';

export type ViewDialogResult = {
    name: string;
    select: string;
    materialized: boolean;
    description: string;
} | null;

/**
 * Edit one view: name + raw SELECT body + materialized flag (postgres
 * only — other dialects ignore the flag in the generator). Returns the
 * desired new state on save or null on cancel. The textarea is
 * monospace and large because the SELECT body is the meat of the view.
 */
export class DbViewDialog extends BaseDialog<ViewDialogResult> {

    private _name: HTMLInputElement;
    private _select: HTMLTextAreaElement;
    private _materialized: HTMLInputElement;
    private _description: HTMLInputElement;

    public constructor(initial: JsonView) {
        super(`Edit view · ${initial.name}`);

        this._name = this.addInput('Name', initial.name);

        const {row: selectRow} = this.addRow('SELECT body');
        this._select = document.createElement('textarea');
        this._select.className = 'view-dialog-select';
        this._select.value = initial.select;
        this._select.spellcheck = false;
        this._select.rows = 12;
        selectRow.append(this._select);

        this._materialized = this.addCheckbox('Materialized (postgres only)', Boolean(initial.materialized));
        this._description = this.addInput('Description', initial.description ?? '');

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton('Save', 'primary', (): void => this._submit());
    }

    private _submit(): void {
        const name = this._name.value.trim();
        if (!name) {
            this._name.focus();
            return;
        }
        this.close({
            name: name,
            select: this._select.value,
            materialized: this._materialized.checked,
            description: this._description.value.trim()
        });
    }

}