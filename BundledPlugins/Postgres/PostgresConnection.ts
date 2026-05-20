import type {Client} from 'pg';
import {DbConnection, DbExecResult, DbRow} from '../../editor_backend/DbConnection/DbConnection.js';

/**
 * Thin wrapper around `pg`'s `Client`. One sync-with-DB operation = one
 * client; the API route opens it, hands it to the executor, then closes
 * via `close()`.
 *
 * `pg.Client` exposes a single `query()` method (no separate prepare/execute
 * split like mysql2), so DDL and DML go through the same path.
 */
export class PostgresConnection implements DbConnection {

    private _client: Client | null;

    public constructor(client: Client) {
        this._client = client;
    }

    public async query(sql: string, params?: unknown[]): Promise<DbRow[]> {
        if (!this._client) {throw new Error('connection is closed');}
        const res = await this._client.query(sql, params as unknown[] | undefined);
        return (res.rows ?? []) as DbRow[];
    }

    public async exec(sql: string, params?: unknown[]): Promise<DbExecResult> {
        if (!this._client) {throw new Error('connection is closed');}
        /*
         * Multi-statement DDL strings (e.g. ALTER COLUMN that emits two
         * statements joined by `;`) are accepted as long as we don't bind
         * parameters — pg's protocol-level parameterised path supports only
         * a single statement. The sync executor never passes params for DDL.
         */
        const res = await this._client.query(sql, params as unknown[] | undefined);
        return {affectedRows: res.rowCount ?? 0};
    }

    public async close(): Promise<void> {
        if (!this._client) {return;}
        const c = this._client;
        this._client = null;
        await c.end();
    }

}