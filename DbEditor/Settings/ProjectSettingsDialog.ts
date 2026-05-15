import {BaseDialog} from '../Base/BaseDialog.js';
import {OutputSettings} from '../Api/DbApiClient.js';

/**
 * Editor for the project-level output settings. Values shown initially are
 * the *effective* config (dbeditor.json defaults merged with any persisted
 * overrides); saving rewrites the per-project override layer. The
 * underlying dbeditor.json is never touched — dialect, name, schemaPath,
 * connections and scripts stay outside the UI's reach.
 *
 * Returns the new patch on OK (keyed only by fields the user changed) and
 * `null` on Cancel.
 */
export class ProjectSettingsDialog extends BaseDialog<Partial<OutputSettings> | null> {

    private readonly _initial: OutputSettings;
    private readonly _mode: HTMLSelectElement;
    private readonly _destinationPath: HTMLInputElement;
    private readonly _destinationClear: HTMLInputElement;
    private readonly _sqlComment: HTMLInputElement;
    private readonly _sqlIndent: HTMLInputElement;
    private readonly _statementTerminator: HTMLInputElement;
    private readonly _migrationFilenamePattern: HTMLInputElement;

    public constructor(projectName: string, current: OutputSettings) {
        super(`Project settings · ${projectName}`);
        this._initial = current;
        this._dialog.classList.add('project-settings-dialog');

        const intro = document.createElement('p');
        intro.className = 'project-settings-intro';
        intro.textContent = 'Output settings for this project. Values default from dbeditor.json; changes here override per-project (stored in the schema file).';
        this._body.append(intro);

        this._mode = this.addSelect('Output mode', [
            {value: 'ddl-files', label: 'ddl-files — one .sql per table'},
            {value: 'migrations', label: 'migrations — timestamped up/down pairs'}
        ], current.mode);

        this._destinationPath = this.addInput('Destination path', current.destinationPath);
        this._destinationClear = this.addCheckbox('Clear destination directory before generating', current.destinationClear);
        this._sqlComment = this.addCheckbox('Emit -- comments in generated SQL', current.sqlComment);
        this._sqlIndent = this.addInput('SQL indent', current.sqlIndent);
        /*
         * Whitespace-content hint below the SQL indent field — without
         * this the textbox looks empty whether the value is `''` or
         * `'    '` (four invisible spaces). The hint refreshes as
         * the user edits so they can tell what's actually stored.
         */
        ProjectSettingsDialog._attachWhitespaceHint(this._sqlIndent);
        this._statementTerminator = this.addInput('Statement terminator', current.statementTerminator);
        this._migrationFilenamePattern = this.addInput('Migration filename pattern', current.migrationFilenamePattern);
        ProjectSettingsDialog._attachStaticHint(
            this._migrationFilenamePattern,
            'Placeholders: {timestamp} = sortable ISO-like stamp, {name} = user-supplied migration name. Both are required for unique filenames.'
        );

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton('Save', 'primary', (): void => this._submit());
    }

    private _submit(): void {
        const patch: Partial<OutputSettings> = {};
        if (this._mode.value !== this._initial.mode) {patch.mode = this._mode.value;}
        if (this._destinationPath.value !== this._initial.destinationPath) {patch.destinationPath = this._destinationPath.value;}
        if (this._destinationClear.checked !== this._initial.destinationClear) {patch.destinationClear = this._destinationClear.checked;}
        if (this._sqlComment.checked !== this._initial.sqlComment) {patch.sqlComment = this._sqlComment.checked;}
        if (this._sqlIndent.value !== this._initial.sqlIndent) {patch.sqlIndent = this._sqlIndent.value;}
        if (this._statementTerminator.value !== this._initial.statementTerminator) {patch.statementTerminator = this._statementTerminator.value;}
        if (this._migrationFilenamePattern.value !== this._initial.migrationFilenamePattern) {patch.migrationFilenamePattern = this._migrationFilenamePattern.value;}
        this.close(patch);
    }

    /**
     * Surface whitespace contents below a text input — without this
     * the user can't tell `''` from `'    '` (four invisible spaces)
     * in the SQL indent field.
     */
    private static _attachWhitespaceHint(input: HTMLInputElement): void {
        const hint = document.createElement('div');
        hint.className = 'dialog-input-hint';
        const describe = (v: string): string => {
            if (v === '') {return '(empty — flat single-line SQL)';}
            const spaces = v.split('').filter(c => c === ' ').length;
            const tabs = v.split('').filter(c => c === '\t').length;
            const other = v.length - spaces - tabs;
            const parts: string[] = [];
            if (spaces > 0) {parts.push(`${spaces} space${spaces === 1 ? '' : 's'}`);}
            if (tabs > 0)   {parts.push(`${tabs} tab${tabs === 1 ? '' : 's'}`);}
            if (other > 0)  {parts.push(`${other} other char${other === 1 ? '' : 's'} (unusual!)`);}
            return `(${parts.join(' + ')})`;
        };
        hint.textContent = describe(input.value);
        input.parentElement?.append(hint);
        input.addEventListener('input', () => {
            hint.textContent = describe(input.value);
        });
    }

    /** Static descriptive hint below an input — for placeholder tokens etc. */
    private static _attachStaticHint(input: HTMLInputElement, text: string): void {
        const hint = document.createElement('div');
        hint.className = 'dialog-input-hint';
        hint.textContent = text;
        input.parentElement?.append(hint);
    }

}