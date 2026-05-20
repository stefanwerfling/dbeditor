import {BaseDialog} from '../Base/BaseDialog.js';
import {JsonRoutine, JsonRoutineKind} from '../../../editor_schemas/JsonData.js';

export type RoutineDialogResult = {
    name: string;
    kind: string;
    body: string;
    description: string;
} | null;

/**
 * Editor for one stored procedure / function / trigger. The body is a
 * monospace textarea — the user pastes the full SQL (everything from
 * `CREATE PROCEDURE name(…)` through `END`); the generator emits it
 * verbatim with the dialect's framing (DELIMITER swap on MySQL, etc.).
 *
 * We don't parse parameters or return types — Workbench-parity for the
 * modeling half doesn't need it, and dialect-specific routine syntax
 * doesn't round-trip cleanly. Keep it opaque.
 */
export class DbRoutineDialog extends BaseDialog<RoutineDialogResult> {

    private _name: HTMLInputElement;
    private _kind: HTMLSelectElement;
    private _body: HTMLTextAreaElement;
    private _description: HTMLInputElement;

    public constructor(initial: JsonRoutine) {
        super(`Edit routine · ${initial.name}`);
        this._dialog.classList.add('routine-dialog');

        this._name = this.addInput('Name', initial.name);
        this._kind = this.addSelect('Kind', [
            {value: JsonRoutineKind.procedure, label: 'Procedure'},
            {value: JsonRoutineKind.function,  label: 'Function'},
            {value: JsonRoutineKind.trigger,   label: 'Trigger'}
        ], String(initial.kind || JsonRoutineKind.procedure));

        const {row: bodyRow} = this.addRow('SQL body');
        this._body = document.createElement('textarea');
        this._body.className = 'routine-dialog-body';
        this._body.value = initial.body ?? '';
        this._body.spellcheck = false;
        this._body.rows = 16;
        this._body.placeholder = 'CREATE PROCEDURE name(IN x INT)\nBEGIN\n  ...\nEND';
        bodyRow.append(this._body);

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
            kind: this._kind.value,
            body: this._body.value,
            description: this._description.value.trim()
        });
    }

}