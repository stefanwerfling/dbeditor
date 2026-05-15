import {BaseDialog} from '../Base/BaseDialog.js';
import {DbApiClient, SyncHistoryEntry} from '../Api/DbApiClient.js';
import {iconCheck, iconCross} from '../Util/Icons.js';

/**
 * Newest-first list of every sync operation that ran against the
 * live DB — apply, test-run, reverse-apply. Click a row → details
 * panel with mode, dialect, duration, dump info (if any), and the
 * full statement log.
 *
 * Used to answer "what did I do last time?" and "which test runs
 * failed?". The user explicitly asked for a commit-style history
 * with reverse browsing — this is the engine.
 */
export class SyncHistoryDialog extends BaseDialog<void> {

    private readonly _api: DbApiClient;
    private readonly _projectUnid: string;
    private _entries: SyncHistoryEntry[] = [];
    private _selectedId: string | null = null;
    private _statusEl!: HTMLDivElement;
    private _listEl!: HTMLDivElement;
    private _detailEl!: HTMLDivElement;

    public constructor(api: DbApiClient, projectUnid: string) {
        super('Sync history');
        this._api = api;
        this._projectUnid = projectUnid;
        this._dialog.classList.add('sync-history-dialog');
        this._buildBody();
        this._reload().catch((err: unknown): void => console.error('[SyncHistoryDialog] initial load failed:', err));
    }

    private _buildBody(): void {
        this._statusEl = document.createElement('div');
        this._statusEl.className = 'sync-dialog-status';
        this._statusEl.textContent = 'Loading…';
        this._body.append(this._statusEl);

        const split = document.createElement('div');
        split.className = 'sync-history-split';
        this._body.append(split);

        this._listEl = document.createElement('div');
        this._listEl.className = 'sync-history-list';
        split.append(this._listEl);

        this._detailEl = document.createElement('div');
        this._detailEl.className = 'sync-history-detail';
        this._detailEl.innerHTML = '<em>Click an entry to inspect its statements.</em>';
        split.append(this._detailEl);

        this.addButton('Refresh', 'grey', (): void => {
            this._reload().catch((err: unknown): void => console.error('[SyncHistoryDialog] reload failed:', err));
        });
        this.addButton('Close', 'grey', (): void => this.close());
    }

    private async _reload(): Promise<void> {
        this._statusEl.textContent = 'Loading…';
        try {
            const res = await this._api.getSyncHistory(this._projectUnid);
            this._entries = res.entries;
            this._statusEl.textContent = this._entries.length === 0
                ? 'No sync runs recorded yet.'
                : `${this._entries.length} run${this._entries.length === 1 ? '' : 's'} recorded.`;
            this._renderList();
            this._renderDetail();
        } catch (err) {
            this._statusEl.textContent = `Failed to load history: ${(err as Error).message}`;
            this._listEl.replaceChildren();
            this._detailEl.replaceChildren();
        }
    }

    private _renderList(): void {
        this._listEl.replaceChildren();
        for (const e of this._entries) {
            const row = document.createElement('div');
            row.className = `sync-history-row sync-history-row--${SyncHistoryDialog._severityFor(e)}`;
            if (e.id === this._selectedId) {row.classList.add('sync-history-row--selected');}

            const mode = document.createElement('span');
            mode.className = `sync-history-mode sync-history-mode--${e.mode}`;
            mode.textContent = e.mode;

            const ts = document.createElement('span');
            ts.className = 'sync-history-ts';
            ts.textContent = SyncHistoryDialog._formatTs(e.ts);

            const summary = document.createElement('span');
            summary.className = 'sync-history-summary';
            summary.textContent = SyncHistoryDialog._formatSummary(e);

            const status = document.createElement('span');
            status.className = 'sync-history-status';
            if (e.critical) {
                status.classList.add('sync-history-status--critical');
                status.textContent = 'CRITICAL';
            } else if (e.success) {
                status.classList.add('sync-history-status--ok');
                status.replaceChildren(iconCheck());
            } else {
                status.classList.add('sync-history-status--fail');
                status.replaceChildren(iconCross());
            }

            row.append(mode, ts, summary, status);
            row.addEventListener('click', () => {
                this._selectedId = e.id;
                this._renderList();
                this._renderDetail();
            });
            this._listEl.append(row);
        }
    }

