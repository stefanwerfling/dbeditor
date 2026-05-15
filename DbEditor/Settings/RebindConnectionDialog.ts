import {BaseDialog} from '../Base/BaseDialog.js';
import {AddConnectionDatabaseChoice} from './AddConnectionDialog.js';

/**
 * Small picker that lets the user point an existing connection at a
 * different model database — preserves every credential field, only
 * the `databaseUnid` binding changes. Solves the stale-uuid friction
 * when the schema file gets regenerated and the connection's
 * `databaseUnid` no longer matches.
 *
 * The `availableDatabases` list should already exclude every database
 * that has another connection (one-connection-per-database is enforced
 * server-side too). The current binding is included so the user can
 * back out of the picker without a no-op submission.
 *
 * Cancel resolves with `null`. Submit resolves with the picked
 * `databaseUnid` — caller compares against the current binding and
 * skips the server round-trip if they match.
 */
export class RebindConnectionDialog extends BaseDialog<string | null> {

    private readonly _select: HTMLSelectElement | null;

    public constructor(
        currentDatabaseUnid: string,
        currentDatabaseName: string | null,
        availableDatabases: AddConnectionDatabaseChoice[]
    ) {
        super(`Rebind connection · ${currentDatabaseName ?? currentDatabaseUnid}`);
        this._dialog.classList.add('rebind-connection-dialog');

        const intro = document.createElement('p');
        intro.className = 'project-settings-intro';
        intro.textContent = 'Point this connection at a different model database. Host, user, password, port, SSL and read-only flag stay as they are. The dev server restarts after Save.';
        this._body.append(intro);

        if (availableDatabases.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'project-info-empty';
            empty.textContent = 'No other model databases are available to rebind to — every other database already has its own connection.';
            this._body.append(empty);
            this._select = null;
            this.addButton('Close', 'grey', (): void => this.close(null));
            return;
        }

        this._select = this.addSelect(
            'New model database',
            availableDatabases.map(d => ({
                value: d.unid,
                label: d.unid === currentDatabaseUnid ? `${d.name} (current)` : d.name
            })),
            currentDatabaseUnid
        );

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        this.addButton('Save', 'primary', (): void => {
            const v = this._select?.value.trim() ?? '';
            this.close(v === '' ? null : v);
        });
    }

}