import {BaseDialog} from '../Base/BaseDialog.js';

export type DatabaseDefaults = {
    defaultEngine?: string;
    defaultCharset?: string;
    defaultCollation?: string;
};

/**
 * Edit a database container's inheritance defaults — engine, charset,
 * and collation that every contained table inherits when its own
 * options don't override them. Mirrors MySQL's `CREATE DATABASE x
 * DEFAULT CHARSET ... COLLATE ...` semantic.
 *
 * Submit returns a diff-only patch (`{key: newValue}` for changed
 * fields, `{key: ''}` to clear); `null` on Cancel. Empty/whitespace
 * input means "clear this default" so the user can opt back out
 * without manually toggling a checkbox.
 *
 * The model side normally leaves all three empty (inherits whatever
 * the DB has at runtime). Setting these explicitly is useful when:
 *   - Generated SQL must declare the defaults at CREATE TABLE time
 *   - Diff against a live DB needs to know which collation is "the
 *     baseline" so per-table inherited values don't show up as drift
 */
export class DatabasePropertiesDialog extends BaseDialog<DatabaseDefaults | null> {

    private readonly _initial: DatabaseDefaults;
    private readonly _databaseName: string;
    private readonly _engine: HTMLInputElement;
    private readonly _charset: HTMLInputElement;
    private readonly _collation: HTMLInputElement;

    public constructor(databaseName: string, initial: DatabaseDefaults) {
        super(`Database properties · ${databaseName}`);
        this._dialog.classList.add('database-properties-dialog');
        this._initial = initial;
        this._databaseName = databaseName;

        const intro = document.createElement('p');
        intro.className = 'project-settings-intro';
        intro.textContent = 'Defaults inherited by every table in this database. Tables override per-table via their own options dialog. Leave blank to clear a default.';
        this._body.append(intro);

        this._engine = this.addInput('Default engine', initial.defaultEngine ?? '');
        this._engine.placeholder = 'e.g. InnoDB';
        this._charset = this.addInput('Default character set', initial.defaultCharset ?? '');
        this._charset.placeholder = 'e.g. utf8mb4';
        this._collation = this.addInput('Default collation', initial.defaultCollation ?? '');
        this._collation.placeholder = 'e.g. utf8mb4_unicode_ci';

        const hint = document.createElement('p');
        hint.className = 'edit-project-hint';
        hint.textContent = 'After save, the live-DB diff will treat tables with matching inherited values as in-sync — no more spurious ALTER TABLE ... COLLATE= noise.';
        this._body.append(hint);

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton('Save', 'primary', (): void => this._submit());
    }

    /**
     * Build the diff-only patch: a key is included only if its
     * trimmed value differs from the initial state. Trimmed-empty
     * fields produce `''` so the server-side clears that default;
     * unchanged fields are omitted entirely so the server leaves
     * them alone.
     */
    private _submit(): void {
        const patch: DatabaseDefaults = {};
        const cmp = (
            key: keyof DatabaseDefaults,
            input: HTMLInputElement
        ): void => {
            const next = input.value.trim();
            const prev = (this._initial[key] ?? '').trim();
            if (next !== prev) {patch[key] = next;}
        };
        cmp('defaultEngine', this._engine);
        cmp('defaultCharset', this._charset);
        cmp('defaultCollation', this._collation);
        this.close(patch);
    }

}