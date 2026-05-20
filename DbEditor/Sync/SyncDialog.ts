import {BaseDialog} from '../Base/BaseDialog.js';
import {ConfirmDialog} from '../Base/ConfirmDialog.js';
import {DbApiClient, RenameHints} from '../Api/DbApiClient.js';
import {SyncSettingsDialog} from './SyncSettingsDialog.js';
import {SyncHistoryDialog} from './SyncHistoryDialog.js';
import {ContextMenu, ContextMenuItem} from '../Base/ContextMenu.js';
import {Icons} from '../Util/Icons.js';

/*
 * Local mirror of SchemaChangeKind values from DbDiff/ChangeTypes.ts.
 * Duplicated rather than imported because the SyncDialog is in the
 * client bundle and the change types live in the backend tree —
 * stringly-typed matches are fine, the enum is just for readability.
 */
const CHANGE_KIND = {
    tableAdded: 'tableAdded',
    tableDropped: 'tableDropped',
    tableRenamed: 'tableRenamed',
    columnAdded: 'columnAdded',
    columnDropped: 'columnDropped',
    columnRenamed: 'columnRenamed',
    indexAdded: 'indexAdded',
    indexDropped: 'indexDropped',
    fkAdded: 'fkAdded',
    fkDropped: 'fkDropped',
    viewAdded: 'viewAdded',
    viewDropped: 'viewDropped'
} as const;

type JsonColumnLike = {
    name?: string;
    type?: string;
    length?: string;
    notNull?: boolean;
    primaryKey?: boolean;
    autoIncrement?: boolean;
    unique?: boolean;
    unsigned?: boolean;
    defaultValue?: string;
    comment?: string;
};

type JsonTableLike = {
    name?: string;
    columns?: JsonColumnLike[];
    indexes?: {name?: string;}[];
    foreignKeys?: {name?: string;}[];
    options?: {engine?: string; charset?: string; collation?: string; comment?: string;};
};

type Change = {
    id: string;
    kind: string;
    severity: 'safe' | 'warn' | 'destructive';
    tableName?: string;
    columnName?: string;
    indexName?: string;
    fkName?: string;
    viewName?: string;
    sql: string[];
};

type Statement = {
    changeId: string;
    kind: string;
    sql: string;
    bucket: number;
};

type ChangeSet = {
    databaseUnid: string;
    databaseName: string;
    changes: Change[];
};

type StatementResult = {
    changeId: string;
    sql: string;
    ok: boolean;
    error?: string;
    durationMs: number;
};

/**
 * Modal that runs `sync/preview` against the live DB and surfaces the diff
 * as a checkbox list, with the SQL for currently-selected changes rendered
 * in a side pane. Apply executes the selected changes against the live DB
 * (with optional dry-run) and writes a forward/reverse migration pair to
 * `output.destinationPath`.
 */
export class SyncDialog extends BaseDialog<void> {

    private readonly _api: DbApiClient;
    private readonly _projectUnid: string;
    private readonly _databaseUnid: string;
    private readonly _layerUnid: string | undefined;

    private _changes: Change[] = [];
    private _statements: Statement[] = [];
    private _selected = new Set<string>();
    private _focusedChangeId: string | null = null;
    private _modelDefaults: {engine: string; charset: string; collation: string;} = {engine: '', charset: '', collation: ''};
    /*
     * User-paired rename hints — survive across reloads inside one
     * dialog session so the user doesn't lose their pairings when
     * refreshing. The server collapses matching drop+add pairs into
     * a single tableRenamed/columnRenamed change.
     */
    private _renames: RenameHints = {tables: [], columns: []};
    /* Set in _buildBody once the tab buttons exist; default is a no-op. */
    private _activateDiffTab: () => void = (): void => {
        /* no-op placeholder */
    };
    private _list!: HTMLDivElement;
    private _sqlPane!: HTMLPreElement;
    private _inspectorPane!: HTMLDivElement;
    private _logPane!: HTMLDivElement;
    private _criticalBanner!: HTMLDivElement;
    private _statusEl!: HTMLDivElement;
    private _ignoreSummaryEl!: HTMLDivElement;
    private _refreshBtn!: HTMLButtonElement;
    private _testBtn!: HTMLButtonElement;
    private _applyBtn!: HTMLButtonElement;
    private _reverseBtn!: HTMLButtonElement;
    private _testRunBtn!: HTMLButtonElement;
    private _dryRunCb!: HTMLInputElement;
    private _currentSync: {ignoreTables: string[]; ignoreColumnAttributes: string[];} = {
        ignoreTables: [],
        ignoreColumnAttributes: []
    };

    public constructor(api: DbApiClient, projectUnid: string, databaseUnid: string, databaseLabel: string, diagramUnid?: string, layerName?: string) {
        const titleSuffix = diagramUnid ? ` · diagram "${layerName ?? diagramUnid}"` : '';
        super(`Sync with database · ${databaseLabel}${titleSuffix}`);
        this._api = api;
        this._projectUnid = projectUnid;
        this._databaseUnid = databaseUnid;
        this._layerUnid = diagramUnid;
        this._dialog.classList.add('sync-dialog');
        this._buildBody();
        this._initialLoad().catch((err: unknown): void => console.error('[SyncDialog] initial load failed:', err));
    }

    private async _initialLoad(): Promise<void> {
        /*
         * Sync settings ride a separate endpoint — we load them once before
         * the first preview so the ignore-summary renders correctly without
         * a flash. The preview itself runs against `repo.effectiveSync()`
         * server-side, so even if this fetch fails the preview still works.
         */
        try {
            const res = await this._api.getSyncSettings(this._projectUnid);
            this._currentSync = res.sync;
        } catch (err) {
            console.error('[SyncDialog] sync-settings fetch failed:', err);
        }
        this._renderIgnoreSummary();
        await this._reload();
    }

