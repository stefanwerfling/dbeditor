import {BaseDialog} from '../Base/BaseDialog.js';
import {OutputSettings, ProjectInfo} from '../Api/DbApiClient.js';
import {iconCheck, iconCross} from '../Util/Icons.js';

export type ProjectInfoActions = {
    testConnection: (databaseUnid: string) => Promise<{success: boolean;}>;
    /**
     * Optional — when provided, a "Reload config" button appears at
     * the bottom of the dialog. Triggers a server restart so edits to
     * `dbeditor.json` take effect (browser will full-page-reload via
     * Vite's HMR client). Omit if the host can't restart its own
     * server.
     */
    restartServer?: () => Promise<{success: boolean;}>;
    confirmReload?: (message: string) => Promise<boolean>;
    /**
     * Optional — when both provided, an "Add connection…" button
     * appears below the connections table and each row gets a
     * "Remove" affordance. Both operations write to dbeditor.json +
     * trigger a restart on the server side; the dialog is irrelevant
     * after that point (browser full-page-reloads).
     */
    addConnection?: () => Promise<void>;
    removeConnection?: (databaseUnid: string) => Promise<void>;
    /**
     * Optional — when provided, each connection row gets an "Edit"
     * affordance. The host opens its own edit dialog with the
     * supplied connection snapshot.
     */
    editConnection?: (databaseUnid: string) => Promise<void>;
    /**
     * Optional — when provided, each connection row gets a "Rebind…"
     * affordance that points the existing connection at a different
     * model database while preserving all credential fields. Solves
     * the stale-databaseUnid problem after schema regeneration.
     */
    rebindConnection?: (databaseUnid: string) => Promise<void>;
    /**
     * Optional confirm hook for destructive removals. Matches the
     * `confirmReload` shape so the host can route both through the
     * same `ConfirmDialog`. When omitted we fall back to `window.confirm`.
     */
    confirmRemoveConnection?: (databaseName: string | null, databaseUnid: string) => Promise<boolean>;
    /**
     * Optional — when provided, the Output section becomes editable
     * inline (with a Save button) instead of read-only. Callback
     * receives only the changed fields. This is what makes this
     * dialog the merged Project info + settings entry point.
     */
    saveOutputSettings?: (patch: Partial<OutputSettings>) => Promise<void>;
};

/**
 * Read-only viewer for everything the server resolved from `dbeditor.json`
 * + env vars + the schema file's override layers. Renders connection
 * passwords as `••••` when set — never displays the actual value. Use
 * this when you want to verify "is my config actually live?" without
 * opening `dbeditor.json` and mentally substituting `${VAR}` placeholders.
 *
 * Almost entirely read-only — the one interactive affordance is a per-
 * connection "Test" button that pings the live DB via the existing
 * connection-test route, since the only other path to that was the
 * SyncDialog (an unrelated context).
 */
export class ProjectInfoDialog extends BaseDialog<void> {

    private readonly _actions: ProjectInfoActions;

    public constructor(info: ProjectInfo, actions: ProjectInfoActions) {
        super(`Project info · ${info.name}`);
        this._dialog.classList.add('project-info-dialog');
        this._actions = actions;

        this._body.append(
            ProjectInfoDialog._section('Project', [
                ['Name', info.name],
                ['Dialect', info.dialect],
                ['Schema path', info.schemaPath],
                ['Auto-generate', info.autoGenerate ? 'yes' : 'no']
            ]),
            this._actions.saveOutputSettings
                ? this._renderOutputSettingsSection(info.output)
                : ProjectInfoDialog._section('Output (effective)', [
                    ['Mode', info.output.mode],
                    ['Destination path', info.output.destinationPath],
                    ['Clear destination before generate', info.output.destinationClear ? 'yes' : 'no'],
                    ['SQL comments', info.output.sqlComment ? 'yes' : 'no'],
                    ['SQL indent', JSON.stringify(info.output.sqlIndent)],
                    ['Statement terminator', JSON.stringify(info.output.statementTerminator)],
                    ['Migration filename', info.output.migrationFilenamePattern]
                ]),
            ProjectInfoDialog._section('Sync (effective)', [
                ['Ignored tables', info.sync.ignoreTables.length ? info.sync.ignoreTables.join(', ') : '—'],
                ['Ignored column attributes', info.sync.ignoreColumnAttributes.length ? info.sync.ignoreColumnAttributes.join(', ') : '—']
            ]),
            this._renderConnectionsSection(info.connections),
            this._renderScriptsSection('Scripts before generate', info.scriptsBeforeGenerate),
            this._renderScriptsSection('Scripts after generate', info.scriptsAfterGenerate)
        );

        if (this._actions.restartServer && this._actions.confirmReload) {
            this.addButton('Reload config', 'primary', (): void => this._reloadConfig());
        }
        this.addButton('Close', 'grey', (): void => this.close());
    }

