import {BaseDialog} from '../Base/BaseDialog.js';
import {JsonColumn, JsonEnum} from '../../../editor_schemas/JsonData.js';

const COMMON_TYPES = [
    'int', 'bigint', 'smallint', 'tinyint',
    'varchar', 'char', 'text', 'mediumtext', 'longtext',
    'decimal', 'float', 'double',
    'bool',
    'date', 'time', 'datetime', 'timestamp',
    'json', 'uuid', 'enum',
    'blob', 'binary', 'varbinary'
];

export type ColumnDialogResult = Omit<JsonColumn, 'unid'> | null;

/**
 * Add/edit one column. Returns the column body on save (without unid)
 * or null on cancel.
 */
export class DbColumnDialog extends BaseDialog<ColumnDialogResult> {

    private _name: HTMLInputElement;
    private _type: HTMLSelectElement;
    private _length: HTMLInputElement;
    private _enumRef: HTMLSelectElement;
    private _notNull: HTMLInputElement;
    private _primaryKey: HTMLInputElement;
    private _autoIncrement: HTMLInputElement;
    private _unique: HTMLInputElement;
    private _unsigned: HTMLInputElement;
    private _default: HTMLInputElement;
    private _comment: HTMLInputElement;

    public constructor(initial: Partial<JsonColumn> | null, enums: JsonEnum[]) {
        super(initial && initial.name ? `Edit column · ${initial.name}` : 'Add column');

        this._name = this.addInput('Name', initial?.name ?? '');
        this._type = this.addSelect('Type', COMMON_TYPES.map(t => ({ value: t, label: t })), initial?.type ?? 'int');
        this._length = this.addInput('Length / precision (e.g. 255 or 10,2)', initial?.length ?? '');
        this._enumRef = this.addSelect(
            'Enum (only if type=enum)',
            [{ value: '', label: '— none —' }, ...enums.map(e => ({ value: e.unid, label: e.name }))],
            initial?.enumRef ?? ''
        );
        this._default = this.addInput('Default expression (raw SQL)', initial?.defaultValue ?? '');
        this._comment = this.addInput('Comment', initial?.comment ?? '');
        this._notNull = this.addCheckbox('NOT NULL', initial?.notNull ?? false);
        this._primaryKey = this.addCheckbox('Primary key', initial?.primaryKey ?? false);
        this._autoIncrement = this.addCheckbox('Auto increment', initial?.autoIncrement ?? false);
        this._unique = this.addCheckbox('Unique', initial?.unique ?? false);
        this._unsigned = this.addCheckbox('Unsigned (numeric)', initial?.unsigned ?? false);

        this.addButton('Cancel', 'grey', () => this.close(null));
        this.addButton('Save', 'primary', () => this._submit());
    }

    private _submit(): void {
        const name = this._name.value.trim();
        if (!name) { this._name.focus(); return; }
        const out: Omit<JsonColumn, 'unid'> = {
            name: name,
            type: this._type.value,
            length: this._length.value.trim() || undefined,
            enumRef: this._enumRef.value || undefined,
            notNull: this._notNull.checked || undefined,
            primaryKey: this._primaryKey.checked || undefined,
            autoIncrement: this._autoIncrement.checked || undefined,
            unique: this._unique.checked || undefined,
            unsigned: this._unsigned.checked || undefined,
            defaultValue: this._default.value.trim() || undefined,
            comment: this._comment.value.trim() || undefined
        };
        // strip undefineds for cleaner JSON
        for (const k of Object.keys(out) as (keyof typeof out)[]) {
            if (out[k] === undefined) {delete (out as any)[k];}
        }
        this.close(out);
    }

}