    private _renderDetail(): void {
        this._detailEl.replaceChildren();
        const id = this._selectedId;
        const e = id ? this._entries.find(x => x.id === id) : null;
        if (!e) {
            const em = document.createElement('em');
            em.textContent = 'Click an entry to inspect its statements.';
            this._detailEl.append(em);
            return;
        }
        const header = document.createElement('div');
        header.className = 'sync-history-detail-header';
        header.textContent = `[${e.mode}] ${SyncHistoryDialog._formatTs(e.ts)} · ${e.databaseName} (${e.dialect})`;
        this._detailEl.append(header);

        const meta = document.createElement('dl');
        meta.className = 'sync-history-detail-meta';
        const metaRows: [string, string][] = [
            ['Status', SyncHistoryDialog._statusLabel(e)],
            ['Duration', `${e.durationMs} ms`],
            ['Changes', SyncHistoryDialog._formatSummary(e)],
            ['Statements', String(e.statementResults.length)]
        ];
        if (e.layerUnid) {metaRows.push(['EER diagram', e.layerName ?? e.layerUnid]);}
        if (e.migrationFiles) {
            metaRows.push(['Migration up', e.migrationFiles.up]);
            metaRows.push(['Migration down', e.migrationFiles.down]);
        }
        if (e.dumpPath) {
            metaRows.push(['Dump path', e.dumpPath]);
            metaRows.push(['Dump kept', e.dumpKept ? 'yes' : 'no']);
            if (e.dumpSizeBytes !== undefined && e.dumpSizeBytes > 0) {
                metaRows.push(['Dump size', SyncHistoryDialog._formatBytes(e.dumpSizeBytes)]);
            }
        }
        if (e.restoreOk === false) {metaRows.push(['Restore error', e.restoreError ?? '(no detail)']);}
        if (e.failedAtIndex !== undefined) {
            metaRows.push(['Failed at', `statement ${e.failedAtIndex + 1}/${e.statementResults.length}`]);
        }
        if (e.appliedChangeIds) {metaRows.push(['Adopted changes', String(e.appliedChangeIds.length)]);}
        for (const [k, v] of metaRows) {
            const dt = document.createElement('dt');
            dt.textContent = k;
            const dd = document.createElement('dd');
            dd.textContent = v;
            meta.append(dt, dd);
        }
        this._detailEl.append(meta);

        /*
         * Combined SQL block — every statement.sql joined with `;\n`
         * so the user can copy-paste the whole run into a TypeORM
         * migration / a worksheet / whatever. Sits above the per-
         * statement log because that's what the user typically wants
         * first when revisiting history.
         */
        if (e.statementResults.length > 0) {
            const sqlHeaderRow = document.createElement('div');
            sqlHeaderRow.className = 'sync-history-detail-section-title sync-history-detail-section-title--with-action';
            const sqlHeaderLabel = document.createElement('span');
            sqlHeaderLabel.textContent = 'Combined SQL';
            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'btn-grey sync-history-copy-btn';
            copyBtn.textContent = 'Copy SQL';
            const combinedSql = SyncHistoryDialog._combinedSql(e.statementResults);
            copyBtn.addEventListener('click', () => {
                navigator.clipboard?.writeText(combinedSql)
                .then(() => {
                    const prev = copyBtn.textContent;
                    copyBtn.textContent = 'Copied';
                    setTimeout(() => { copyBtn.textContent = prev; }, 1200);
                })
                .catch((err: unknown): void => console.error('[SyncHistoryDialog] clipboard write failed:', err));
            });
            sqlHeaderRow.append(sqlHeaderLabel, copyBtn);
            this._detailEl.append(sqlHeaderRow);
            const pre = document.createElement('pre');
            pre.className = 'sync-history-sql-block';
            pre.textContent = combinedSql;
            this._detailEl.append(pre);
        }

        if (e.statementResults.length > 0) {
            const stmtsHeader = document.createElement('div');
            stmtsHeader.className = 'sync-history-detail-section-title';
            stmtsHeader.textContent = 'Statements';
            this._detailEl.append(stmtsHeader);

            for (const r of e.statementResults) {
                const row = document.createElement('div');
                row.className = `sync-dialog-log-row sync-dialog-log-row--${r.ok ? 'ok' : 'err'}`;
                const mark = document.createElement('span');
                mark.className = 'sync-dialog-log-mark';
                mark.replaceChildren(r.ok ? iconCheck() : iconCross());
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
                this._detailEl.append(row);
            }
        }
    }

    private addButton(label: string, kind: 'grey' | 'primary', onClick: () => void): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = kind === 'primary' ? 'btn-primary' : 'btn-grey';
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        this._footer.append(btn);
        return btn;
    }

    private static _combinedSql(results: SyncHistoryEntry['statementResults']): string {
        return results.map(r => `${r.sql};`).join('\n');
    }

    private static _statusLabel(e: SyncHistoryEntry): string {
        if (e.critical) {return 'CRITICAL — restore failed';}
        return e.success ? 'success' : 'failed';
    }

    private static _severityFor(e: SyncHistoryEntry): 'ok' | 'warn' | 'fail' | 'critical' {
        if (e.critical) {return 'critical';}
        if (e.success) {return 'ok';}
        return 'fail';
    }

    private static _formatSummary(e: SyncHistoryEntry): string {
        const parts: string[] = [];
        for (const [kind, n] of Object.entries(e.changeSetSummary)) {
            parts.push(`${kind} ×${n}`);
        }
        return parts.length === 0 ? '—' : parts.join(' · ');
    }

    private static _formatTs(iso: string): string {
        try {
            const d = new Date(iso);
            return d.toLocaleString();
        } catch {
            return iso;
        }
    }

    private static _formatBytes(n: number): string {
        if (n < 1024) {return `${n} B`;}
        if (n < 1024 * 1024) {return `${(n / 1024).toFixed(1)} KB`;}
        if (n < 1024 * 1024 * 1024) {return `${(n / (1024 * 1024)).toFixed(1)} MB`;}
        return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

}