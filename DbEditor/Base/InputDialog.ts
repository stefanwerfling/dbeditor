import {BaseDialog} from './BaseDialog.js';

/**
 * Single-input prompt dialog. Styled replacement for `window.prompt`
 * — same shape (title, label, default value, returns string or null
 * on cancel) but rendered inline so it matches the rest of the
 * editor's dialogs instead of looking like a native browser prompt.
 *
 * Usage:
 *
 *   const name = await InputDialog.showInput('Table name?', 'New table name', 'new_table');
 *   if (!name) {return;}
 *
 * Enter submits, Esc cancels (the BaseDialog Esc-handler picks that up).
 */
export class InputDialog extends BaseDialog<string | null> {

    private readonly _input: HTMLInputElement;

    public constructor(title: string, label: string, value = '') {
        super(title);
        this._dialog.classList.add('input-dialog');
        this._input = this.addInput(label, value);
        this._input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.close(this._input.value.trim() || null);
            }
        });
        this.addButton('Cancel', 'grey', () => this.close(null));
        this.addButton('OK', 'primary', () => this.close(this._input.value.trim() || null));
        /* Focus + select-all on next tick so the default value can be replaced by typing. */
        setTimeout(() => {
            this._input.focus();
            this._input.select();
        }, 0);
    }

    public static showInput(title: string, label: string, value = ''): Promise<string | null> {
        return new InputDialog(title, label, value).show();
    }

}