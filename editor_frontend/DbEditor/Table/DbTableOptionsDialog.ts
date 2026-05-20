import {BaseDialog} from '../Base/BaseDialog.js';
import {JsonTableOptions} from '../JsonData.js';

export type TableOptionsDialogResult = JsonTableOptions | null;

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

/**
 * Edit table-level storage options. Fields apply per dialect — engine
 * is MySQL/MariaDB, persistence/tablespace are Postgres, charset/collation
 * are mostly MySQL but Postgres uses encoding at the database level.
 * The editor keeps everything visible since the JSON model carries it
 * regardless of dialect; the generator emits only what's relevant.
 */
export class DbTableOptionsDialog extends BaseDialog<TableOptionsDialogResult> {

    private _engine: HTMLSelectElement;
    private _charset: HTMLInputElement;
    private _collation: HTMLInputElement;
    private _tablespace: HTMLInputElement;
    private _persistence: HTMLSelectElement;
    private _comment: HTMLInputElement;

    public constructor(tableName: string, initial: JsonTableOptions | undefined) {
        super(`Table options · ${tableName}`);

        this._engine = this.addSelect('Engine (MySQL/MariaDB)', ENGINES, initial?.engine ?? '');
        this._charset = this.addInput('Charset (e.g. utf8mb4)', initial?.charset ?? '');
        this._collation = this.addInput('Collation (e.g. utf8mb4_unicode_ci)', initial?.collation ?? '');
        this._tablespace = this.addInput('Tablespace (postgres)', initial?.tablespace ?? '');
        this._persistence = this.addSelect('Persistence (postgres)', PERSISTENCE, initial?.persistence ?? '');
        this._comment = this.addInput('Comment', initial?.comment ?? '');

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton('Save', 'primary', (): void => this._submit());
    }

    private _submit(): void {
        const out: JsonTableOptions = {
            engine:      this._engine.value || undefined,
            charset:     this._charset.value.trim() || undefined,
            collation:   this._collation.value.trim() || undefined,
            tablespace:  this._tablespace.value.trim() || undefined,
            persistence: this._persistence.value || undefined,
            comment:     this._comment.value.trim() || undefined
        };
        for (const k of Object.keys(out) as (keyof JsonTableOptions)[]) {
            if (out[k] === undefined) {
                delete (out as Record<string, unknown>)[k];
            }
        }
        this.close(out);
    }

}