    private _buildBody(): void {
        this._statusEl = document.createElement('div');
        this._statusEl.className = 'sync-dialog-status';
        this._statusEl.textContent = 'Loading…';
        this._body.append(this._statusEl);

        this._ignoreSummaryEl = document.createElement('div');
        this._ignoreSummaryEl.className = 'sync-dialog-ignore-summary';
        this._ignoreSummaryEl.textContent = '';
        this._body.append(this._ignoreSummaryEl);

        const split = document.createElement('div');
        split.className = 'sync-dialog-split';
        this._body.append(split);

        this._list = document.createElement('div');
        this._list.className = 'sync-dialog-list';
        split.append(this._list);

        const right = document.createElement('div');
        right.className = 'sync-dialog-pane';
        split.append(right);

        /*
         * Right-pane tabs: one of {SQL, Diff} fills the whole right
         * column at a time so each gets the full vertical space.
         * Default is SQL — that's what the user expects to see on
         * first preview. Switching to Diff focuses the inspector
         * for a clicked change row.
         */
        const tabs = document.createElement('div');
        tabs.className = 'sync-dialog-tabs';
        const tabSql = document.createElement('button');
        tabSql.type = 'button';
        tabSql.className = 'sync-dialog-tab sync-dialog-tab--active';
        tabSql.textContent = 'SQL';
        const tabDiff = document.createElement('button');
        tabDiff.type = 'button';
        tabDiff.className = 'sync-dialog-tab';
        tabDiff.textContent = 'Diff';
        tabs.append(tabSql, tabDiff);
        right.append(tabs);

        this._sqlPane = document.createElement('pre');
        this._sqlPane.className = 'sync-dialog-sql';
        this._sqlPane.textContent = '— select changes to preview SQL —';
        right.append(this._sqlPane);

        /*
         * Inspector pane: when the user clicks the TEXT of a change
         * row (not its checkbox), this pane renders a field-by-field
         * Live vs. Model comparison so the user can see WHY the diff
         * fired — useful for sniffing out cosmetic mismatches and
         * legitimate drift.
         */
        this._inspectorPane = document.createElement('div');
        this._inspectorPane.className = 'sync-dialog-inspector';
        this._inspectorPane.innerHTML = '<em>Click a change to inspect Live vs. Model side-by-side.</em>';
        this._inspectorPane.hidden = true;
        right.append(this._inspectorPane);

        const setTab = (which: 'sql' | 'diff'): void => {
            const isSql = which === 'sql';
            tabSql.classList.toggle('sync-dialog-tab--active', isSql);
            tabDiff.classList.toggle('sync-dialog-tab--active', !isSql);
            this._sqlPane.hidden = !isSql;
            this._inspectorPane.hidden = isSql;
        };
        tabSql.addEventListener('click', () => setTab('sql'));
        tabDiff.addEventListener('click', () => setTab('diff'));
        /* Clicking a row's text auto-switches to Diff; cache for use in _renderList. */
        this._activateDiffTab = (): void => setTab('diff');

        /*
         * Sticky critical banner — only rendered when the test-run's
         * restore step itself failed. Sits above the log and is the
         * only UI element that doesn't auto-clear on the next preview
         * (we don't want the user to lose the dump-path recovery
         * information by reflexively clicking Refresh).
         */
        this._criticalBanner = document.createElement('div');
        this._criticalBanner.className = 'sync-dialog-critical-banner';
        this._criticalBanner.hidden = true;
        right.append(this._criticalBanner);

        this._logPane = document.createElement('div');
        this._logPane.className = 'sync-dialog-log';
        this._logPane.hidden = true;
        right.append(this._logPane);

        this._dryRunCb = this.addCheckbox('Dry-run (wrap in BEGIN/ROLLBACK; no migration files written)', false);
        this._dryRunCb.classList.add('sync-dialog-dryrun');

        this._testBtn = this.addButton('Test connection', 'grey', (): void => {
            this._testConnection().catch((err: unknown): void => console.error('[SyncDialog] test failed:', err));
        });
        this.addButton('Ignore settings…', 'grey', (): void => {
            this._editIgnoreSettings().catch((err: unknown): void => console.error('[SyncDialog] settings failed:', err));
        });
        this._refreshBtn = this.addButton('Refresh', 'grey', (): void => {
            this._reload().catch((err: unknown): void => console.error('[SyncDialog] reload failed:', err));
        });
        this.addButton('Copy SQL', 'grey', (): void => this._copySql());
        this.addButton('History…', 'grey', (): void => {
            new SyncHistoryDialog(this._api, this._projectUnid).show()
            .catch((err: unknown): void => console.error('[SyncDialog] history failed:', err));
        });
        this._reverseBtn = this.addButton('Reverse apply…', 'grey', (): void => {
            this._reverseApply().catch((err: unknown): void => console.error('[SyncDialog] reverse-apply failed:', err));
        });
        this._testRunBtn = this.addButton('Test run…', 'grey', (): void => {
            this._testRun().catch((err: unknown): void => console.error('[SyncDialog] test-run failed:', err));
        });
        this._testRunBtn.title = 'Dump the live DB, run the selected statements for real, then restore. Use this to verify the changes work before generating migration code.';
        this._applyBtn = this.addButton('Apply…', 'primary', (): void => {
            this._apply().catch((err: unknown): void => console.error('[SyncDialog] apply failed:', err));
        });
        this.addButton('Close', 'grey', (): void => this.close());
    }

    private _renderIgnoreSummary(): void {
        const t = this._currentSync.ignoreTables.length;
        const a = this._currentSync.ignoreColumnAttributes.length;
        if (t === 0 && a === 0) {
            this._ignoreSummaryEl.textContent = 'No ignore patterns set.';
            return;
        }
        const parts: string[] = [];
        if (t > 0) {parts.push(`${t} table${t === 1 ? '' : 's'}: ${this._currentSync.ignoreTables.join(', ')}`);}
        if (a > 0) {parts.push(`${a} column attr${a === 1 ? '' : 's'}: ${this._currentSync.ignoreColumnAttributes.join(', ')}`);}
        this._ignoreSummaryEl.textContent = `Ignored — ${parts.join(' · ')}`;
    }

