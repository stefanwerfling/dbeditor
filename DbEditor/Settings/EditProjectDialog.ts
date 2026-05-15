import {BaseDialog} from '../Base/BaseDialog.js';
import {UpdateProjectInput} from '../Api/DbApiClient.js';

export type ProjectForEdit = {
    name: string;
    schemaPath: string;
    dialect: string;
    outputMode: string;
    outputDestinationPath: string;
    autoGenerate: boolean;
};

/**
 * Edit form for an existing project entry in dbeditor.json. Pre-fills
 * every field from the supplied snapshot; submit returns only the
 * fields the user actually changed (or `null` on Cancel).
 *
 * Scope deliberately matches `AddProjectDialog`: dbeditor.json-only
 * fields. Output overrides written by `ProjectSettingsDialog` to the
 * schema file (`destinationClear`, `sqlIndent`, terminator, …) stay
 * managed there — they take precedence at runtime via
 * `repo.effectiveOutput()`.
 *
 * Renames and schemaPath changes ARE allowed. The server validates
 * uniqueness against other projects; the repo's `_loadFromDisk` seeds
 * an empty schema if the new schemaPath doesn't exist on disk yet (so
 * pointing at a fresh path is non-destructive — the old file stays).
 */
export class EditProjectDialog extends BaseDialog<UpdateProjectInput | null> {

    private readonly _initial: ProjectForEdit;
    private readonly _name: HTMLInputElement;
    private readonly _schemaPath: HTMLInputElement;
    private readonly _dialect: HTMLSelectElement;
    private readonly _mode: HTMLSelectElement;
    private readonly _destinationPath: HTMLInputElement;
    private readonly _autoGenerate: HTMLInputElement;

    public constructor(initial: ProjectForEdit) {
        super(`Edit project · ${initial.name}`);
        this._dialog.classList.add('edit-project-dialog');
        this._initial = initial;

        const intro = document.createElement('p');
        intro.className = 'project-settings-intro';
        intro.textContent = 'Patches dbeditor.json in place. The dev server restarts on Save and the page reloads.';
        this._body.append(intro);

        this._name = this.addInput('Name', initial.name);
        this._schemaPath = this.addInput('Schema path', initial.schemaPath);
        const schemaHint = document.createElement('p');
        schemaHint.className = 'edit-project-hint';
        schemaHint.textContent = 'Changing the schema path is non-destructive — the original file stays on disk. A fresh path will start empty.';
        this._body.append(schemaHint);

        this._dialect = this.addSelect('Dialect', [
            {value: 'mysql', label: 'mysql'},
            {value: 'mariadb', label: 'mariadb'},
            {value: 'postgres', label: 'postgres'},
            {value: 'sqlite', label: 'sqlite'}
        ], initial.dialect);

        this._mode = this.addSelect('Output mode', [
            {value: 'ddl-files', label: 'ddl-files — one .sql per table'},
            {value: 'migrations', label: 'migrations — timestamped up/down pairs'}
        ], initial.outputMode);

        this._destinationPath = this.addInput('Destination path', initial.outputDestinationPath);
        this._autoGenerate = this.addCheckbox('Auto-generate SQL after every edit', initial.autoGenerate);

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton('Save', 'primary', (): void => this._submit());
    }

    private _submit(): void {
        const patch: UpdateProjectInput = {};

        const name = this._name.value.trim();
        if (name === '') { this._name.focus(); return; }
        if (name !== this._initial.name) {patch.name = name;}

        const schemaPath = this._schemaPath.value.trim();
        if (schemaPath === '') { this._schemaPath.focus(); return; }
        if (schemaPath !== this._initial.schemaPath) {patch.schemaPath = schemaPath;}

        if (this._dialect.value !== this._initial.dialect) {patch.dialect = this._dialect.value;}

        const outPatch: NonNullable<UpdateProjectInput['output']> = {};
        if (this._mode.value !== this._initial.outputMode) {outPatch.mode = this._mode.value;}
        const destinationPath = this._destinationPath.value.trim();
        if (destinationPath === '') { this._destinationPath.focus(); return; }
        if (destinationPath !== this._initial.outputDestinationPath) {outPatch.destinationPath = destinationPath;}
        if (Object.keys(outPatch).length > 0) {patch.output = outPatch;}

        if (this._autoGenerate.checked !== this._initial.autoGenerate) {patch.autoGenerate = this._autoGenerate.checked;}

        this.close(patch);
    }

}