import {BaseDialog} from '../Base/BaseDialog.js';
import {KEYBOARD_SHORTCUTS, categoriesInOrder, ShortcutCategory} from '../Util/Shortcuts.js';

/**
 * Read-only listing of every keyboard / mouse shortcut. Grouped by
 * category and rendered as a definition list. Opens via the `?` key
 * (no modifiers) or the topbar "?" button.
 */
export class ShortcutHelpDialog extends BaseDialog<void> {

    public constructor() {
        super('Keyboard shortcuts');
        this._dialog.classList.add('shortcut-help-dialog');

        for (const category of categoriesInOrder) {
            this._body.append(this._renderSection(category));
        }

        this.addButton('Close', 'grey', (): void => this.close());
    }

    private _renderSection(category: ShortcutCategory): HTMLDivElement {
        const wrap = document.createElement('div');
        wrap.className = 'shortcut-help-section';
        const h = document.createElement('h4');
        h.className = 'shortcut-help-section-title';
        h.textContent = category;
        wrap.append(h);

        const dl = document.createElement('dl');
        dl.className = 'shortcut-help-dl';
        for (const s of KEYBOARD_SHORTCUTS) {
            if (s.category !== category) {continue;}
            const dt = document.createElement('dt');
            /*
             * Render comma-separated alternatives as separate kbd elements
             * so each chord is visually distinct.
             */
            const chords = s.keys.split(',').map(c => c.trim());
            chords.forEach((chord, i) => {
                if (i > 0) {
                    const or = document.createElement('span');
                    or.className = 'shortcut-help-or';
                    or.textContent = ' or ';
                    dt.append(or);
                }
                const kbd = document.createElement('kbd');
                kbd.className = 'shortcut-help-kbd';
                kbd.textContent = chord;
                dt.append(kbd);
            });
            const dd = document.createElement('dd');
            dd.textContent = s.label;
            dl.append(dt, dd);
        }
        wrap.append(dl);
        return wrap;
    }

}