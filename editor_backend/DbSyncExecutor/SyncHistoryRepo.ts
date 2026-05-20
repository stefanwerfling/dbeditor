import * as fs from 'fs';
import * as path from 'path';
import {randomUUID} from 'crypto';
import {SyncStatementResult} from './SyncExecutor.js';

/**
 * Mode of one historic sync run.
 *
 *   - `apply`         → real apply against the live DB (writes migration pair).
 *   - `test-run`      → safe dump → apply → restore cycle.
 *   - `reverse-apply` → live state adopted into the model (no SQL emitted).
 *   - `dry-run`       → reserved for future use; not currently logged.
 *
 * Dry-runs aren't worth persisting at the moment — they're preview-grade
 * and the user already sees the diff in the SyncDialog. If that
 * changes, add the mode value here; the dialog walks the list
 * tolerantly so unknown modes render as a grey badge.
 */
export type SyncHistoryMode = 'apply' | 'test-run' | 'reverse-apply' | 'dry-run';

/**
 * Compact count-by-kind summary so the list view can render
 * `+2 tables · -1 column` without re-walking every statement.
 *
 * Keys mirror `SchemaChangeKind` literals. Missing entries default to 0.
 */
export type SyncHistoryChangeSummary = Record<string, number>;

/**
 * One row in the history file. All fields are optional except the
 * ones that uniquely identify the run; absent fields render as
 * `—` in the UI.
 */
export type SyncHistoryEntry = {
    id: string;
    ts: string;
    mode: SyncHistoryMode;
    dialect: string;
    databaseUnid: string;
    databaseName: string;
    diagramUnid?: string;
    layerName?: string;
    selectedChangeIds: string[];
    changeSetSummary: SyncHistoryChangeSummary;
    statementResults: SyncStatementResult[];
    migrationFiles?: {up: string; down: string;};
    dumpPath?: string;
    dumpKept?: boolean;
    dumpSizeBytes?: number;
    success: boolean;
    critical?: boolean;
    restoreOk?: boolean | null;
    restoreError?: string;
    failedAtIndex?: number;
    appliedChangeIds?: string[];
    /** Wall-clock duration from request start to response — best-effort. */
    durationMs: number;
};

/**
 * On-disk shape. Wrapped in an object (not a bare array) so we can
 * add metadata fields later (e.g. retention policy, schema version)
 * without a migration of every existing file.
 */
type SyncHistoryFile = {
    version: 1;
    entries: SyncHistoryEntry[];
};

export class SyncHistoryRepo {

    /**
     * Resolve the history-file path for a project. Lives next to the
     * schema file (`<schemaPath dirname>/sync-history.json`) so it
     * shares the schema file's gitignore/sync-with-others story. The
     * caller passes the absolute schema path.
     */
    public static pathFor(schemaPath: string): string {
        return path.join(path.dirname(schemaPath), 'sync-history.json');
    }

    /**
     * Read the history from disk. Returns `[]` when the file is
     * missing or unparseable — the history feature is a convenience
     * diagram; an unreadable file should never block a sync operation.
     *
     * Malformed-file recovery: if the JSON parses but doesn't match
     * the shape (e.g. `entries` missing), we still return an empty
     * list and leave the file untouched. The next successful append
     * will replace the file atomically and re-establish the canonical
     * shape.
     */
    public static load(historyPath: string): SyncHistoryEntry[] {
        if (!fs.existsSync(historyPath)) {return [];}
        try {
            const raw = fs.readFileSync(historyPath, 'utf-8');
            const parsed = JSON.parse(raw) as Partial<SyncHistoryFile>;
            if (!parsed || !Array.isArray(parsed.entries)) {return [];}
            return parsed.entries as SyncHistoryEntry[];
        } catch (err) {
            console.error('[SyncHistoryRepo] failed to read history:', err);
            return [];
        }
    }

    /**
     * Append a new entry to the front of the history (newest first)
     * and persist via atomic tmp+rename. Returns the entry with `id`
     * and `ts` filled in (so callers don't need to mint them).
     *
     * On write failure: logs to stderr and returns the entry anyway —
     * callers don't get an error. Rationale: a sync operation that
     * succeeded shouldn't surface as failed to the user because the
     * history side-channel hiccupped.
     */
    public static append(
        historyPath: string,
        entry: Omit<SyncHistoryEntry, 'id' | 'ts'> & {id?: string; ts?: string;}
    ): SyncHistoryEntry {
        const full: SyncHistoryEntry = {
            ...entry,
            id: entry.id ?? randomUUID(),
            ts: entry.ts ?? new Date().toISOString()
        };
        try {
            const existing = SyncHistoryRepo.load(historyPath);
            const next: SyncHistoryFile = {
                version: 1,
                entries: [full, ...existing]
            };
            const dir = path.dirname(historyPath);
            if (!fs.existsSync(dir)) {fs.mkdirSync(dir, {recursive: true});}
            const tmp = `${historyPath}.tmp.${process.pid}.${Date.now()}`;
            fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
            fs.renameSync(tmp, historyPath);
        } catch (err) {
            console.error('[SyncHistoryRepo] failed to append entry:', err);
        }
        return full;
    }

    /**
     * Build a `SyncHistoryChangeSummary` from the list of changes that
     * were operated on. Counts by `kind`. Used by every route that
     * persists history so the list view doesn't have to re-derive it
     * from `statementResults` (which only carry SQL, not change shape).
     */
    public static summarise(changes: readonly {kind: string;}[]): SyncHistoryChangeSummary {
        const out: SyncHistoryChangeSummary = {};
        for (const c of changes) {
            out[c.kind] = (out[c.kind] ?? 0) + 1;
        }
        return out;
    }

}