import {DbProjectConnection} from '../DbProject/DbProject.js';

/**
 * Abstract row shape returned by `query`. Each driver normalises its native
 * row representation to a plain object keyed by column name.
 */
export type DbRow = Record<string, unknown>;

/**
 * Result of a single statement execution. `affectedRows` is best-effort —
 * some drivers don't report it for every statement kind.
 */
export type DbExecResult = {
    affectedRows: number;
};

/**
 * One open connection to a live database. Lifetime is bound to a single
 * sync operation — callers should `close()` when done. Implementations are
 * thin wrappers around the native driver and intentionally expose only the
 * surface needed by the introspector / sync executor.
 */
export interface DbConnection {

    /** Run a query and return all rows. Use only for SELECT-shaped statements. */
    query(sql: string, params?: unknown[]): Promise<DbRow[]>;

    /** Run a non-result statement (DDL / DML). Returns affected-row info. */
    exec(sql: string, params?: unknown[]): Promise<DbExecResult>;

    /** Closes the underlying connection. Safe to call multiple times. */
    close(): Promise<void>;

}

/**
 * Driver factory + lightweight metadata.
 */
export interface DbDriver {

    /** Open a new connection using the resolved project connection config. */
    connect(cfg: DbProjectConnection): Promise<DbConnection>;

}