import {BaseDialog} from '../Base/BaseDialog.js';

export type SyncSettingsValue = {
    ignoreTables: string[];
    ignoreColumnAttributes: string[];
};

/**
 * Modal editor for the per-project sync settings. Both lists are entered
 * as one-name-per-line in a textarea — same affordance as `.gitignore`,
 * familiar and easy to paste into / out of. Empty lines and whitespace-
 * only lines are stripped on save; ordering is preserved.
 *
 * Returns the new value on OK, `null` on Cancel.
 */
export class SyncSettingsDialog extends BaseDialog<SyncSettingsValue | null> {

    private readonly _tablesArea: HTMLTextAreaElement;
    private readonly _attrsArea: HTMLTextAreaElement;

    public constructor(current: SyncSettingsValue) {
        super('Sync — ignore patterns');
        this._dialog.classList.add('sync-settings-dialog');

        const intro = document.createElement('p');
        intro.className = 'sync-settings-intro';
        intro.textContent = 'One entry per line. Empty lines are ignored. Settings apply to every Sync run in this project.';
        this._body.append(intro);

        this._tablesArea = SyncSettingsDialog._buildSection(
            this._body,
            'Ignored tables',
            'Tables whose presence (or absence) the diff should treat as a non-difference. Useful for audit tables, migration history, etc.',
            current.ignoreTables
        );

        this._attrsArea = SyncSettingsDialog._buildSection(
            this._body,
            'Ignored column attributes',
            'Per-column attributes that should NOT count as differences. Common values: charset, collation.',
            current.ignoreColumnAttributes
        );

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton('Save', 'primary', (): void => {
            this.close({
                ignoreTables: SyncSettingsDialog._parseLines(this._tablesArea.value),
                ignoreColumnAttributes: SyncSettingsDialog._parseLines(this._attrsArea.value)
            });
        });
    }

    private static _buildSection(
        host: HTMLElement,
        label: string,
        hint: string,
        initial: string[]
    ): HTMLTextAreaElement {
        const wrap = document.createElement('div');
        wrap.className = 'sync-settings-section';
        const lbl = document.createElement('label');
        lbl.className = 'sync-settings-label';
        lbl.textContent = label;
        const hintEl = document.createElement('div');
        hintEl.className = 'sync-settings-hint';
        hintEl.textContent = hint;
        const area = document.createElement('textarea');
        area.className = 'sync-settings-textarea';
        area.rows = 6;
        area.value = initial.join('\n');
        wrap.append(lbl, hintEl, area);
        host.append(wrap);
        return area;
    }

    private static _parseLines(text: string): string[] {
        const out: string[] = [];
        for (const raw of text.split('\n')) {
            const v = raw.trim();
            if (v) {out.push(v);}
        }
        return out;
    }

}