    private async _editIgnoreSettings(): Promise<void> {
        const next = await new SyncSettingsDialog({...this._currentSync}).show();
        if (!next) {return;}
        const sameTables = JSON.stringify(next.ignoreTables) === JSON.stringify(this._currentSync.ignoreTables);
        const sameAttrs = JSON.stringify(next.ignoreColumnAttributes) === JSON.stringify(this._currentSync.ignoreColumnAttributes);
        if (sameTables && sameAttrs) {return;}
        try {
            const res = await this._api.updateSyncSettings(this._projectUnid, next);
            this._currentSync = res.sync;
            this._renderIgnoreSummary();
            this._statusEl.textContent = 'Ignore patterns saved. Refreshing preview…';
            /*
             * Re-run preview since the patterns affect which changes the
             * diff surfaces. Don't await — let the in-flight load update
             * the status when it lands.
             */
            this._reload().catch((err: unknown): void => console.error('[SyncDialog] post-settings reload failed:', err));
        } catch (err) {
            this._statusEl.textContent = `Failed to save ignore settings: ${(err as Error).message}`;
        }
    }

    private async _testConnection(): Promise<void> {
        this._testBtn.disabled = true;
        const previous = this._statusEl.textContent;
        this._statusEl.textContent = 'Testing connection…';
        try {
            await this._api.testConnection(this._projectUnid, this._databaseUnid);
            this._statusEl.textContent = 'Connection OK.';
        } catch (err) {
            this._statusEl.textContent = `Connection failed: ${(err as Error).message}`;
        } finally {
            this._testBtn.disabled = false;
            /*
             * Restore the previous status after a short delay so the test
             * result doesn't permanently overwrite the change-count line.
             */
            setTimeout(() => {
                if (this._statusEl.textContent?.startsWith('Connection ') && previous) {
                    this._statusEl.textContent = previous;
                }
            }, 2500);
        }
    }

    private async _reload(): Promise<void> {
        this._refreshBtn.disabled = true;
        this._applyBtn.disabled = true;
        this._reverseBtn.disabled = true;
        this._testRunBtn.disabled = true;
        this._statusEl.textContent = 'Connecting + introspecting…';
        this._logPane.hidden = true;
        this._logPane.replaceChildren();
        try {
            const res = await this._api.syncPreview(this._projectUnid, this._databaseUnid, this._layerUnid, this._renames);
            const cs = res.changeSet as ChangeSet;
            this._changes = cs.changes;
            this._statements = res.statements as Statement[];
            this._modelDefaults = res.modelDefaults ?? {engine: '', charset: '', collation: ''};
            this._selected = new Set(this._changes.map(c => c.id));
            /* Drop the focused change — IDs are regenerated each preview. */
            this._focusedChangeId = null;
            this._renderList();
            this._renderSql();
            this._renderInspector();
            this._statusEl.textContent = this._changes.length === 0
                ? `In sync — model matches "${cs.databaseName}".`
                : `${this._changes.length} change${this._changes.length === 1 ? '' : 's'} vs. "${cs.databaseName}".`;
        } catch (err) {
            this._statusEl.textContent = `Failed: ${(err as Error).message}`;
            this._list.replaceChildren();
            this._sqlPane.textContent = '';
        } finally {
            this._refreshBtn.disabled = false;
            this._applyBtn.disabled = this._changes.length === 0;
            this._reverseBtn.disabled = this._changes.length === 0;
            this._testRunBtn.disabled = this._changes.length === 0;
        }
    }

    private _renderList(): void {
        this._list.replaceChildren();
        for (const c of this._changes) {
            const row = document.createElement('div');
            row.className = `sync-dialog-row sync-dialog-row--${c.severity}`;
            if (c.id === this._focusedChangeId) {row.classList.add('sync-dialog-row--focused');}
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = this._selected.has(c.id);
            cb.addEventListener('change', () => {
                if (cb.checked) {this._selected.add(c.id);} else {this._selected.delete(c.id);}
                this._renderSql();
            });
            const sev = document.createElement('span');
            sev.className = 'sync-dialog-badge';
            sev.textContent = SyncDialog._severityGlyph(c.severity);
            const text = document.createElement('span');
            text.className = 'sync-dialog-row-text';
            text.textContent = SyncDialog._formatChange(c);
            /*
             * Click the text (not the checkbox) to focus this change
             * in the inspector pane. The checkbox keeps its own
             * label-style click behaviour separately.
             */
            text.addEventListener('click', () => {
                this._focusedChangeId = c.id;
                this._renderList();
                this._renderInspector();
                this._activateDiffTab();
            });
            row.append(cb, sev, text);
            const more = this._buildRowActions(c);
            if (more) {row.append(more);}
            this._list.append(row);
        }
    }

    /**
     * Build the ⋯ action button for rows that participate in the manual
     * rename workflow. Returns null when the row has no actions (most
     * rows). Drop rows get a "Mark as rename of new …" submenu; rename
     * rows get an "Unpair" action.
     */
    private _buildRowActions(c: Change): HTMLElement | null {
        const items = this._renameMenuItems(c);
        if (items.length === 0) {return null;}
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'sync-dialog-row-more';
        more.title = 'Rename actions';
        more.replaceChildren(Icons.ellipsis());
        more.addEventListener('click', (e) => {
            e.stopPropagation();
            ContextMenu.open(more, items);
        });
        return more;
    }

    private _renameMenuItems(c: Change): ContextMenuItem[] {
        if (c.kind === CHANGE_KIND.tableDropped && c.tableName) {
            const candidates = this._changes.filter(x => x.kind === CHANGE_KIND.tableAdded && x.tableName);
            if (candidates.length === 0) {
                return [{label: 'No new tables to pair with', disabled: true, onClick: (): void => undefined}];
            }
            const fromName = c.tableName;
            return candidates.map<ContextMenuItem>(cand => ({
                label: `Mark as rename → ${cand.tableName}`,
                onClick: (): void => { this._pairTableRename(fromName, cand.tableName ?? ''); }
            }));
        }
        if (c.kind === CHANGE_KIND.columnDropped && c.tableName && c.columnName) {
            const candidates = this._changes.filter(x =>
                x.kind === CHANGE_KIND.columnAdded
                && x.tableName === c.tableName
                && x.columnName);
            if (candidates.length === 0) {
                return [{label: 'No new columns in this table to pair with', disabled: true, onClick: (): void => undefined}];
            }
            const fromCol = c.columnName;
            const tableName = c.tableName;
            return candidates.map<ContextMenuItem>(cand => ({
                label: `Mark as rename → ${cand.columnName}`,
                onClick: (): void => { this._pairColumnRename(tableName, fromCol, cand.columnName ?? ''); }
            }));
        }
        if (c.kind === CHANGE_KIND.tableRenamed && c.tableName) {
            const before = (c as unknown as {before?: {name?: string;};}).before;
            const fromName = before?.name ?? '';
            const toName = c.tableName;
            return [{
                label: 'Unpair (split into drop + add)',
                onClick: (): void => { this._unpairTableRename(fromName, toName); }
            }];
        }
        if (c.kind === CHANGE_KIND.columnRenamed && c.tableName && c.columnName) {
            const before = (c as unknown as {before?: {name?: string;};}).before;
            const fromName = before?.name ?? '';
            const toName = c.columnName;
            const tableName = c.tableName;
            return [{
                label: 'Unpair (split into drop + add)',
                onClick: (): void => { this._unpairColumnRename(tableName, fromName, toName); }
            }];
        }
        return [];
    }

