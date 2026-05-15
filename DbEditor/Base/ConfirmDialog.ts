import {BaseDialog} from './BaseDialog.js';

export class ConfirmDialog extends BaseDialog<boolean> {

    public constructor(title: string, message: string, kind: 'primary' | 'danger' = 'primary') {
        super(title);
        const p = document.createElement('div');
        p.textContent = message;
        p.style.whiteSpace = 'pre-wrap';
        this._body.append(p);
        this.addButton('Cancel', 'grey', () => this.close(false));
        this.addButton('OK', kind, () => this.close(true));
    }

    public static showConfirm(title: string, message: string, kind: 'primary' | 'danger' = 'primary'): Promise<boolean> {
        return new ConfirmDialog(title, message, kind).show();
    }

}