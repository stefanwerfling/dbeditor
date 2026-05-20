import type {Database} from 'better-sqlite3';
import {DbConnection, DbExecResult, DbRow} from '../../DbConnection/DbConnection.js';

/**
 * Thin wrapper around `better-sqlite3`'s `Database` (sync). We adapt the
 * sync API to the async `DbConnection` contract — every call resolves
 * immediately. `better-sqlite3` throws on error; we let it propagate so
 * the executor records it as a statement failure like any other driver.
 *
 * Multi-statement strings: `Database.exec()` handles them; `prepare(...).run()`
 * does not. We use `.exec()` for DDL that may contain multiple statements
 * separated by `;` (the rebuild-pattern emits a small batch).
 */
export class SqliteConnection implements DbConnection {

    private _db: Database | null;

    public constructor(db: Database) {
        this._db = db;
    }

    public async query(sql: string, params?: unknown[]): Promise<DbRow[]> {
        if (!this._db) {throw new Error('connection is closed');}
        const stmt = this._db.prepare(sql);
        const rows = params && params.length ? stmt.all(...params) : stmt.all();
        return rows as DbRow[];
    }

    public async exec(sql: string, params?: unknown[]): Promise<DbExecResult> {
        if (!this._db) {throw new Error('connection is closed');}
        if (params && params.length) {
            /*
             * Single statement with parameters — go through prepare/run. The
             * sync executor never binds parameters for DDL, so this branch
             * is mostly here for symmetry with the other drivers.
             */
            const stmt = this._db.prepare(sql);
            const info = stmt.run(...params);
            return {affectedRows: Number(info.changes ?? 0)};
        }
        /*
         * No params: `Database.exec()` lets us send chained statements
         * (e.g. `PRAGMA foreign_keys=OFF; BEGIN; ...; COMMIT;`) as a
         * single call. It returns void; we report `0` affected rows.
         */
        this._db.exec(sql);
        return {affectedRows: 0};
    }

    public async close(): Promise<void> {
        if (!this._db) {return;}
        const d = this._db;
        this._db = null;
        d.close();
    }

}