    private _pairTableRename(from: string, to: string): void {
        if (!from || !to) {return;}
        const list = this._renames.tables ?? [];
        if (list.some(r => r.from === from && r.to === to)) {return;}
        this._renames = {...this._renames, tables: [...list, {from: from, to: to}]};
        this._reload().catch((err: unknown): void => console.error('[SyncDialog] reload after pair failed:', err));
    }

    private _pairColumnRename(tableName: string, from: string, to: string): void {
        if (!tableName || !from || !to) {return;}
        const list = this._renames.columns ?? [];
        if (list.some(r => r.tableName === tableName && r.from === from && r.to === to)) {return;}
        this._renames = {...this._renames, columns: [...list, {tableName: tableName, from: from, to: to}]};
        this._reload().catch((err: unknown): void => console.error('[SyncDialog] reload after pair failed:', err));
    }

    private _unpairTableRename(from: string, to: string): void {
        const list = this._renames.tables ?? [];
        this._renames = {
            ...this._renames,
            tables: list.filter(r => !(r.from === from && r.to === to))
        };
        this._reload().catch((err: unknown): void => console.error('[SyncDialog] reload after unpair failed:', err));
    }

    private _unpairColumnRename(tableName: string, from: string, to: string): void {
        const list = this._renames.columns ?? [];
        this._renames = {
            ...this._renames,
            columns: list.filter(r => !(r.tableName === tableName && r.from === from && r.to === to))
        };
        this._reload().catch((err: unknown): void => console.error('[SyncDialog] reload after unpair failed:', err));
    }

    /**
     * Render the Live vs. Model field-by-field comparison for the
     * currently-focused change. Helpful when a diff fired and the
     * user wants to see WHY — e.g. table-options diff that's actually
     * about a single inherited collation field, not a real drift.
     */
    private _renderInspector(): void {
        const id = this._focusedChangeId;
        const c = id ? this._changes.find(x => x.id === id) : null;
        if (!c) {
            this._inspectorPane.innerHTML = '<em>Click a change to inspect Live vs. Model side-by-side.</em>';
            return;
        }
        const before = (c as unknown as {before?: Record<string, unknown>;}).before;
        const after = (c as unknown as {after?: Record<string, unknown>;}).after;
        const header = document.createElement('div');
        header.className = 'sync-dialog-inspector-header';
        header.textContent = SyncDialog._formatChange(c);
        const sub = document.createElement('div');
        sub.className = 'sync-dialog-inspector-sub';
        sub.textContent = `kind: ${c.kind} · severity: ${c.severity}`;

        this._inspectorPane.replaceChildren(header, sub);

        /*
         * Add/Drop change kinds get a structured card instead of a
         * key-by-key flatten — the latter would dump raw JSON for
         * nested arrays (columns, indexes, foreignKeys). Cards
         * summarise the entity shape in a human-readable way.
         */
        if (c.kind === CHANGE_KIND.tableAdded || c.kind === CHANGE_KIND.tableDropped) {
            const table = (c.kind === CHANGE_KIND.tableAdded ? after : before) as unknown as JsonTableLike | undefined;
            const liveSide = c.kind === CHANGE_KIND.tableDropped;
            this._renderTableCard(table, liveSide);
            return;
        }
        if (c.kind === CHANGE_KIND.columnAdded || c.kind === CHANGE_KIND.columnDropped) {
            const col = (c.kind === CHANGE_KIND.columnAdded ? after : before) as unknown as JsonColumnLike | undefined;
            const liveSide = c.kind === CHANGE_KIND.columnDropped;
            this._renderColumnCard(col, liveSide);
            return;
        }
        if (c.kind === CHANGE_KIND.indexAdded || c.kind === CHANGE_KIND.indexDropped) {
            const ix = (c.kind === CHANGE_KIND.indexAdded ? after : before) as unknown as {name?: string; type?: string; columns?: unknown[];} | undefined;
            const liveSide = c.kind === CHANGE_KIND.indexDropped;
            this._renderSimpleCard(`${liveSide ? 'Live' : 'Model'} index`, [
                ['name', ix?.name ?? ''],
                ['type', ix?.type ?? ''],
                ['columns', String(ix?.columns?.length ?? 0)]
            ]);
            return;
        }
        if (c.kind === CHANGE_KIND.fkAdded || c.kind === CHANGE_KIND.fkDropped) {
            const fk = (c.kind === CHANGE_KIND.fkAdded ? after : before) as unknown as {name?: string; columns?: unknown[];} | undefined;
            const liveSide = c.kind === CHANGE_KIND.fkDropped;
            this._renderSimpleCard(`${liveSide ? 'Live' : 'Model'} foreign key`, [
                ['name', fk?.name ?? ''],
                ['columns', String(fk?.columns?.length ?? 0)]
            ]);
            return;
        }
        if (c.kind === CHANGE_KIND.tableRenamed) {
            const liveName = (before as {name?: string;} | undefined)?.name ?? '';
            const modelName = (after as {name?: string;} | undefined)?.name ?? c.tableName ?? '';
            this._renderSimpleCard('Table rename', [
                ['live name', liveName],
                ['model name', modelName]
            ]);
            return;
        }
        if (c.kind === CHANGE_KIND.columnRenamed) {
            const liveName = (before as {name?: string;} | undefined)?.name ?? '';
            const modelName = (after as {name?: string;} | undefined)?.name ?? c.columnName ?? '';
            this._renderSimpleCard('Column rename', [
                ['table', c.tableName ?? ''],
                ['live name', liveName],
                ['model name', modelName]
            ]);
            return;
        }
        if (c.kind === CHANGE_KIND.viewAdded || c.kind === CHANGE_KIND.viewDropped) {
            const v = (c.kind === CHANGE_KIND.viewAdded ? after : before) as unknown as {name?: string; select?: string;} | undefined;
            const liveSide = c.kind === CHANGE_KIND.viewDropped;
            this._renderSimpleCard(`${liveSide ? 'Live' : 'Model'} view`, [
                ['name', v?.name ?? ''],
                ['select', v?.select ?? '']
            ]);
            return;
        }

        if (!before && !after) {
            const empty = document.createElement('em');
            empty.textContent = '(no per-field detail available for this change kind)';
            this._inspectorPane.append(empty);
            return;
        }

        /*
         * Build the union of keys present on either side. For
         * tableOptionsChanged, before/after are JsonTableOptions
         * objects. For columnChanged, they're JsonColumn objects.
         * Either way we render a generic key/value diff — fields
         * that match are dim, fields that differ are highlighted.
         */
        const beforeFlat = SyncDialog._flatten(before);
        const afterFlat = SyncDialog._flatten(after);
        const keys = Array.from(new Set([...Object.keys(beforeFlat), ...Object.keys(afterFlat)])).sort();

        const table = document.createElement('table');
        table.className = 'sync-dialog-inspector-table';
        const head = document.createElement('tr');
        for (const label of ['Field', 'Live', 'Model']) {
            const th = document.createElement('th');
            th.textContent = label;
            head.append(th);
        }
        table.append(head);

        /*
         * For tableOptionsChanged-style fields, fall back the MODEL
         * side to the database-level default when the per-table
         * value is unset. Matches the diff's inheritance logic and
         * lets the user immediately see "the model uses the DB
         * default, here's what that value is". The inherited
         * indicator is `(DB default)` so it's distinguishable from
         * an explicit per-table value of the same string.
         */
        const inheritable = new Set(['engine', 'charset', 'collation']);
        const inheritedFor = (k: string): string => {
            switch (k) {
                case 'engine':    return this._modelDefaults.engine;
                case 'charset':   return this._modelDefaults.charset;
                case 'collation': return this._modelDefaults.collation;
                default: return '';
            }
        };
        /* Include inheritable keys with a DB default in the row set even if absent on both sides */
        for (const k of inheritable) {
            if (!(k in beforeFlat) && !(k in afterFlat) && inheritedFor(k)) {
                if (!keys.includes(k)) {keys.push(k);}
            }
        }
        keys.sort();

        for (const k of keys) {
            const tr = document.createElement('tr');
            const lv = beforeFlat[k] ?? '';
            let mv = afterFlat[k] ?? '';
            let mvLabel = mv === '' ? '—' : mv;
            if (mv === '' && inheritable.has(k)) {
                const inherited = inheritedFor(k);
                if (inherited) {
                    mv = inherited;
                    mvLabel = `${inherited} · (DB default)`;
                }
            }
            const differs = lv !== mv;
            tr.className = differs ? 'sync-dialog-inspector-diff' : 'sync-dialog-inspector-same';
            const tdKey = document.createElement('td');
            tdKey.textContent = k;
            const tdLive = document.createElement('td');
            tdLive.textContent = lv === '' ? '—' : lv;
            const tdModel = document.createElement('td');
            tdModel.textContent = mvLabel;
            tr.append(tdKey, tdLive, tdModel);
            table.append(tr);
        }
        this._inspectorPane.append(table);
    }

