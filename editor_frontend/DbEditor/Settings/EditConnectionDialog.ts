/*
 * Literal ${VAR} placeholders shown in input hints are *user-facing
 * examples* of the env-placeholder syntax that dbeditor.json
 * supports — disable the lint check that flags them as suspicious.
 */
/* eslint-disable no-template-curly-in-string */
import {BaseDialog} from '../Base/BaseDialog.js';
import {UpdateConnectionInput} from '../Api/DbApiClient.js';
import {AdHocConnectionTester} from './AddConnectionDialog.js';
import {Icons} from '../Util/Icons.js';

/**
 * Patch-test hook: ping the saved connection on disk with `patch`
 * overrides for this call only. Used by EditConnectionDialog when
 * the password field is blank and `passwordSet` is true so the user
 * can verify other-field changes without re-typing the stored
 * password (which the server never sends back to the client).
 */
export type PatchConnectionTester = (
    databaseUnid: string,
    patch: Partial<{host: string; port: number; user: string; password: string; database: string; ssl: boolean;}>
) => Promise<{success: boolean;}>;

/**
 * Subset of fields the dialog needs to pre-fill. Mirrors
 * `ProjectInfo.connections[i]` minus the runtime extras the dialog
 * doesn't care about. Note: the actual password is NOT in this
 * structure — `getProjectInfo` never sends it; `passwordSet` is the
 * only readable bit.
 */
export type ConnectionForEdit = {
    databaseUnid: string;
    databaseName: string | null;
    host: string;
    port: number;
    user: string;
    database: string;
    ssl: boolean;
    readOnly: boolean;
    passwordSet: boolean;
};

/**
 * Edit form for an existing connection. Pre-fills every visible field
 * from the supplied snapshot; the password input is empty by design
 * because the server never sends the live password (only `passwordSet`).
 *
 * Submit returns a minimal patch — only fields the user actually
 * changed. Three password states:
 *   - left blank        → key omitted (no change)
 *   - explicitly cleared via the "Clear password" checkbox → `''`
 *     (server treats this as "wipe the password")
 *   - new value typed   → string is sent verbatim
 *
 * The model database the connection is attached to is read-only — to
 * change it the user has to remove + re-add.
 */
export class EditConnectionDialog extends BaseDialog<UpdateConnectionInput | null> {

    private readonly _initial: ConnectionForEdit;
    private readonly _dialect: string;
    private readonly _tester: AdHocConnectionTester | undefined;
    private readonly _patchTester: PatchConnectionTester | undefined;
    private readonly _host: HTMLInputElement;
    private readonly _port: HTMLInputElement;
    private readonly _user: HTMLInputElement;
    private readonly _password: HTMLInputElement;
    private readonly _clearPassword: HTMLInputElement;
    private readonly _database: HTMLInputElement;
    private readonly _ssl: HTMLInputElement;
    private readonly _readOnly: HTMLInputElement;

    public constructor(initial: ConnectionForEdit, dialect: string, tester?: AdHocConnectionTester, patchTester?: PatchConnectionTester) {
        super(`Edit connection · ${initial.databaseName ?? initial.databaseUnid}`);
        this._dialog.classList.add('edit-connection-dialog');
        this._initial = initial;
        this._dialect = dialect;
        this._tester = tester;
        this._patchTester = patchTester;

        const intro = document.createElement('p');
        intro.className = 'project-settings-intro';
        intro.textContent = 'Patches dbeditor.json in place. The dev server restarts after Save so the changes become live.';
        this._body.append(intro);

        /*
         * Model-database is shown as a read-only label, not an input.
         * Mirroring `ProjectInfoDialog`'s per-row layout: bold name on
         * top, raw uuid muted below. The user can't change this here —
         * changing the binding is a delete+add operation.
         */
        const dbRow = document.createElement('div');
        dbRow.className = 'dialog-row';
        const dbLabel = document.createElement('label');
        dbLabel.textContent = 'Model database';
        const dbReadonly = document.createElement('div');
        dbReadonly.className = 'edit-connection-readonly';
        const dbName = document.createElement('div');
        dbName.className = initial.databaseName === null ? 'project-info-db-missing' : 'project-info-db-name';
        dbName.textContent = initial.databaseName ?? '— missing —';
        const dbUnid = document.createElement('div');
        dbUnid.className = 'project-info-db-unid';
        dbUnid.textContent = initial.databaseUnid;
        dbReadonly.append(dbName, dbUnid);
        dbRow.append(dbLabel, dbReadonly);
        this._body.append(dbRow);

        this._host = this.addInput('Host', initial.host);
        this._port = this.addInput('Port', String(initial.port));
        this._port.inputMode = 'numeric';
        this._user = this.addInput('User', initial.user);
        this._password = this.addInput('Password', '');
        this._password.type = 'text';
        this._password.autocomplete = 'off';
        this._password.placeholder = initial.passwordSet ? 'Leave blank to keep current password' : 'No password currently set';
        this._password.title = 'Supports ${VAR} and ${VAR:-default} env-placeholder syntax — keep secrets in .env, not inline.';
        this._clearPassword = this.addCheckbox('Clear stored password on save', false);
        if (!initial.passwordSet) {this._clearPassword.parentElement!.style.display = 'none';}
        this._database = this.addInput('Database (schema name)', initial.database);
        this._ssl = this.addCheckbox('Use SSL', initial.ssl);
        this._readOnly = this.addCheckbox('Read-only (hides Apply in Sync dialog)', initial.readOnly);

        this.addButton('Cancel', 'grey', (): void => this.close(null));
        if (this._tester) {
            const status = document.createElement('span');
            status.className = 'connection-test-status';
            this._footer.append(status);
            this.addButton('Test', 'grey', (): void => {
                this._runTest(status).catch((err: unknown): void => console.error('[EditConnectionDialog] test failed:', err));
            });
        }
        this.addButton('Save', 'primary', (): void => this._submit());
    }

