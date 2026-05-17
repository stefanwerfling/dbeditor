import {BaseDialog} from '../Base/BaseDialog.js';

export type LayerColorResult = string | null;

/**
 * Pick a backdrop color for a diagram. Returns the chosen hex (`#rrggbb`)
 * or `null` on cancel. The caller is responsible for appending the
 * alpha suffix to keep diagram fills translucent.
 *
 * Native `<input type="color">` is the simplest cross-browser picker
 * we can lean on; users get the OS-native color UI and we don't have
 * to ship our own swatch grid.
 */
export class LayerColorDialog extends BaseDialog<LayerColorResult> {

    private _input: HTMLInputElement;

    public constructor(layerName: string, currentHex: string) {
        super(`EER diagram color · ${layerName}`);

        const {row} = this.addRow('Backdrop color');
        this._input = document.createElement('input');
        this._input.type = 'color';
        this._input.value = currentHex || '#3e7e9c';
        row.append(this._input);

        const note = document.createElement('p');
        note.className = 'dialog-intro';
        note.textContent = 'The picker shows opaque colors; the diagram backdrop renders translucent so cards on top stay readable.';
        this._body.append(note);

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton('Apply', 'primary', (): void => this.close(this._input.value));
    }

}

/**
 * Best-effort extract the leading `#rrggbb` from a color string. The
 * stored color is typically `rgba(...)` from the parser palette or
 * `#rrggbbAA` from a previous picker save. The native input requires
 * a pure 6-digit hex; this helper hands it whatever we can recover.
 */
export const extractHex = (color: string | undefined): string => {
    if (!color) {return '';}
    const hex = color.match(/^#([0-9a-f]{6})/iu);
    if (hex) {return `#${hex[1]}`;}
    /*
     * Parse rgba(r, g, b[, a]) — palette colors look like
     * `rgba(64, 145, 220, 0.10)`. Round and pad each channel.
     */
    const m = color.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/u);
    if (m) {
        const toHex = (n: string): string => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
        return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`;
    }
    return '';
};