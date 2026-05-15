/*
 * Literal ${VAR} placeholders in the default input values are *user-
 * facing examples* of the env-placeholder syntax that `dbeditor.json`
 * supports — they're persisted verbatim and resolved at server boot
 * by `resolveEnvPlaceholders`. Disable the lint check that flags
 * them as suspicious un-templated literals.
 */
/* eslint-disable no-template-curly-in-string */
import {BaseDialog} from '../Base/BaseDialog.js';
import {AddConnectionInput} from '../Api/DbApiClient.js';
import {iconCheck, iconCross} from '../Util/Icons.js';

export type AddConnectionDatabaseChoice = {
    unid: string;
    name: string;
};

/**
 * Per-dialect default port. MySQL/MariaDB share the long-standing
 * 3306; Postgres uses 5432; SQLite is file-based so the field is
 * meaningless — we leave it at 0 and the user (or the schema) ignores
 * it. Picked at dialog construction; users can override.
 */
const defaultPortForDialect = (dialect: string): number => {
    switch (dialect) {
        case 'mysql':
        case 'mariadb':
            return 3306;
        case 'postgres':
            return 5432;
        default:
            return 0;
    }
};

/**
 * Form for adding a new live-DB connection to a project's
 * `connections[]` in dbeditor.json. The "Model database" select shows
 * only databases that don't already have a connection on this project
 * (those are the candidates — one-connection-per-database is enforced
 * server-side too). Cancel → resolves with `null`.
 *
 * The password field supports `${VAR}` and `${VAR:-default}` env
 * placeholder syntax verbatim — the server's `resolveEnvPlaceholders`
 * substitutes them at boot. The dialog has no special handling beyond
 * persisting the literal string.
 */
/**
 * Hook the host wires into the dialogs so they can run the ad-hoc
 * connection test without each dialog needing its own DbApiClient
 * reference. Returns the same shape as `DbApiClient.testAdHocConnection`.
 */
export type AdHocConnectionTester = (input: {
    dialect: string;
    host: string;
    port?: number;
    user: string;
    password?: string;
    database: string;
    ssl?: boolean;
}) => Promise<{success: boolean;}>;

export class AddConnectionDialog extends BaseDialog<AddConnectionInput | null> {

    private readonly _availableDatabases: AddConnectionDatabaseChoice[];
    private readonly _dialect: string;
    private readonly _tester: AdHocConnectionTester | undefined;
    private readonly _databaseUnid: HTMLSelectElement | null;
    private readonly _host: HTMLInputElement;
    private readonly _port: HTMLInputElement;
    private readonly _user: HTMLInputElement;
    private readonly _password: HTMLInputElement;
    private readonly _database: HTMLInputElement;
    private readonly _ssl: HTMLInputElement;
    private readonly _readOnly: HTMLInputElement;

    public constructor(availableDatabases: AddConnectionDatabaseChoice[], dialect: string, tester?: AdHocConnectionTester) {
        super('Add live-DB connection');
        this._dialog.classList.add('add-connection-dialog');
        this._availableDatabases = availableDatabases;
        this._dialect = dialect;
        this._tester = tester;

        const intro = document.createElement('p');
        intro.className = 'project-settings-intro';
        intro.textContent = 'Persisted to dbeditor.json. The dev server restarts after Save so the new connection becomes live.';
        this._body.append(intro);

        if (availableDatabases.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'project-info-empty';
            empty.textContent = 'Every model database in this project already has a connection. Remove one first to free a database, then add the new one.';
            this._body.append(empty);
            this._databaseUnid = null;
            this._host = document.createElement('input');
            this._port = document.createElement('input');
            this._user = document.createElement('input');
            this._password = document.createElement('input');
            this._database = document.createElement('input');
            this._ssl = document.createElement('input');
            this._readOnly = document.createElement('input');
            this.addButton('Close', 'grey', (): void => this.close(null));
            return;
        }

        this._databaseUnid = this.addSelect(
            'Model database',
            availableDatabases.map(d => ({value: d.unid, label: d.name})),
            availableDatabases[0].unid
        );

        this._host = this.addInput('Host', '${DB_HOST:-localhost}');
        const port = defaultPortForDialect(dialect);
        this._port = this.addInput('Port', port > 0 ? String(port) : '');
        this._port.inputMode = 'numeric';
        this._user = this.addInput('User', '${DB_USER}');
        this._password = this.addInput('Password', '${DB_PASSWORD}');
        this._password.type = 'text';
        this._password.autocomplete = 'off';
        this._password.title = 'Supports ${VAR} and ${VAR:-default} env-placeholder syntax — keep secrets in .env, not inline.';
        this._database = this.addInput('Database (schema name)', '');
        this._ssl = this.addCheckbox('Use SSL', false);
        this._readOnly = this.addCheckbox('Read-only (hides Apply in Sync dialog)', false);

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        if (this._tester) {
            const status = document.createElement('span');
            status.className = 'connection-test-status';
            this._footer.append(status);
            this.addButton('Test', 'grey', (): void => {
                this._runTest(status).catch((err: unknown): void => console.error('[AddConnectionDialog] test failed:', err));
            });
        }
        this.addButton('Save', 'primary', (): void => this._submit());
    }

