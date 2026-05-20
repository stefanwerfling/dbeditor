import {BaseDialog} from '../Base/BaseDialog.js';
import {JsonTableOptions} from '../../../editor_schemas/JsonData.js';

export type BatchTableOptionsResult = Partial<JsonTableOptions> | null;

const ENGINES = [
    {value: '',         label: '— default —'},
    {value: 'InnoDB',   label: 'InnoDB'},
    {value: 'MyISAM',   label: 'MyISAM'},
    {value: 'MEMORY',   label: 'MEMORY'},
    {value: 'ARCHIVE',  label: 'ARCHIVE'}
];

const PERSISTENCE = [
    {value: '',          label: '— default (LOGGED) —'},
    {value: 'UNLOGGED',  label: 'UNLOGGED (postgres)'},
    {value: 'TEMPORARY', label: 'TEMPORARY (postgres)'}
];

type FieldKey = 'engine' | 'charset' | 'collation' | 'tablespace' | 'persistence' | 'comment';

/**
 * Edit table-level storage options for MULTIPLE tables at once.
 * Sparse-patch UX: each field has an "Apply" checkbox; only checked
 * fields land on the result, leaving other fields on each target
 * table untouched. This handles the divergence case (10 tables with
 * different engines) without forcing the user to pick a single value
 * for every column — they tick "engine = InnoDB" and the other 5
 * fields stay as-is per table.
 *
 * Companion to `DbTableOptionsDialog` (single-table, full-replace).
 */
export class DbBatchTableOptionsDialog extends BaseDialog<BatchTableOptionsResult> {

    private readonly _checks = new Map<FieldKey, HTMLInputElement>();
    private readonly _engine: HTMLSelectElement;
    private readonly _charset: HTMLInputElement;
    private readonly _collation: HTMLInputElement;
    private readonly _tablespace: HTMLInputElement;
    private readonly _persistence: HTMLSelectElement;
    private readonly _comment: HTMLInputElement;

    public constructor(tableCount: number) {
        super(`Batch options · ${tableCount} tables`);
        this._dialog.classList.add('batch-table-options-dialog');

        const intro = document.createElement('p');
        intro.className = 'dialog-intro';
        intro.textContent = `Tick the fields you want to apply to all ${tableCount} selected tables. Unticked fields keep each table's current value. Empty value = clear the field.`;
        this._body.append(intro);

        this._engine = this._addCheckedSelect('engine', 'Engine (MySQL/MariaDB)', ENGINES);
        this._charset = this._addCheckedInput('charset', 'Charset (e.g. utf8mb4)');
        this._collation = this._addCheckedInput('collation', 'Collation (e.g. utf8mb4_unicode_ci)');
        this._tablespace = this._addCheckedInput('tablespace', 'Tablespace (postgres)');
        this._persistence = this._addCheckedSelect('persistence', 'Persistence (postgres)', PERSISTENCE);
        this._comment = this._addCheckedInput('comment', 'Comment');

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton('Apply', 'primary', (): void => this._submit());
    }

    private _addCheckedInput(key: FieldKey, label: string): HTMLInputElement {
        const {row} = this.addRow(label);
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'batch-table-options-check';
        check.title = `Apply ${key} to selected tables`;
        const input = document.createElement('input');
        input.type = 'text';
        /* Toggle the check when the user starts editing — feels right. */
        input.addEventListener('input', () => {check.checked = true;});
        row.append(check, input);
        this._checks.set(key, check);
        return input;
    }

    private _addCheckedSelect(key: FieldKey, label: string, options: {value: string; label: string;}[]): HTMLSelectElement {
        const {row} = this.addRow(label);
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'batch-table-options-check';
        check.title = `Apply ${key} to selected tables`;
        const select = document.createElement('select');
        for (const o of options) {
            const opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label;
            select.append(opt);
        }
        select.addEventListener('change', () => {check.checked = true;});
        row.append(check, select);
        this._checks.set(key, check);
        return select;
    }

    private _submit(): void {
        const out: Partial<JsonTableOptions> = {};
        const take = (key: FieldKey, value: string): void => {
            if (!this._checks.get(key)?.checked) {return;}
            const trimmed = value.trim();
            /*
             * Empty after trim = explicitly clear the field on each
             * target table. We model that as `undefined` here; the
             * iterating caller maps it to a real delete on each
             * table's options object.
             */
            (out as Record<string, string | undefined>)[key] = trimmed || undefined;
        };
        take('engine', this._engine.value);
        take('charset', this._charset.value);
        take('collation', this._collation.value);
        take('tablespace', this._tablespace.value);
        take('persistence', this._persistence.value);
        take('comment', this._comment.value);
        if (Object.keys(out).length === 0) {
            this.close(null);
            return;
        }
        this.close(out);
    }

}