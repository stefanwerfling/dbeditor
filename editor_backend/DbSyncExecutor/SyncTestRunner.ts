import * as fs from 'fs';
import * as path from 'path';
import {DbConnection} from '../DbConnection/DbConnection.js';
import {DbProjectConnection} from '../DbProject/DbProject.js';
import {SyncStatement} from '../DbGenerator/Sync/SyncGenerator.js';
import {DumpAdapter, DumpRestoreResult} from './DumpAdapters/DumpAdapter.js';
import {SyncExecutor, SyncStatementResult} from './SyncExecutor.js';

/**
 * Outcome of a complete test-run cycle.
 *
 * Field semantics:
 *   - `success` — true only when ALL of {dump, every statement, restore}
 *     succeeded. False otherwise — including the apply-fails-restore-ok
 *     case (which is a *successful negative* test result, but the user
 *     learns that the change set has a problem so we don't call it
 *     success).
 *   - `critical` — true only when the RESTORE step failed. This is the
 *     "live DB is in indeterminate state" case that the UI surfaces
 *     as a red banner with manual recovery instructions.
 *   - `dumpPath` — always populated when the dump itself succeeded.
 *     On dump failure it's the path we *tried* to write to (helpful
 *     for the user even when empty).
 *   - `dumpKept` — true means the dump file is still on disk after
 *     the run. On `critical` paths we always keep it (user needs it
 *     for manual recovery). On full-success paths we delete it by
 *     default — there's nothing to recover from when everything
 *     went well.
 */
export type SyncTestRunResult = {
    success: boolean;
    critical: boolean;
    dumpPath: string;
    dumpKept: boolean;
    dumpSizeBytes: number;
    dumpDurationMs: number;
    statementResults: SyncStatementResult[];
    restoreOk: boolean | null;
    restoreError?: string;
    restoreStderr?: string;
    restoreDurationMs?: number;
    /** Index in `statements` where execution stopped (only set on apply failure). */
    failedAtIndex?: number;
    /** Top-level error message — populated when dump itself fails. */
    error?: string;
};

export type SyncTestRunOptions = {
    /**
     * When true (the default), delete the dump file after a fully
     * successful test run — there's nothing to recover from. On any
     * failure path (apply error or restore error) the dump is kept
     * regardless. Set false to always keep the dump.
     */
    purgeOnSuccess?: boolean;
};

/**
 * Orchestrates one safe test-apply cycle:
 *
 *   1. dump the live DB to disk
 *   2. run every statement against the live DB (sequential, abort-on-error)
 *   3. ALWAYS restore from the dump — including on full success, since
 *      the whole point of a test run is to leave the DB untouched
 *   4. report a structured outcome that the UI can branch on
 *
 * Concurrency note: callers should warn the user that other writers
 * shouldn't hit the DB during the run window — `mysqldump
 * --single-transaction` gives us a consistent snapshot but the
 * restore step at the end will clobber any writes made by other
 * sessions during the apply window.
 *
 * Path policy: caller computes `dumpPath` (typically
 * `<destinationPath>/sync-tests/<timestamp>__<dbname>.sql`). We create
 * the parent directory if missing; on any failure we leave the file
 * (or partial file) untouched so the user can inspect it.
 */
export class SyncTestRunner {

    public static async run(
        adapter: DumpAdapter,
        cfg: DbProjectConnection,
        conn: DbConnection,
        statements: SyncStatement[],
        dumpPath: string,
        options: SyncTestRunOptions = {}
    ): Promise<SyncTestRunResult> {
        const purgeOnSuccess = options.purgeOnSuccess !== false;

        /* Ensure parent directory exists — the adapter doesn't do this. */
        const parent = path.dirname(dumpPath);
        try {
            fs.mkdirSync(parent, {recursive: true});
        } catch (err) {
            return {
                success: false,
                critical: false,
                dumpPath: dumpPath,
                dumpKept: false,
                dumpSizeBytes: 0,
                dumpDurationMs: 0,
                statementResults: [],
                restoreOk: null,
                error: `failed to create dump directory "${parent}": ${(err as Error).message}`
            };
        }

        const dumpResult: DumpRestoreResult = await adapter.dump(cfg, dumpPath);
        const dumpSize = SyncTestRunner._safeSize(dumpPath);
        if (!dumpResult.ok) {
            return {
                success: false,
                critical: false,
                dumpPath: dumpPath,
                dumpKept: fs.existsSync(dumpPath),
                dumpSizeBytes: dumpSize,
                dumpDurationMs: dumpResult.durationMs,
                statementResults: [],
                restoreOk: null,
                error: `dump failed: ${dumpResult.error ?? 'unknown error'}${dumpResult.stderr ? `\n${dumpResult.stderr}` : ''}`
            };
        }

        /*
         * Apply phase. `dryRun=false` — we want the statements to
         * actually run against the live DB so the test exercises the
         * real DDL path; the dump+restore is what makes it safe.
         */
        const statementResults = await SyncExecutor.run(conn, statements, {dryRun: false});
        const lastIdx = statementResults.length - 1;
        const failedAt = lastIdx >= 0 && !statementResults[lastIdx].ok ? lastIdx : undefined;
        const applyOk = failedAt === undefined && statementResults.length === statements.length;

        /*
         * Restore phase — ALWAYS run, even on apply success (that's
         * the whole point of a test). Capture errors but don't
         * throw; the result struct carries enough for the UI.
         */
        const restoreResult: DumpRestoreResult = await adapter.restore(cfg, dumpPath);
        const restoreOk = restoreResult.ok;

        const critical = !restoreOk;
        const success = applyOk && restoreOk;
        /*
         * Keep the dump on any failure path (apply or restore). On
         * full success the user requested purge → delete it.
         */
        let dumpKept = true;
        if (success && purgeOnSuccess) {
            try {
                fs.unlinkSync(dumpPath);
                dumpKept = false;
            } catch (err) {
                /*
                 * Couldn't delete the dump — not fatal, just surface
                 * as kept. The user can clean up manually.
                 */
                dumpKept = true;
                console.error(`[SyncTestRunner] failed to purge dump "${dumpPath}":`, err);
            }
        }

        return {
            success: success,
            critical: critical,
            dumpPath: dumpPath,
            dumpKept: dumpKept,
            dumpSizeBytes: dumpSize,
            dumpDurationMs: dumpResult.durationMs,
            statementResults: statementResults,
            restoreOk: restoreOk,
            restoreError: restoreResult.error,
            restoreStderr: restoreResult.stderr,
            restoreDurationMs: restoreResult.durationMs,
            failedAtIndex: failedAt
        };
    }

    private static _safeSize(filePath: string): number {
        try {
            return fs.statSync(filePath).size;
        } catch {
            return 0;
        }
    }

}