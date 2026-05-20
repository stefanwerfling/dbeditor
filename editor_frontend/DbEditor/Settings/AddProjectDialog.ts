import {BaseDialog} from '../Base/BaseDialog.js';
import {AddProjectInput} from '../Api/DbApiClient.js';

/**
 * Collects the minimum fields needed to add a new project entry to
 * `dbeditor.json`. Returns the populated input on Create, or `null` on
 * Cancel.
 *
 * The dialog auto-derives the schema path and the output destination
 * path from a slugified version of the name so the user only has to
 * type one thing in the common case; both fields stay editable.
 */
export class AddProjectDialog extends BaseDialog<AddProjectInput | null> {

    private readonly _name: HTMLInputElement;
    private readonly _schemaPath: HTMLInputElement;
    private readonly _dialect: HTMLSelectElement;
    private readonly _mode: HTMLSelectElement;
    private readonly _destinationPath: HTMLInputElement;
    /*
     * Tracks whether the user has manually edited the auto-derived
     * paths. Once they have, we stop auto-rewriting them on every
     * keystroke — otherwise typing in `name` would clobber custom
     * paths and surprise the user.
     */
    private _schemaPathEdited = false;
    private _destinationPathEdited = false;

    public constructor() {
        super('Add project');
        this._dialog.classList.add('add-project-dialog');

        const intro = document.createElement('p');
        intro.className = 'project-settings-intro';
        intro.textContent = 'Append a new project to dbeditor.json. The dev server will restart and the new project will appear in the sidebar.';
        this._body.append(intro);

        this._name = this.addInput('Name', '');
        this._name.placeholder = 'MyDatabase';
        this._schemaPath = this.addInput('Schema path', './schemas/database.json');
        this._dialect = this.addSelect('Dialect', [
            {value: 'mysql', label: 'mysql'},
            {value: 'mariadb', label: 'mariadb'},
            {value: 'postgres', label: 'postgres'},
            {value: 'sqlite', label: 'sqlite'}
        ], 'mysql');
        this._mode = this.addSelect('Output mode', [
            {value: 'ddl-files', label: 'ddl-files — one .sql per table'},
            {value: 'migrations', label: 'migrations — timestamped up/down pairs'}
        ], 'ddl-files');
        this._destinationPath = this.addInput('Destination path', './schemas/sql');

        this._schemaPath.addEventListener('input', (): void => { this._schemaPathEdited = true; });
        this._destinationPath.addEventListener('input', (): void => { this._destinationPathEdited = true; });
        this._name.addEventListener('input', (): void => this._refreshDerivedPaths());

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton('Create', 'primary', (): void => this._submit());
    }

    /**
     * Slugify a name into something filesystem-safe: lowercase, keep
     * alphanumerics + `-` + `_`, replace everything else with `-`,
     * collapse repeats, strip leading/trailing `-`. Falls back to
     * `database` if the result is empty (e.g. user typed only special
     * characters).
     */
    private static _slug(name: string): string {
        const lower = name.toLowerCase();
        const replaced = lower.replace(/[^a-z0-9_-]+/gu, '-');
        const collapsed = replaced.replace(/-+/gu, '-');
        const trimmed = collapsed.replace(/^-+|-+$/gu, '');
        return trimmed === '' ? 'database' : trimmed;
    }

    private _refreshDerivedPaths(): void {
        const slug = AddProjectDialog._slug(this._name.value);
        if (!this._schemaPathEdited) {
            this._schemaPath.value = `./schemas/${slug}.json`;
        }
        if (!this._destinationPathEdited) {
            this._destinationPath.value = `./schemas/${slug}-sql`;
        }
    }

    private _submit(): void {
        const name = this._name.value.trim();
        if (name === '') {
            this._name.focus();
            return;
        }
        const schemaPath = this._schemaPath.value.trim();
        if (schemaPath === '') {
            this._schemaPath.focus();
            return;
        }
        const destinationPath = this._destinationPath.value.trim();
        if (destinationPath === '') {
            this._destinationPath.focus();
            return;
        }
        this.close({
            name: name,
            schemaPath: schemaPath,
            dialect: this._dialect.value,
            output: {
                mode: this._mode.value,
                destinationPath: destinationPath
            }
        });
    }

}