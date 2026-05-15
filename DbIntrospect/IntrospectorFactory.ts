import {ConfigDialect} from '../Config/Config.js';
import {DbIntrospector} from './DbIntrospector.js';
import {MysqlIntrospector} from './MysqlIntrospector.js';
import {PostgresIntrospector} from './PostgresIntrospector.js';
import {SqliteIntrospector} from './SqliteIntrospector.js';

/**
 * Returns the introspector matching the dialect. MariaDB shares MySQL's
 * `information_schema` shape. All four dialects are now wired.
 */
export const pickIntrospector = (dialect: string): DbIntrospector => {
    switch ((dialect || '').toLowerCase()) {
        case ConfigDialect.mysql:
        case ConfigDialect.mariadb:
            return new MysqlIntrospector();
        case ConfigDialect.postgres:
            return new PostgresIntrospector();
        case ConfigDialect.sqlite:
            return new SqliteIntrospector();
        default:
            throw new Error(`unknown dialect: ${dialect}`);
    }
};