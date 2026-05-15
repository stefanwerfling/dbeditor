import {ConfigDialect} from '../Config/Config.js';
import {DbDriver} from './DbConnection.js';
import {MysqlDriver} from './Drivers/MysqlDriver.js';
import {PostgresDriver} from './Drivers/PostgresDriver.js';
import {SqliteDriver} from './Drivers/SqliteDriver.js';

/**
 * Returns the appropriate driver for a dialect. All four dialects are now
 * wired end-to-end.
 */
export const pickDriver = (dialect: string): DbDriver => {
    switch ((dialect || '').toLowerCase()) {
        case ConfigDialect.mysql:
        case ConfigDialect.mariadb:
            return new MysqlDriver();
        case ConfigDialect.postgres:
            return new PostgresDriver();
        case ConfigDialect.sqlite:
            return new SqliteDriver();
        default:
            throw new Error(`unknown dialect: ${dialect}`);
    }
};