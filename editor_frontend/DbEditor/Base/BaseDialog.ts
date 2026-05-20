/**
 * Minimal modal dialog. Subclasses build the body, then call `show()`.
 * `close()` removes from DOM and resolves the promise returned by show().
 *
 * Esc closes the topmost open dialog with the same "cancel" value as
 * a backdrop click (`undefined` cast through the generic). A single
 * document-level keydown listener is installed lazily on first show
 * and consults the static stack so nested dialogs unwind in order.
 */
export abstract class BaseDialog<T = void> {

    private static _stack: BaseDialog<any>[] = [];
    private static _keyHandler: ((e: KeyboardEvent) => void) | null = null;

    protected _backdrop: HTMLDivElement;
    protected _dialog: HTMLDivElement;
    protected _header: HTMLDivElement;
    protected _body: HTMLDivElement;
    protected _footer: HTMLDivElement;
    private _resolve: ((value: T) => void) | null = null;
    private _isOpen = false;

    public constructor(title: string) {
        this._backdrop = document.createElement('div');
        this._backdrop.className = 'dialog-backdrop';
        this._dialog = document.createElement('div');
        this._dialog.className = 'dialog';
        this._header = document.createElement('div');
        this._header.className = 'dialog-header';
        this._header.textContent = title;
        this._body = document.createElement('div');
        this._body.className = 'dialog-body';
        this._footer = document.createElement('div');
        this._footer.className = 'dialog-footer';
        this._dialog.append(this._header, this._body, this._footer);
        this._backdrop.append(this._dialog);
        this._backdrop.addEventListener('mousedown', (e) => {
            if (e.target === this._backdrop) {this.close(undefined as unknown as T);}
        });
    }

    public show(): Promise<T> {
        document.body.append(this._backdrop);
        BaseDialog._push(this);
        this._isOpen = true;
        return new Promise<T>((resolve) => { this._resolve = resolve; });
    }

    public close(value: T): void {
        if (this._isOpen) {
            BaseDialog._remove(this);
            this._isOpen = false;
        }
        this._backdrop.remove();
        if (this._resolve) { this._resolve(value); this._resolve = null; }
    }

    private static _push(d: BaseDialog<any>): void {
        BaseDialog._stack.push(d);
        if (BaseDialog._keyHandler === null) {
            BaseDialog._keyHandler = (e: KeyboardEvent): void => {
                if (e.key !== 'Escape') {return;}
                const top = BaseDialog._stack[BaseDialog._stack.length - 1];
                if (!top) {return;}
                e.preventDefault();
                e.stopPropagation();
                top.close(undefined);
            };
            document.addEventListener('keydown', BaseDialog._keyHandler, true);
        }
    }

    private static _remove(d: BaseDialog<any>): void {
        const i = BaseDialog._stack.indexOf(d);
        if (i >= 0) {BaseDialog._stack.splice(i, 1);}
    }

    protected addRow(label: string): { row: HTMLDivElement; labelEl: HTMLLabelElement; } {
        const row = document.createElement('div');
        row.className = 'dialog-row';
        const labelEl = document.createElement('label');
        labelEl.textContent = label;
        row.append(labelEl);
        this._body.append(row);
        return { row: row, labelEl: labelEl };
    }

    protected addInput(label: string, value = ''): HTMLInputElement {
        const { row } = this.addRow(label);
        const input = document.createElement('input');
        input.value = value;
        row.append(input);
        return input;
    }

    protected addSelect(label: string, options: { value: string; label: string; }[], value = ''): HTMLSelectElement {
        const { row } = this.addRow(label);
        const sel = document.createElement('select');
        for (const o of options) {
            const opt = document.createElement('option');
            opt.value = o.value; opt.textContent = o.label;
            sel.append(opt);
        }
        sel.value = value;
        row.append(sel);
        return sel;
    }

    protected addCheckbox(label: string, value = false): HTMLInputElement {
        const row = document.createElement('div');
        row.className = 'dialog-row dialog-row-checkbox';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = value;
        const labelEl = document.createElement('label');
        labelEl.textContent = label;
        labelEl.style.cursor = 'pointer';
        labelEl.addEventListener('click', () => { cb.checked = !cb.checked; });
        row.append(cb, labelEl);
        this._body.append(row);
        return cb;
    }

    protected addButton(label: string, kind: 'primary' | 'grey' | 'danger', onClick: () => void): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.textContent = label;
        const variants: Record<string, string> = {primary: ' btn-primary', danger: ' btn-danger', grey: ''};
        btn.className = `btn-grey${variants[kind] ?? ''}`;
        btn.addEventListener('click', onClick);
        this._footer.append(btn);
        return btn;
    }

}