    /**
     * Re-reads dbeditor.json on the server and restarts the dev
     * server. The Vite client in the browser will full-page-reload
     * once the new server comes up — any unsaved canvas state is
     * lost. Hence the explicit confirm.
     */
    private _reloadConfig(): void {
        const restart = this._actions.restartServer;
        const confirm = this._actions.confirmReload;
        if (!restart || !confirm) {return;}
        confirm(
            'Reload dbeditor.json and restart the dev server?\n\n'
            + 'The page will refresh and any in-flight unsaved canvas state will be lost. '
            + 'This is the way to pick up edits to connections, projects, env vars, etc.'
        ).then(async ok => {
            if (!ok) {return;}
            try {
                await restart();
                /*
                 * Server is shutting down — Vite's client will
                 * full-page-reload as soon as the new instance is
                 * ready. No need to do anything else here.
                 */
            } catch (err) {
                alert(`Reload failed: ${(err as Error).message}\n\ndbeditor.json may have a syntax or validation error — fix it and try again.`);
            }
        }).catch((err: unknown): void => console.error('[ProjectInfoDialog] reload failed:', err));
    }

    /*
     * Editable Output section — same fields the old standalone
     * ProjectSettingsDialog carried, embedded inside the unified
     * Project dialog. Save button diffs the current input values
     * against the initial snapshot and pushes only changed fields
     * via the action callback. A small status line appears next to
     * Save while a write is in flight or after success/failure.
     */
    private _renderOutputSettingsSection(initial: OutputSettings): HTMLDivElement {
        const wrap = document.createElement('div');
        wrap.className = 'project-info-section';
        const h = document.createElement('h4');
        h.className = 'project-info-section-title';
        h.textContent = 'Output settings';
        wrap.append(h);

        const form = document.createElement('div');
        form.className = 'project-info-output-form';

        const modeSel = ProjectInfoDialog._formRow(form, 'Output mode', () => {
            const s = document.createElement('select');
            for (const o of [
                {value: 'ddl-files', label: 'ddl-files — one .sql per table'},
                {value: 'migrations', label: 'migrations — timestamped up/down pairs'}
            ]) {
                const opt = document.createElement('option');
                opt.value = o.value; opt.textContent = o.label;
                s.append(opt);
            }
            s.value = initial.mode;
            return s;
        });
        const destPath = ProjectInfoDialog._formInputRow(form, 'Destination path', initial.destinationPath);
        const destClear = ProjectInfoDialog._formCheckboxRow(form, 'Clear destination directory before generating', initial.destinationClear);
        const sqlComment = ProjectInfoDialog._formCheckboxRow(form, 'Emit -- comments in generated SQL', initial.sqlComment);
        const sqlIndent = ProjectInfoDialog._formInputRow(form, 'SQL indent', initial.sqlIndent);
        ProjectInfoDialog._attachWhitespaceHint(sqlIndent);
        const stTerminator = ProjectInfoDialog._formInputRow(form, 'Statement terminator', initial.statementTerminator);
        const migFilename = ProjectInfoDialog._formInputRow(form, 'Migration filename pattern', initial.migrationFilenamePattern);
        ProjectInfoDialog._attachStaticHint(
            migFilename,
            'Placeholders: {timestamp} = sortable ISO-like stamp, {name} = user-supplied migration name. Both are required for unique filenames.'
        );

        const footer = document.createElement('div');
        footer.className = 'project-info-output-footer';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'btn-grey btn-primary';
        saveBtn.textContent = 'Save output settings';
        const status = document.createElement('span');
        status.className = 'project-info-output-status';
        saveBtn.addEventListener('click', async(): Promise<void> => {
            const patch: Partial<OutputSettings> = {};
            if (modeSel.value !== initial.mode) {patch.mode = modeSel.value;}
            if (destPath.value !== initial.destinationPath) {patch.destinationPath = destPath.value;}
            if (destClear.checked !== initial.destinationClear) {patch.destinationClear = destClear.checked;}
            if (sqlComment.checked !== initial.sqlComment) {patch.sqlComment = sqlComment.checked;}
            if (sqlIndent.value !== initial.sqlIndent) {patch.sqlIndent = sqlIndent.value;}
            if (stTerminator.value !== initial.statementTerminator) {patch.statementTerminator = stTerminator.value;}
            if (migFilename.value !== initial.migrationFilenamePattern) {patch.migrationFilenamePattern = migFilename.value;}
            if (Object.keys(patch).length === 0) {status.textContent = 'No changes.'; return;}
            saveBtn.disabled = true;
            status.textContent = 'Saving…';
            try {
                await this._actions.saveOutputSettings!(patch);
                status.textContent = 'Saved.';
            } catch (err) {
                status.textContent = `Failed: ${(err as Error).message ?? err}`;
            } finally {
                saveBtn.disabled = false;
            }
        });
        footer.append(saveBtn, status);

        wrap.append(form, footer);
        return wrap;
    }

