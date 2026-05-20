import {BaseDialog} from './BaseDialog.js';
import {GeneratedFileResult} from '../Api/DbApiClient.js';

/**
 * Modal that surfaces the SQL files emitted by the last `Generate`
 * run. Two-pane layout: file list on the left, selected file's
 * content (monospace, read-only) on the right. The dialog is
 * informational — `OK` is the only way out.
 */
export class SqlPreviewDialog extends BaseDialog<void> {

    private _files: GeneratedFileResult[];
    private _content: HTMLPreElement;
    private _list: HTMLDivElement;
    private _activeRow: HTMLButtonElement | null = null;
    private _activeIndex = -1;
    private _copyBtn: HTMLButtonElement;

    public constructor(projectName: string, dialect: string, root: string, files: GeneratedFileResult[], displayKind = 'SQL') {
        super(`Generated ${displayKind} · ${projectName} (${dialect})`);
        this._files = files;
        this._dialog.classList.add('sql-preview-dialog');

        const meta = document.createElement('div');
        meta.className = 'sql-preview-meta';
        meta.textContent = files.length === 0
            ? `No files written. Output dir: ${root}`
            : `${files.length} file${files.length === 1 ? '' : 's'} written to ${root}`;
        this._body.append(meta);

        const split = document.createElement('div');
        split.className = 'sql-preview-split';
        this._body.append(split);

        this._list = document.createElement('div');
        this._list.className = 'sql-preview-list';
        split.append(this._list);

        const right = document.createElement('div');
        right.className = 'sql-preview-pane';
        split.append(right);

        this._content = document.createElement('pre');
        this._content.className = 'sql-preview-content';
        right.append(this._content);

        this._copyBtn = this.addButton('Copy', 'grey', (): void => this._copyActive());
        this._copyBtn.disabled = files.length === 0;
        this.addButton('OK', 'primary', (): void => this.close());

        this._renderList();
        if (files.length) {this._select(0);}
        else {this._content.textContent = '— nothing to preview —';}
    }

    private _renderList(): void {
        this._list.replaceChildren();
        this._files.forEach((f, idx) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'sql-preview-row';
            const name = document.createElement('span');
            name.className = 'sql-preview-row-name';
            name.textContent = f.relativePath;
            const size = document.createElement('span');
            size.className = 'sql-preview-row-size';
            size.textContent = `${f.content.length} B`;
            row.append(name, size);
            row.addEventListener('click', () => this._select(idx));
            this._list.append(row);
        });
    }

    private _select(idx: number): void {
        const file = this._files[idx];
        if (!file) {return;}
        this._activeIndex = idx;
        this._content.textContent = file.content;
        if (this._activeRow) {this._activeRow.classList.remove('sql-preview-row--active');}
        const row = this._list.children[idx] as HTMLButtonElement | undefined;
        if (row) {
            row.classList.add('sql-preview-row--active');
            this._activeRow = row;
        }
    }

    private _copyActive(): void {
        const file = this._files[this._activeIndex];
        if (!file) {return;}
        /*
         * Browser-only call; falls back silently if the API is missing
         * (e.g. non-secure context). We don't surface an error toast
         * for this — the dialog also shows the content inline.
         */
        const original = this._copyBtn.textContent;
        navigator.clipboard?.writeText(file.content).then((): void => {
            this._copyBtn.textContent = 'Copied';
            setTimeout((): void => { this._copyBtn.textContent = original; }, 1200);
        }).catch((): void => {
            this._copyBtn.textContent = 'Copy failed';
            setTimeout((): void => { this._copyBtn.textContent = original; }, 1500);
        });
    }

}