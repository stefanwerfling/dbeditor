import {DbProjectConnection} from '../../DbProject/DbProject.js';

/**
 * Result of a dump or restore operation.
 *
 * `ok=true` means the external process exited 0 and the dump file was
 * written (for dump) or completed reading (for restore). Anything else
 * is `ok=false` plus an `error` message — including spawn-time failures
 * (binary not on PATH) and non-zero exit codes with stderr captured.
 */
export type DumpRestoreResult = {
    ok: boolean;
    error?: string;
    /** Captured stderr output — useful for surfacing in the UI on failure. */
    stderr?: string;
    /** Wall-clock duration for the dump/restore. */
    durationMs: number;
};

/**
 * Dialect-agnostic adapter that snapshots a live database to a file and
 * later restores it from that file. Implementations shell out to the
 * native CLI tools — `mysqldump`/`mysql` for MySQL/MariaDB,
 * `pg_dump`/`psql` for Postgres, file-copy for SQLite. Each adapter
 * documents its own preconditions (which binaries must be on PATH,
 * which permissions the connection user needs).
 *
 * The adapter does NOT decide where to write the dump — the caller
 * (`SyncTestRunner`) computes the path based on project config so we
 * can reuse the same adapter from other contexts (e.g. a manual
 * "Backup now" affordance) without baking a path convention into the
 * adapter.
 */
export interface DumpAdapter {

    /**
     * Snapshot the connection's database to `dumpPath`. The path's
     * parent directory must already exist (caller's responsibility).
     * On success the file at `dumpPath` is a self-contained backup
     * that `restore` can replay verbatim.
     */
    dump(cfg: DbProjectConnection, dumpPath: string): Promise<DumpRestoreResult>;

    /**
     * Replay the file at `dumpPath` against the live DB referenced by
     * `cfg`. Implementations are expected to drop and recreate the
     * target database where possible so the post-restore state
     * matches the pre-dump state exactly (this is what makes a
     * "test run" safe).
     */
    restore(cfg: DbProjectConnection, dumpPath: string): Promise<DumpRestoreResult>;

}