    /**
     * Flatten a JsonTableOptions / JsonColumn into a `{key: stringValue}`
     * shape suitable for side-by-side rendering. Nested objects and
     * arrays get JSON-stringified; primitives stringify directly;
     * boolean false renders as `false` (not omitted) so a NN-toggle
     * is visible. Excludes internal unids that don't carry meaning
     * to the user.
     */
    private static _flatten(obj: unknown): Record<string, string> {
        const out: Record<string, string> = {};
        if (!obj || typeof obj !== 'object') {return out;}
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
            if (k === 'unid') {continue;}
            if (v === undefined || v === null) {continue;}
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                out[k] = String(v);
            } else {
                out[k] = JSON.stringify(v);
            }
        }
        return out;
    }

    /**
     * Render a JsonTable summary card — used for tableAdded/Dropped
     * inspections. Columns get their own sub-table; indexes / FKs are
     * summarised by count + names; options listed inline. The OTHER
     * side gets `— (not present)` placeholder so the user sees what
     * side the change is on.
     */
    private _renderTableCard(table: JsonTableLike | undefined, liveSide: boolean): void {
        const wrap = document.createElement('div');
        wrap.className = 'sync-dialog-card';
        const liveLabel = document.createElement('div');
        liveLabel.className = 'sync-dialog-card-side';
        const modelLabel = document.createElement('div');
        modelLabel.className = 'sync-dialog-card-side';
        if (liveSide) {
            liveLabel.append(SyncDialog._tableSummary('Live', table));
            modelLabel.innerHTML = '<em>— (not in model)</em>';
        } else {
            liveLabel.innerHTML = '<em>— (not in live DB)</em>';
            modelLabel.append(SyncDialog._tableSummary('Model', table));
        }
        wrap.append(liveLabel, modelLabel);
        this._inspectorPane.append(wrap);
    }

    /**
     * Render a JsonColumn summary — used for columnAdded/Dropped.
     * Compact field grid + the other side blanked.
     */
    private _renderColumnCard(col: JsonColumnLike | undefined, liveSide: boolean): void {
        const wrap = document.createElement('div');
        wrap.className = 'sync-dialog-card';
        const liveDiv = document.createElement('div');
        liveDiv.className = 'sync-dialog-card-side';
        const modelDiv = document.createElement('div');
        modelDiv.className = 'sync-dialog-card-side';
        if (liveSide) {
            liveDiv.append(SyncDialog._columnSummary('Live', col));
            modelDiv.innerHTML = '<em>— (not in model)</em>';
        } else {
            liveDiv.innerHTML = '<em>— (not in live DB)</em>';
            modelDiv.append(SyncDialog._columnSummary('Model', col));
        }
        wrap.append(liveDiv, modelDiv);
        this._inspectorPane.append(wrap);
    }

    /**
     * Render a generic 2-column key/value summary block. Used for
     * index/fk/view Add/Drop cards where the entity is small enough
     * that a single short list reads better than a full sub-table.
     */
    private _renderSimpleCard(title: string, rows: [string, string][]): void {
        const wrap = document.createElement('div');
        wrap.className = 'sync-dialog-simple-card';
        const h = document.createElement('div');
        h.className = 'sync-dialog-card-title';
        h.textContent = title;
        wrap.append(h);
        const dl = document.createElement('dl');
        dl.className = 'sync-dialog-simple-list';
        for (const [k, v] of rows) {
            const dt = document.createElement('dt');
            dt.textContent = k;
            const dd = document.createElement('dd');
            dd.textContent = v || '—';
            dl.append(dt, dd);
        }
        wrap.append(dl);
        this._inspectorPane.append(wrap);
    }

    private static _tableSummary(title: string, table: JsonTableLike | undefined): HTMLElement {
        const wrap = document.createElement('div');
        const h = document.createElement('div');
        h.className = 'sync-dialog-card-title';
        h.textContent = `${title}: \`${table?.name ?? '?'}\``;
        wrap.append(h);
        const meta = document.createElement('div');
        meta.className = 'sync-dialog-card-meta';
        const opts = table?.options ?? {};
        const optParts: string[] = [];
        if (opts.engine) {optParts.push(`engine: ${opts.engine}`);}
        if (opts.charset) {optParts.push(`charset: ${opts.charset}`);}
        if (opts.collation) {optParts.push(`collation: ${opts.collation}`);}
        if (opts.comment) {optParts.push(`comment: ${opts.comment}`);}
        meta.textContent = optParts.length ? optParts.join(' · ') : '(no options)';
        wrap.append(meta);

        const cols = table?.columns ?? [];
        const ix = table?.indexes ?? [];
        const fks = table?.foreignKeys ?? [];

        const counts = document.createElement('div');
        counts.className = 'sync-dialog-card-meta';
        counts.textContent = `${cols.length} column${cols.length === 1 ? '' : 's'} · ${ix.length} index${ix.length === 1 ? '' : 'es'} · ${fks.length} FK${fks.length === 1 ? '' : 's'}`;
        wrap.append(counts);

        if (cols.length > 0) {
            const t = document.createElement('table');
            t.className = 'sync-dialog-card-columns';
            const head = document.createElement('tr');
            for (const lbl of ['#', 'Name', 'Type', 'Flags']) {
                const th = document.createElement('th');
                th.textContent = lbl;
                head.append(th);
            }
            t.append(head);
            let i = 1;
            for (const c of cols) {
                const tr = document.createElement('tr');
                const flags: string[] = [];
                if (c.primaryKey) {flags.push('PK');}
                if (c.notNull) {flags.push('NN');}
                if (c.unique) {flags.push('UQ');}
                if (c.autoIncrement) {flags.push('AI');}
                if (c.unsigned) {flags.push('UN');}
                for (const v of [
                    String(i++),
                    c.name ?? '',
                    c.length ? `${c.type ?? ''}(${c.length})` : c.type ?? '',
                    flags.join(', ')
                ]) {
                    const td = document.createElement('td');
                    td.textContent = v;
                    tr.append(td);
                }
                t.append(tr);
            }
            wrap.append(t);
        }
        if (ix.length > 0) {
            const list = document.createElement('div');
            list.className = 'sync-dialog-card-list';
            list.textContent = `Indexes: ${ix.map(x => x.name ?? '?').join(', ')}`;
            wrap.append(list);
        }
        if (fks.length > 0) {
            const list = document.createElement('div');
            list.className = 'sync-dialog-card-list';
            list.textContent = `FKs: ${fks.map(x => x.name ?? '?').join(', ')}`;
            wrap.append(list);
        }
        return wrap;
    }

    private static _columnSummary(title: string, col: JsonColumnLike | undefined): HTMLElement {
        const wrap = document.createElement('div');
        const h = document.createElement('div');
        h.className = 'sync-dialog-card-title';
        h.textContent = `${title}: \`${col?.name ?? '?'}\``;
        wrap.append(h);
        if (!col) {return wrap;}
        const dl = document.createElement('dl');
        dl.className = 'sync-dialog-simple-list';
        const rows: [string, string][] = [
            ['type', col.length ? `${col.type ?? ''}(${col.length})` : col.type ?? ''],
            ['nullable', col.notNull ? 'NO' : 'YES'],
            ['primary key', col.primaryKey ? 'yes' : 'no'],
            ['auto increment', col.autoIncrement ? 'yes' : 'no'],
            ['unique', col.unique ? 'yes' : 'no'],
            ['unsigned', col.unsigned ? 'yes' : 'no'],
            ['default', col.defaultValue ?? ''],
            ['comment', col.comment ?? '']
        ];
        for (const [k, v] of rows) {
            const dt = document.createElement('dt');
            dt.textContent = k;
            const dd = document.createElement('dd');
            dd.textContent = v || '—';
            dl.append(dt, dd);
        }
        wrap.append(dl);
        return wrap;
    }

    private _renderSql(): void {
        const lines: string[] = [];
        for (const s of this._statements) {
            if (!this._selected.has(s.changeId)) {continue;}
            lines.push(`${s.sql};`);
        }
        this._sqlPane.textContent = lines.length ? lines.join('\n') : '— no changes selected —';
    }

    private _copySql(): void {
        const text = this._sqlPane.textContent || '';
        navigator.clipboard?.writeText(text).catch(() => undefined);
    }

    private async _reverseApply(): Promise<void> {
        const selectedIds = [...this._selected];
        if (selectedIds.length === 0) {
            this._statusEl.textContent = 'Select at least one change.';
            return;
        }
        /*
         * Reverse means the MODEL changes, not the live DB. Inversely,
         * the changes labelled `safe` in the forward direction (adds) become
         * model-side drops here; what's labelled `destructive` in the forward
         * direction (drops) become model-side adds. Phrase the confirmation
         * around that to avoid misleading the user.
         */
        const modelSideDrops = this._changes.filter(c => this._selected.has(c.id) && (
            c.kind === 'tableAdded' || c.kind === 'columnAdded' ||
            c.kind === 'indexAdded' || c.kind === 'fkAdded' || c.kind === 'viewAdded'
        )).length;
        const lines = [
            `Adopt ${selectedIds.length} live change${selectedIds.length === 1 ? '' : 's'} into the model.`,
            'The model JSON will be rewritten to match the live DB for these objects.'
        ];
        if (modelSideDrops > 0) {
            lines.push(`${modelSideDrops} model object${modelSideDrops === 1 ? '' : 's'} will be removed (they exist in the model but not in live).`);
        }
        lines.push('', 'No SQL is generated. No live DB write happens. Continue?');
        const ok = await ConfirmDialog.showConfirm(
            'Confirm reverse apply',
            lines.join('\n'),
            modelSideDrops > 0 ? 'danger' : 'primary'
        );
        if (!ok) {return;}

        this._reverseBtn.disabled = true;
        this._applyBtn.disabled = true;
        this._refreshBtn.disabled = true;
        this._statusEl.textContent = 'Applying live state into model…';

        try {
            const res = await this._api.syncReverseApply(this._projectUnid, this._databaseUnid, selectedIds, this._layerUnid, this._renames);
            const skipped = res.requestedCount - res.appliedChangeIds.length;
            const skippedHint = skipped > 0 ? ` (${skipped} skipped — refs not resolvable)` : '';
            this._statusEl.textContent = `Model updated for ${res.appliedChangeIds.length} change${res.appliedChangeIds.length === 1 ? '' : 's'}${skippedHint}. Refreshing preview…`;
            /*
             * Re-run preview so the now-resolved changes drop out of the
             * list. The live cache is unchanged — we only mutated the model.
             */
            setTimeout(() => {
                this._reload().catch((err: unknown): void => console.error('[SyncDialog] post-reverse reload failed:', err));
            }, 200);
        } catch (err) {
            this._statusEl.textContent = `Reverse apply failed: ${(err as Error).message}`;
        } finally {
            this._reverseBtn.disabled = false;
            this._applyBtn.disabled = false;
            this._refreshBtn.disabled = false;
        }
    }

    private async _apply(): Promise<void> {
        const selectedIds = [...this._selected];
        if (selectedIds.length === 0) {
            this._statusEl.textContent = 'Select at least one change.';
            return;
        }
        const destructiveCount = this._changes.filter(c => this._selected.has(c.id) && c.severity === 'destructive').length;
        const dryRun = this._dryRunCb.checked;

        const lines = [
            `${dryRun ? 'Dry-run' : 'Apply'} ${selectedIds.length} change${selectedIds.length === 1 ? '' : 's'}.`
        ];
        if (destructiveCount > 0) {
            lines.push(`${destructiveCount} of them are destructive (drop column / drop table).`);
        }
        if (!dryRun) {
            lines.push('A migration pair (.up.sql / .down.sql) will be written to the output directory.');
        }
        lines.push('', `Continue${dryRun ? '' : ' for real'}?`);
        const ok = await ConfirmDialog.showConfirm(
            dryRun ? 'Confirm dry-run' : 'Confirm apply',
            lines.join('\n'),
            destructiveCount > 0 && !dryRun ? 'danger' : 'primary'
        );
        if (!ok) {return;}

        this._applyBtn.disabled = true;
        this._refreshBtn.disabled = true;
        this._statusEl.textContent = dryRun ? 'Running dry-run against live DB…' : 'Applying to live DB…';
        this._logPane.hidden = false;
        this._logPane.replaceChildren();

        try {
            const res = await this._api.syncApply(this._projectUnid, this._databaseUnid, selectedIds, dryRun, this._layerUnid, this._renames);
            this._renderLog(res.statementResults);
            if (res.success) {
                if (dryRun) {
                    this._statusEl.textContent = `Dry-run OK — ${res.statementResults.length} statement${res.statementResults.length === 1 ? '' : 's'} would run cleanly.`;
                } else if (res.migrationFiles) {
                    const up = res.migrationFiles.up.split('/').pop();
                    const down = res.migrationFiles.down.split('/').pop();
                    this._statusEl.textContent = `Applied. Migration pair written: ${up} / ${down}. Refreshing live state…`;
                    /*
                     * Re-run preview after a short delay so the live SSE
                     * refresh has time to land — the user sees the change
                     * count drop to 0 without needing to click Refresh.
                     */
                    setTimeout(() => {
                        this._reload().catch((err: unknown): void => console.error('[SyncDialog] post-apply reload failed:', err));
                    }, 400);
                } else {
                    this._statusEl.textContent = 'Applied.';
                }
            } else {
                const failed = res.statementResults.find(r => !r.ok);
                this._statusEl.textContent = failed
                    ? `Apply aborted: ${failed.error ?? 'unknown error'}`
                    : 'Apply aborted with no error message.';
            }
        } catch (err) {
            this._statusEl.textContent = `Apply failed: ${(err as Error).message}`;
        } finally {
            this._applyBtn.disabled = false;
            this._refreshBtn.disabled = false;
        }
    }

    /**
     * Safe test-run cycle: server dumps the live DB, runs the
     * selected statements for real, then restores. We surface three
     * UI states:
     *
     *   - success → green status line + statement log (all ok), the
     *     SQL pane already holds the statements the user would
     *     translate to migration code
     *   - apply-fail-restore-ok → red status line + log highlights
     *     the failing statement; live DB is back to its pre-test state
     *   - restore-fail → red sticky banner with the dump path + manual
     *     mysql restore command; statements that ran are still in the
     *     log so the user can see how far the apply got
     */
    private async _testRun(): Promise<void> {
        const selectedIds = [...this._selected];
        if (selectedIds.length === 0) {
            this._statusEl.textContent = 'Select at least one change.';
            return;
        }
        const lines = [
            `Run ${selectedIds.length} change${selectedIds.length === 1 ? '' : 's'} in test mode.`,
            '',
            'This will:',
            '  1) dump the live DB to <output>/sync-tests/',
            '  2) apply the selected statements for real',
            '  3) restore from the dump (always — even on success)',
            '',
            'No migration files are written. The live DB ends up unchanged on success or apply-failure.',
            '',
            'IMPORTANT: nothing should write to the DB during the run window — other writers would be clobbered by the restore step.',
            '',
            'Continue?'
        ];
        const ok = await ConfirmDialog.showConfirm('Confirm test run', lines.join('\n'), 'primary');
        if (!ok) {return;}

        this._testRunBtn.disabled = true;
        this._applyBtn.disabled = true;
        this._refreshBtn.disabled = true;
        this._reverseBtn.disabled = true;
        this._criticalBanner.hidden = true;
        this._criticalBanner.replaceChildren();
        this._statusEl.textContent = 'Dumping live DB…';
        this._logPane.hidden = false;
        this._logPane.replaceChildren();

        try {
            const res = await this._api.syncTestRun(
                this._projectUnid,
                this._databaseUnid,
                selectedIds,
                this._layerUnid,
                this._renames
            );

            this._renderLog(res.statementResults);

            if (res.critical) {
                this._renderCriticalBanner(res);
                this._statusEl.textContent = 'TEST RUN FAILED CRITICALLY — see banner above.';
                return;
            }
            if (res.error) {
                this._statusEl.textContent = `Test run failed before apply: ${res.error}`;
                return;
            }
            if (res.success) {
                const purgedNote = res.dumpKept ? ` Dump kept at ${res.dumpPath}.` : '';
                this._statusEl.textContent = `Test run OK — all ${res.statementResults.length} statement${res.statementResults.length === 1 ? '' : 's'} ran cleanly and the DB was restored.${purgedNote}`;
                return;
            }
            /* Apply failed cleanly, restore succeeded — the typical "your change has a bug" case. */
            const failed = res.statementResults.find(r => !r.ok);
            const where = res.failedAtIndex === undefined ? '' : ` at statement ${res.failedAtIndex + 1}/${res.statementResults.length}`;
            this._statusEl.textContent = failed
                ? `Test run failed${where}: ${failed.error ?? 'unknown error'}. DB restored from dump (${res.dumpPath}).`
                : `Test run failed${where}. DB restored from dump (${res.dumpPath}).`;
        } catch (err) {
            this._statusEl.textContent = `Test run request failed: ${(err as Error).message}`;
        } finally {
            this._testRunBtn.disabled = this._changes.length === 0;
            this._applyBtn.disabled = this._changes.length === 0;
            this._refreshBtn.disabled = false;
            this._reverseBtn.disabled = this._changes.length === 0;
        }
    }

    /**
     * Build the sticky red banner for the worst case: restore step
     * itself failed, so the live DB may be in a half-applied state.
     * We surface the dump path + a copyable `mysql` command so the
     * user can recover manually.
     */
    private _renderCriticalBanner(res: {
        dumpPath: string;
        restoreError?: string;
        restoreStderr?: string;
    }): void {
        this._criticalBanner.replaceChildren();
        const header = document.createElement('div');
        header.className = 'sync-dialog-critical-banner-header';
        header.textContent = '⚠ Live DB may be in an inconsistent state — manual recovery required';
        const body = document.createElement('div');
        body.className = 'sync-dialog-critical-banner-body';
        const reason = document.createElement('div');
        reason.textContent = res.restoreError
            ? `Restore failed: ${res.restoreError}`
            : 'Restore step failed.';
        body.append(reason);
        if (res.restoreStderr) {
            const errBlock = document.createElement('pre');
            errBlock.className = 'sync-dialog-critical-banner-stderr';
            errBlock.textContent = res.restoreStderr;
            body.append(errBlock);
        }
        const cmdLabel = document.createElement('div');
        cmdLabel.textContent = `Dump preserved at: ${res.dumpPath}`;
        body.append(cmdLabel);
        const cmd = document.createElement('pre');
        cmd.className = 'sync-dialog-critical-banner-cmd';
        /*
         * Suggest the bare restore command without credentials —
         * pasting credentials into the UI risks them ending up in
         * shell history. Caller is expected to substitute their own
         * connection params.
         */
        cmd.textContent = `mysql -h <host> -u <user> -p < ${res.dumpPath}`;
        body.append(cmd);
        this._criticalBanner.append(header, body);
        this._criticalBanner.hidden = false;
    }

    private _renderLog(results: StatementResult[]): void {
        this._logPane.replaceChildren();
        const head = document.createElement('div');
        head.className = 'sync-dialog-log-head';
        head.textContent = 'Statement log';
        this._logPane.append(head);

        for (const r of results) {
            const row = document.createElement('div');
            row.className = `sync-dialog-log-row sync-dialog-log-row--${r.ok ? 'ok' : 'err'}`;

            const mark = document.createElement('span');
            mark.className = 'sync-dialog-log-mark';
            mark.replaceChildren(r.ok ? Icons.check() : Icons.cross());

            const sql = document.createElement('code');
            sql.className = 'sync-dialog-log-sql';
            sql.textContent = r.sql;

            const dur = document.createElement('span');
            dur.className = 'sync-dialog-log-dur';
            dur.textContent = `${r.durationMs} ms`;

            row.append(mark, sql, dur);
            if (!r.ok && r.error) {
                const errEl = document.createElement('div');
                errEl.className = 'sync-dialog-log-err';
                errEl.textContent = r.error;
                row.append(errEl);
            }
            this._logPane.append(row);
        }
    }

    private static _severityGlyph(s: Change['severity']): string {
        if (s === 'destructive') {return '!';}
        if (s === 'warn') {return '~';}
        return '+';
    }

    private static _formatChange(c: Change): string {
        const target = SyncDialog._targetLabel(c);
        return `[${c.kind}] ${target}`;
    }

    private static _targetLabel(c: Change): string {
        if (c.viewName) {return `view ${c.viewName}`;}
        if (c.fkName) {return `${c.tableName}.<fk> ${c.fkName}`;}
        if (c.indexName) {return `${c.tableName}.<index> ${c.indexName}`;}
        if (c.columnName) {return `${c.tableName}.${c.columnName}`;}
        if (c.tableName) {return c.tableName;}
        return '';
    }

}