    private static _formRow<T extends HTMLElement>(parent: HTMLElement, label: string, build: () => T): T {
        const row = document.createElement('div');
        row.className = 'dialog-row';
        const lbl = document.createElement('label');
        lbl.textContent = label;
        row.append(lbl);
        const el = build();
        row.append(el);
        parent.append(row);
        return el;
    }

    private static _formInputRow(parent: HTMLElement, label: string, value: string): HTMLInputElement {
        return ProjectInfoDialog._formRow(parent, label, () => {
            const input = document.createElement('input');
            input.value = value;
            return input;
        });
    }

    private static _formCheckboxRow(parent: HTMLElement, label: string, value: boolean): HTMLInputElement {
        const row = document.createElement('div');
        row.className = 'dialog-row dialog-row-checkbox';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = value;
        const lbl = document.createElement('label');
        lbl.textContent = label;
        lbl.style.cursor = 'pointer';
        lbl.addEventListener('click', () => { cb.checked = !cb.checked; });
        row.append(cb, lbl);
        parent.append(row);
        return cb;
    }

    /*
     * SQL-indent is empty-vs-whitespace ambiguous in a plain input —
     * surface a per-keystroke summary so the user sees what's stored.
     */
    private static _attachWhitespaceHint(input: HTMLInputElement): void {
        const hint = document.createElement('div');
        hint.className = 'dialog-input-hint';
        const describe = (v: string): string => {
            if (v === '') {return '(empty — flat single-line SQL)';}
            const spaces = v.split('').filter(c => c === ' ').length;
            const tabs = v.split('').filter(c => c === '\t').length;
            const other = v.length - spaces - tabs;
            const parts: string[] = [];
            if (spaces > 0) {parts.push(`${spaces} space${spaces === 1 ? '' : 's'}`);}
            if (tabs > 0)   {parts.push(`${tabs} tab${tabs === 1 ? '' : 's'}`);}
            if (other > 0)  {parts.push(`${other} other char${other === 1 ? '' : 's'} (unusual!)`);}
            return `(${parts.join(' + ')})`;
        };
        hint.textContent = describe(input.value);
        input.parentElement?.append(hint);
        input.addEventListener('input', () => {
            hint.textContent = describe(input.value);
        });
    }

    private static _attachStaticHint(input: HTMLInputElement, text: string): void {
        const hint = document.createElement('div');
        hint.className = 'dialog-input-hint';
        hint.textContent = text;
        input.parentElement?.append(hint);
    }