    /**
     * Build a test-input from the current form values and call the
     * supplied tester. Reflects "Testing…" / "✓ OK" / "✗ Fail" on the
     * status span, with the error message as a tooltip. Stays put
     * until the next click — `runTest` resets it.
     */
    private async _runTest(status: HTMLElement): Promise<void> {
        const tester = this._tester;
        if (!tester) {return;}
        const host = this._host.value.trim();
        const user = this._user.value.trim();
        const database = this._database.value.trim();
        if (host === '' || user === '' || database === '') {
            status.className = 'connection-test-status connection-test-status--fail';
            status.textContent = 'Fill required fields first';
            status.title = '';
            return;
        }
        const portRaw = this._port.value.trim();
        let port: number | undefined;
        if (portRaw !== '') {
            const n = Number(portRaw);
            if (!Number.isFinite(n)) {
                status.className = 'connection-test-status connection-test-status--fail';
                status.textContent = 'Port is not a number';
                status.title = '';
                return;
            }
            port = n;
        }
        const input: Parameters<AdHocConnectionTester>[0] = {
            dialect: this._dialect,
            host: host,
            user: user,
            database: database
        };
        if (port !== undefined) {input.port = port;}
        if (this._password.value !== '') {input.password = this._password.value;}
        if (this._ssl.checked) {input.ssl = true;}

        status.className = 'connection-test-status connection-test-status--pending';
        status.textContent = 'Testing…';
        status.title = '';
        try {
            await tester(input);
            status.className = 'connection-test-status connection-test-status--ok';
            status.replaceChildren(iconCheck(), document.createTextNode(' OK'));
            status.title = '';
        } catch (err) {
            status.className = 'connection-test-status connection-test-status--fail';
            status.replaceChildren(iconCross(), document.createTextNode(' Fail'));
            status.title = String((err as Error).message ?? err);
        }
    }

    private _submit(): void {
        if (!this._databaseUnid) {
            this.close(null);
            return;
        }
        const databaseUnid = this._databaseUnid.value.trim();
        const host = this._host.value.trim();
        if (host === '') { this._host.focus(); return; }
        const user = this._user.value.trim();
        if (user === '') { this._user.focus(); return; }
        const database = this._database.value.trim();
        if (database === '') { this._database.focus(); return; }
        const password = this._password.value;
        let port: number | undefined;
        const portRaw = this._port.value.trim();
        if (portRaw !== '') {
            const n = Number(portRaw);
            if (!Number.isFinite(n)) {
                this._port.focus();
                return;
            }
            port = n;
        }
        const result: AddConnectionInput = {
            databaseUnid: databaseUnid,
            host: host,
            user: user,
            database: database
        };
        if (port !== undefined) {result.port = port;}
        if (password !== '') {result.password = password;}
        if (this._ssl.checked) {result.ssl = true;}
        if (this._readOnly.checked) {result.readOnly = true;}
        this.close(result);
    }

}