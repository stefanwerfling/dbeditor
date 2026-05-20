// eslint-disable-next-line import/extensions
import {Connection, FieldPacket, RowDataPacket, ResultSetHeader} from 'mysql2/promise';
import {DbConnection, DbExecResult, DbRow} from '../../DbConnection/DbConnection.js';

/**
 * Thin wrapper around `mysql2/promise`'s `Connection`. Lifetime is one
 * sync operation — created by `MysqlDriver.connect()` and torn down by
 * the caller via `close()`.
 */
export class MysqlConnection implements DbConnection {

    private _conn: Connection | null;

    public constructor(conn: Connection) {
        this._conn = conn;
    }

    public async query(sql: string, params?: unknown[]): Promise<DbRow[]> {
        if (!this._conn) {throw new Error('connection is closed');}
        const [rows] = await this._conn.query<RowDataPacket[]>(sql, params ?? []);
        return rows as DbRow[];
    }

    public async exec(sql: string, params?: unknown[]): Promise<DbExecResult> {
        if (!this._conn) {throw new Error('connection is closed');}
        /*
         * mysql2's `execute` prepares statements, which fails for many DDL
         * forms — `query` is the safe path for ALTER / CREATE / DROP.
         */
        const result = await this._conn.query<ResultSetHeader | RowDataPacket[]>(sql, params ?? []) as [
            ResultSetHeader | RowDataPacket[],
            FieldPacket[]
        ];
        const head = result[0];
        const affected = Array.isArray(head) ? 0 : head.affectedRows ?? 0;
        return {affectedRows: affected};
    }

    public async close(): Promise<void> {
        if (!this._conn) {return;}
        const c = this._conn;
        this._conn = null;
        await c.end();
    }

}