    private static _section(title: string, rows: [string, string][]): HTMLDivElement {
        const wrap = document.createElement('div');
        wrap.className = 'project-info-section';
        const h = document.createElement('h4');
        h.className = 'project-info-section-title';
        h.textContent = title;
        wrap.append(h);
        const dl = document.createElement('dl');
        dl.className = 'project-info-dl';
        for (const [label, value] of rows) {
            const dt = document.createElement('dt');
            dt.textContent = label;
            const dd = document.createElement('dd');
            dd.textContent = value;
            dl.append(dt, dd);
        }
        wrap.append(dl);
        return wrap;
    }

    private _renderConnectionsSection(connections: ProjectInfo['connections']): HTMLDivElement {
        const wrap = document.createElement('div');
        wrap.className = 'project-info-section';
        const header = document.createElement('div');
        header.className = 'project-info-section-header';
        const h = document.createElement('h4');
        h.className = 'project-info-section-title';
        h.textContent = 'Live-DB connections';
        header.append(h);
        if (this._actions.addConnection) {
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'btn-grey btn-primary project-info-add-btn';
            addBtn.textContent = '+ Add connection…';
            addBtn.addEventListener('click', () => {
                this._actions.addConnection?.()
                .catch((err: unknown): void => console.error('[ProjectInfoDialog] add connection failed:', err));
            });
            header.append(addBtn);
        }
        wrap.append(header);
        if (connections.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'project-info-empty';
            empty.textContent = '— none configured —';
            wrap.append(empty);
            return wrap;
        }
        const table = document.createElement('table');
        table.className = 'project-info-table';
        const head = document.createElement('tr');
        const cols = ['Model database', 'Host', 'Port', 'User', 'DB', 'Password', 'SSL', 'Read-only', ''];
        if (this._actions.editConnection) {cols.push('');}
        if (this._actions.rebindConnection) {cols.push('');}
        if (this._actions.removeConnection) {cols.push('');}
        for (const col of cols) {
            const th = document.createElement('th');
            th.textContent = col;
            head.append(th);
        }
        table.append(head);
        for (const c of connections) {
            const tr = document.createElement('tr');

            /*
             * Model-database cell: human-readable name (or a "— missing —"
             * badge if the unid in dbeditor.json doesn't resolve any
             * longer), with the raw UUID as a small muted sub-line and as
             * the title-tooltip for copy/paste.
             */
            const dbCell = document.createElement('td');
            dbCell.className = 'project-info-db-cell';
            const dbName = document.createElement('div');
            dbName.className = c.databaseName === null ? 'project-info-db-missing' : 'project-info-db-name';
            dbName.textContent = c.databaseName ?? '— missing —';
            const dbUnid = document.createElement('div');
            dbUnid.className = 'project-info-db-unid';
            dbUnid.textContent = c.databaseUnid;
            dbUnid.title = c.databaseUnid;
            dbCell.append(dbName, dbUnid);
            tr.append(dbCell);

            for (const v of [
                c.host,
                String(c.port),
                c.user,
                c.database,
                c.passwordSet ? '••••' : '—',
                c.ssl ? 'on' : 'off',
                c.readOnly ? 'yes' : 'no'
            ]) {
                const td = document.createElement('td');
                td.textContent = v;
                tr.append(td);
            }

            /*
             * Test-button cell. Status text replaces the button in-place
             * while the request is in flight; a follow-up click resets
             * the state to button. Disabled when the model database is
             * missing — testing would fail anyway since the unid
             * mismatch would surface as "no live connection for X".
             */
            const testCell = document.createElement('td');
            testCell.className = 'project-info-test-cell';
            this._buildTestControl(testCell, c.databaseUnid, c.databaseName !== null);
            tr.append(testCell);

            if (this._actions.editConnection) {
                const editCell = document.createElement('td');
                editCell.className = 'project-info-edit-cell';
                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'btn-grey project-info-edit-btn';
                editBtn.textContent = 'Edit';
                editBtn.addEventListener('click', () => {
                    this._actions.editConnection?.(c.databaseUnid)
                    .catch((err: unknown): void => console.error('[ProjectInfoDialog] edit connection failed:', err));
                });
                editCell.append(editBtn);
                tr.append(editCell);
            }

            if (this._actions.rebindConnection) {
                const rebindCell = document.createElement('td');
                rebindCell.className = 'project-info-rebind-cell';
                const rebindBtn = document.createElement('button');
                rebindBtn.type = 'button';
                rebindBtn.className = 'btn-grey project-info-rebind-btn';
                rebindBtn.textContent = 'Rebind…';
                rebindBtn.title = 'Point this connection at a different model database';
                rebindBtn.addEventListener('click', () => {
                    this._actions.rebindConnection?.(c.databaseUnid)
                    .catch((err: unknown): void => console.error('[ProjectInfoDialog] rebind connection failed:', err));
                });
                rebindCell.append(rebindBtn);
                tr.append(rebindCell);
            }

            if (this._actions.removeConnection) {
                const removeCell = document.createElement('td');
                removeCell.className = 'project-info-remove-cell';
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'btn-grey btn-danger project-info-remove-btn';
                removeBtn.textContent = 'Remove';
                removeBtn.addEventListener('click', () => {
                    this._confirmAndRemove(c.databaseName, c.databaseUnid)
                    .catch((err: unknown): void => console.error('[ProjectInfoDialog] remove connection failed:', err));
                });
                removeCell.append(removeBtn);
                tr.append(removeCell);
            }

            table.append(tr);
        }
        wrap.append(table);
        return wrap;
    }

