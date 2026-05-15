import {BaseDialog} from './BaseDialog.js';

/**
 * Plain message dialog. Replacement for window.alert (which JetBrains
 * flags and which can't be styled to match the rest of the UI).
 */
export class AlertDialog extends BaseDialog<void> {

    public constructor(title: string, message: string) {
        super(title);
        const p = document.createElement('div');
        p.textContent = message;
        p.style.whiteSpace = 'pre-wrap';
        this._body.append(p);
        this.addButton('OK', 'primary', () => this.close());
    }

    public static showAlert(title: string, message: string): Promise<void> {
        return new AlertDialog(title, message).show();
    }

}