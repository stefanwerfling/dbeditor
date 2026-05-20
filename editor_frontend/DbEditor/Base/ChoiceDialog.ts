import {BaseDialog} from './BaseDialog.js';

export type ChoiceDialogChoice<T extends string> = {
    value: T;
    label: string;
    kind: 'primary' | 'grey' | 'danger';
};

/**
 * Like `ConfirmDialog` but offers more than two outcomes — the
 * caller picks the labels, kinds, and resolves to the chosen value
 * (or `null` on cancel / Esc / backdrop click).
 *
 * Used where a yes/no dialog isn't enough — e.g. choosing between
 * "Replace" and "Append" on .mwb import.
 */
export class ChoiceDialog<T extends string> extends BaseDialog<T | null> {

    public constructor(title: string, message: string, choices: ChoiceDialogChoice<T>[]) {
        super(title);
        const p = document.createElement('div');
        p.textContent = message;
        p.style.whiteSpace = 'pre-wrap';
        this._body.append(p);
        this.addButton('Cancel', 'grey', (): void => this.close(null));
        for (const c of choices) {
            this.addButton(c.label, c.kind, (): void => this.close(c.value));
        }
    }

    public static showChoice<T extends string>(
        title: string,
        message: string,
        choices: ChoiceDialogChoice<T>[]
    ): Promise<T | null> {
        return new ChoiceDialog<T>(title, message, choices).show();
    }

}