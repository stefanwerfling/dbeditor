import {BaseDialog} from '../Base/BaseDialog.js';
import {JsonForeignKeyAction} from '../JsonData.js';

const ACTIONS = [
    {value: '',                              label: '— default —'},
    {value: JsonForeignKeyAction.no_action,  label: 'NO ACTION'},
    {value: JsonForeignKeyAction.restrict,   label: 'RESTRICT'},
    {value: JsonForeignKeyAction.cascade,    label: 'CASCADE'},
    {value: JsonForeignKeyAction.set_null,   label: 'SET NULL'},
    {value: JsonForeignKeyAction.set_default,label: 'SET DEFAULT'}
];

export type FkDialogExisting = {
    name: string;
    onDelete?: string;
    onUpdate?: string;
};

/**
 * When the user dropped the FK draft on a card (not a specific column),
 * the dialog also asks for the to-be-created column's name. The result
 * carries it back as `newColumnName` so the caller can do the
 * `addColumn` → `addForeignKey` two-step.
 */
export type FkDialogAutoColumn = {
    /** Default proposal for the column to create on the target table. */
    proposedColumnName: string;
};

export type FkDialogResult =
    | {kind: 'save'; name: string; onDelete?: string; onUpdate?: string; newColumnName?: string;}
    | {kind: 'delete';}
    | null;

/**
 * Foreign-key dialog used for both create and edit. In create mode
 * (no `existing` arg) the source/target columns are already known and
 * the user only fills in the constraint name + referential actions.
 * In edit mode (`existing` provided) the same fields are prefilled
 * and a Delete button is added.
 *
 * When invoked from the card-drop auto-column flow (`autoColumn`
 * provided), an extra input lets the user rename the about-to-be-created
 * target column before commit.
 */
export class DbForeignKeyDialog extends BaseDialog<FkDialogResult> {

    private _name: HTMLInputElement;
    private _onDelete: HTMLSelectElement;
    private _onUpdate: HTMLSelectElement;
    private _newColumnName: HTMLInputElement | null = null;

    public constructor(
        srcTable: string, srcCol: string,
        dstTable: string, dstCol: string,
        existing?: FkDialogExisting,
        autoColumn?: FkDialogAutoColumn
    ) {
        const isEdit = Boolean(existing);
        super(`${isEdit ? 'Edit' : ''} Foreign key · ${srcTable}.${srcCol} → ${dstTable}.${dstCol}`.trim());
        if (autoColumn) {
            /*
             * The target column doesn't exist yet — surface the proposed
             * name first so the user notices the auto-column step before
             * filling in the constraint name.
             */
            this._newColumnName = this.addInput('New target column', autoColumn.proposedColumnName);
        }
        const initialName = existing?.name ?? `fk_${srcTable}_${srcCol}`;
        this._name = this.addInput('Constraint name', initialName);
        this._onDelete = this.addSelect('ON DELETE', ACTIONS, existing?.onDelete ?? '');
        this._onUpdate = this.addSelect('ON UPDATE', ACTIONS, existing?.onUpdate ?? '');
        if (isEdit) {
            this.addButton('Delete', 'danger', (): void => this.close({kind: 'delete'}));
        }
        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton(isEdit ? 'Save' : 'Create FK', 'primary', (): void => this._submit());
    }

    private _submit(): void {
        const name = this._name.value.trim();
        if (!name) {
            this._name.focus();
            return;
        }
        let newColumnName: string | undefined;
        if (this._newColumnName) {
            newColumnName = this._newColumnName.value.trim();
            if (!newColumnName) {
                this._newColumnName.focus();
                return;
            }
        }
        this.close({
            kind: 'save',
            name: name,
            onDelete: this._onDelete.value || undefined,
            onUpdate: this._onUpdate.value || undefined,
            newColumnName: newColumnName
        });
    }

}