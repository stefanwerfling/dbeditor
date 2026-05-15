import {BaseDialog} from '../Base/BaseDialog.js';
import {JsonLayer} from '../JsonData.js';

/**
 * Dialog return values:
 *   `null`         — user cancelled, no change.
 *   `''` (empty)   — user picked "(no diagram)" → unassign the table(s).
 *   any other str  — the chosen diagram's unid.
 *
 * Note: internal identifiers still say "layer" (the data model field
 * is `JsonTable.layerUnid` — renaming the data model would break
 * .mwb round-trip + every persisted schema). UI-facing strings say
 * "EER diagram" because that's what users know from Workbench.
 */
export type LayerPickerResult = string | null;

/**
 * Pick a single EER diagram (or none) for one or more tables.
 * Used by the table card ⋯ menu's "Assign to EER diagram…" entry
 * and by the keyboard shortcut for the canvas selection. The
 * current `selectedLayerUnid` (if homogeneous across the targets)
 * pre-selects its row; mixed selections start with no row selected.
 */
export class LayerPickerDialog extends BaseDialog<LayerPickerResult> {

    private _picked: string | null = null;

    public constructor(layers: JsonLayer[], targetCount: number, currentLayerUnid: string | null) {
        super(targetCount === 1 ? 'Assign to EER diagram' : `Assign ${targetCount} tables to EER diagram`);
        this._dialog.classList.add('layer-picker-dialog');

        if (layers.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'dialog-intro';
            empty.textContent = 'No EER diagrams exist in this database. Right-click the database in the treeview to add one first.';
            this._body.append(empty);
            this.addButton('Close', 'grey', (): void => this.close(null));
            return;
        }

        const intro = document.createElement('p');
        intro.className = 'dialog-intro';
        intro.textContent = targetCount === 1
            ? 'Pick an EER diagram for this table, or remove the assignment.'
            : `Pick an EER diagram to apply to all ${targetCount} selected tables.`;
        this._body.append(intro);

        const list = document.createElement('div');
        list.className = 'layer-picker-list';

        const noneRow = this._buildOption('', '(no diagram)', currentLayerUnid === '');
        list.append(noneRow);

        for (const l of layers) {
            const row = this._buildOption(l.unid, l.name, currentLayerUnid === l.unid, l.color);
            list.append(row);
        }
        this._body.append(list);

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton('Apply', 'primary', (): void => this.close(this._picked));
    }

    private _buildOption(value: string, label: string, isCurrent: boolean, color?: string): HTMLLabelElement {
        const row = document.createElement('label');
        row.className = 'layer-picker-row';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'layer-picker';
        radio.value = value;
        if (isCurrent) {
            radio.checked = true;
            this._picked = value;
        }
        radio.addEventListener('change', () => {this._picked = value;});
        const swatch = document.createElement('span');
        swatch.className = 'layer-picker-swatch';
        if (color) {swatch.style.background = color;}
        const name = document.createElement('span');
        name.className = 'layer-picker-name';
        name.textContent = label;
        row.append(radio, swatch, name);
        return row;
    }

}