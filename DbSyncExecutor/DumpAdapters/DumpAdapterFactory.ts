import {ConfigDialect} from '../../Config/Config.js';
import {DumpAdapter} from './DumpAdapter.js';
import {MysqlDumpAdapter} from './MysqlDumpAdapter.js';

/**
 * Pick a `DumpAdapter` for the project's dialect. Only MySQL/MariaDB
 * are implemented this iteration — Postgres and SQLite throw a clear
 * "not yet supported" error rather than returning a stub, so the
 * route can surface that as a 501 to the UI instead of silently
 * doing nothing.
 */
export const pickDumpAdapter = (dialect: string): DumpAdapter => {
    switch ((dialect || '').toLowerCase()) {
        case ConfigDialect.mysql:
        case ConfigDialect.mariadb:
            return new MysqlDumpAdapter();
        case ConfigDialect.postgres:
        case ConfigDialect.sqlite:
            throw new Error(`dump/restore not yet implemented for dialect "${dialect}" — only MySQL/MariaDB this iteration`);
        default:
            throw new Error(`unknown dialect for dump/restore: ${dialect}`);
    }
};