    /**
     * Test the current form values against the live DB without
     * persisting. Mirrors AddConnectionDialog's behaviour. Important
     * tri-state nuance: the password field starts blank in edit mode
     * (server never sends the live password), so testing with an
     * empty password tests against an empty password — not the
     * stored one. We surface this when the user has `passwordSet`
     * but hasn't typed anything: the status flips to a hint, not a
     * connection attempt.
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

        /*
         * Two paths:
         *
         * 1. Password blank + stored password exists + clear-password
         *    not requested → patch-test the saved connection. We send
         *    just the user-edited fields as a patch and the server
         *    fills the rest (including the never-leaked password)
         *    from the on-disk record.
         *
         * 2. Otherwise → ad-hoc test with the form values verbatim.
         *    This covers add-mode-style behaviour: user typed a new
         *    password (or explicitly cleared it).
         */
        const passwordBlank = this._password.value === '';
        const usePatchPath = this._patchTester !== undefined
            && this._initial.passwordSet
            && passwordBlank
            && !this._clearPassword.checked;

        status.className = 'connection-test-status connection-test-status--pending';
        status.textContent = 'Testing…';
        status.title = '';
        try {
            if (usePatchPath && this._patchTester) {
                const patch: Parameters<PatchConnectionTester>[1] = {};
                if (host !== this._initial.host) {patch.host = host;}
                if (port !== undefined && port !== this._initial.port) {patch.port = port;}
                if (user !== this._initial.user) {patch.user = user;}
                if (database !== this._initial.database) {patch.database = database;}
                if (this._ssl.checked !== this._initial.ssl) {patch.ssl = this._ssl.checked;}
                await this._patchTester(this._initial.databaseUnid, patch);
            } else {
                const input: Parameters<AdHocConnectionTester>[0] = {
                    dialect: this._dialect,
                    host: host,
                    user: user,
                    database: database
                };
                if (port !== undefined) {input.port = port;}
                if (this._password.value !== '') {input.password = this._password.value;}
                if (this._ssl.checked) {input.ssl = true;}
                await tester(input);
            }
            status.className = 'connection-test-status connection-test-status--ok';
            status.replaceChildren(Icons.check(), document.createTextNode(' OK'));
            status.title = usePatchPath ? 'Tested with stored password.' : '';
        } catch (err) {
            status.className = 'connection-test-status connection-test-status--fail';
            status.replaceChildren(Icons.cross(), document.createTextNode(' Fail'));
            status.title = String((err as Error).message ?? err);
        }
    }

    private _submit(): void {
        const patch: UpdateConnectionInput = {};

        const host = this._host.value.trim();
        if (host === '') { this._host.focus(); return; }
        if (host !== this._initial.host) {patch.host = host;}

        const user = this._user.value.trim();
        if (user === '') { this._user.focus(); return; }
        if (user !== this._initial.user) {patch.user = user;}

        const database = this._database.value.trim();
        if (database === '') { this._database.focus(); return; }
        if (database !== this._initial.database) {patch.database = database;}

        const portRaw = this._port.value.trim();
        if (portRaw !== '') {
            const n = Number(portRaw);
            if (!Number.isFinite(n)) { this._port.focus(); return; }
            if (n !== this._initial.port) {patch.port = n;}
        }

        /*
         * Password tri-state: clear-checkbox wins; otherwise empty
         * input is "no change" (omit), non-empty is "replace".
         */
        const passwordTyped = this._password.value;
        if (this._clearPassword.checked) {
            patch.password = '';
        } else if (passwordTyped !== '') {
            patch.password = passwordTyped;
        }

        if (this._ssl.checked !== this._initial.ssl) {patch.ssl = this._ssl.checked;}
        if (this._readOnly.checked !== this._initial.readOnly) {patch.readOnly = this._readOnly.checked;}

        this.close(patch);
    }

}