import {DbConnection} from '../DbConnection/DbConnection.js';
import {SyncStatement} from '../DbGenerator/Sync/SyncGenerator.js';

/**
 * One statement's outcome. `ok=false` means the driver threw — `error` then
 * carries the message. `durationMs` is wall-clock for the single exec(),
 * useful for surfacing slow statements in the dialog log.
 */
export type SyncStatementResult = {
    changeId: string;
    sql: string;
    ok: boolean;
    error?: string;
    durationMs: number;
};

export type SyncExecutorOptions = {
    /**
     * If true, wraps the whole batch in `BEGIN; ... ROLLBACK;` so the user can
     * preview server-side behaviour without persisting. Note MySQL DDL is not
     * truly transactional — most DDL implicitly commits — so dry-run only
     * works as expected on Postgres / SQLite. The wrapping is still emitted
     * on MySQL because callers should not rely on DRY_RUN being a no-op for
     * DDL there; the option is documented as best-effort.
     */
    dryRun?: boolean;
};

/**
 * Statement-by-statement DDL executor. The caller hands us an open
 * `DbConnection` (we don't open or close it ourselves — connection lifetime
 * stays at the API-route level) plus a pre-ordered `SyncStatement[]`.
 *
 * Behaviour:
 *   - Execute in input order (caller already sorted by bucket).
 *   - On the first error, abort. `results[]` carries every attempted
 *     statement, last entry has `ok=false`; statements after the failure
 *     are NOT appended.
 *   - `dryRun=true` emits `BEGIN` first and `ROLLBACK` last so the server
 *     can roll the batch back. Failures still abort, and a `ROLLBACK` is
 *     attempted in the `finally` block regardless of where we failed.
 */
export class SyncExecutor {

    public static async run(
        conn: DbConnection,
        statements: SyncStatement[],
        options: SyncExecutorOptions = {}
    ): Promise<SyncStatementResult[]> {
        const results: SyncStatementResult[] = [];
        const dryRun = options.dryRun === true;

        if (dryRun) {
            try {
                await conn.exec('BEGIN');
            } catch (err) {
                /*
                 * If we can't even start a transaction the batch is dead in
                 * the water — surface a single failing pseudo-result so the
                 * caller doesn't see an empty success.
                 */
                results.push({
                    changeId: '__begin__',
                    sql: 'BEGIN',
                    ok: false,
                    error: (err as Error).message,
                    durationMs: 0
                });
                return results;
            }
        }

        try {
            for (const s of statements) {
                const startedAt = Date.now();
                try {
                    /*
                     * Sequential execution is required: each statement may
                     * depend on the previous one (drop FK before drop col,
                     * etc.) and a single failure aborts the batch.
                     */
                    // eslint-disable-next-line no-await-in-loop
                    await conn.exec(s.sql);
                    results.push({
                        changeId: s.changeId,
                        sql: s.sql,
                        ok: true,
                        durationMs: Date.now() - startedAt
                    });
                } catch (err) {
                    results.push({
                        changeId: s.changeId,
                        sql: s.sql,
                        ok: false,
                        error: (err as Error).message,
                        durationMs: Date.now() - startedAt
                    });
                    break;
                }
            }
        } finally {
            if (dryRun) {
                /*
                 * Always roll back the dry-run frame, even if a statement
                 * failed. The rollback's own failure is logged into the
                 * results so the UI can see it but we don't throw.
                 */
                try {
                    await conn.exec('ROLLBACK');
                } catch (err) {
                    results.push({
                        changeId: '__rollback__',
                        sql: 'ROLLBACK',
                        ok: false,
                        error: (err as Error).message,
                        durationMs: 0
                    });
                }
            }
        }
        return results;
    }

}