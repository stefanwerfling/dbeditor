import {BaseDialog} from '../Base/BaseDialog.js';
import {JsonDiagram} from '../JsonData.js';

/**
 * Result shape — `null` on cancel, a list of selected diagram unids
 * on apply. The list represents the FULL desired set of memberships
 * for the target table; the caller decides which becomes the primary
 * (`diagramUnid`) and which become additional placements.
 */
export type LayerMembershipResult = string[] | null;

/**
 * Multi-select picker for a single table's EER diagram memberships.
 * Each row is a checkbox; the user toggles every diagram the table
 * should appear in. Empty result = unassign from every diagram.
 *
 * Counterpart to `DiagramPickerDialog`, which is single-select and
 * used for batch (2+ tables → one shared diagram). For single
 * tables, this dialog gives MWB-style "this table is in diagram A,
 * B, and C with different positions in each" management.
 */
export class DiagramMembershipDialog extends BaseDialog<LayerMembershipResult> {

    private readonly _checkboxes: Map<string, HTMLInputElement> = new Map();

    public constructor(layers: JsonDiagram[], currentMemberships: string[]) {
        super('EER diagram memberships');
        this._dialog.classList.add('diagram-picker-dialog');

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
        intro.textContent = 'Tick every EER diagram this table should appear in. Same table can sit in multiple diagrams with independent positions per diagram.';
        this._body.append(intro);

        const list = document.createElement('div');
        list.className = 'diagram-picker-list';
        const current = new Set(currentMemberships);
        for (const l of layers) {
            const row = document.createElement('label');
            row.className = 'diagram-picker-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = l.unid;
            cb.checked = current.has(l.unid);
            this._checkboxes.set(l.unid, cb);
            const name = document.createElement('span');
            name.className = 'diagram-picker-name';
            name.textContent = l.name;
            row.append(cb, name);
            list.append(row);
        }
        this._body.append(list);

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton('Apply', 'primary', (): void => {
            const picked: string[] = [];
            for (const [unid, cb] of this._checkboxes) {
                if (cb.checked) {picked.push(unid);}
            }
            this.close(picked);
        });
    }

}