    /**
     * Confirm the destructive remove, then delegate to the host-side
     * remove hook. The host writes to `dbeditor.json` and triggers a
     * server restart; the browser full-page-reloads so we don't need
     * to mutate the dialog state in place.
     */
    private async _confirmAndRemove(databaseName: string | null, databaseUnid: string): Promise<void> {
        const remove = this._actions.removeConnection;
        if (!remove) {return;}
        const confirmHook = this._actions.confirmRemoveConnection;
        const label = databaseName ?? databaseUnid;
        const ok = confirmHook
            ? await confirmHook(databaseName, databaseUnid)
            : window.confirm(`Remove the connection for "${label}"?\n\nThe dev server will restart and any in-flight unsaved canvas state will be lost.`);
        if (!ok) {return;}
        try {
            await remove(databaseUnid);
        } catch (err) {
            alert(`Remove failed: ${(err as Error).message ?? err}`);
        }
    }

    private _buildTestControl(cell: HTMLElement, databaseUnid: string, enabled: boolean): void {
        cell.innerHTML = '';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'project-info-test-btn';
        btn.textContent = 'Test';
        btn.disabled = !enabled;
        btn.addEventListener('click', async(): Promise<void> => {
            btn.disabled = true;
            btn.textContent = 'Testing…';
            try {
                await this._actions.testConnection(databaseUnid);
                cell.innerHTML = '';
                const ok = document.createElement('span');
                ok.className = 'project-info-test-ok';
                ok.append(iconCheck(), document.createTextNode(' OK'));
                ok.title = 'Click to test again';
                ok.addEventListener('click', () => this._buildTestControl(cell, databaseUnid, true));
                cell.append(ok);
            } catch (err) {
                cell.innerHTML = '';
                const fail = document.createElement('span');
                fail.className = 'project-info-test-fail';
                fail.append(iconCross(), document.createTextNode(' Fail'));
                fail.title = String((err as {message?: string;}).message ?? err);
                fail.addEventListener('click', () => this._buildTestControl(cell, databaseUnid, enabled));
                cell.append(fail);
            }
        });
        cell.append(btn);
    }

    private _renderScriptsSection(title: string, scripts: {path: string; script: string;}[]): HTMLDivElement {
        const wrap = document.createElement('div');
        wrap.className = 'project-info-section';
        const h = document.createElement('h4');
        h.className = 'project-info-section-title';
        h.textContent = title;
        wrap.append(h);
        if (scripts.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'project-info-empty';
            empty.textContent = '— none configured —';
            wrap.append(empty);
            return wrap;
        }
        const ul = document.createElement('ul');
        ul.className = 'project-info-list';
        for (const s of scripts) {
            const li = document.createElement('li');
            li.textContent = `${s.path} · ${s.script}`;
            ul.append(li);
        }
        wrap.append(ul);
        return wrap;
    }

}