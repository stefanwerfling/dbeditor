import {ConfigDialect} from '../Config/Config.js';
import {DbDialect} from './DbDialect.js';
import {MySqlDialect} from './Dialects/MySqlDialect.js';
import {MariaDbDialect} from './Dialects/MariaDbDialect.js';
import {PostgresDialect} from './Dialects/PostgresDialect.js';
import {SqliteDialect} from './Dialects/SqliteDialect.js';

export const pickDialect = (name: string): DbDialect => {
    switch ((name || '').toLowerCase()) {
        case ConfigDialect.mysql:    return new MySqlDialect();
        case ConfigDialect.mariadb:  return new MariaDbDialect();
        case ConfigDialect.postgres: return new PostgresDialect();
        case ConfigDialect.sqlite:   return new SqliteDialect();
        default: throw new Error(`unknown dialect: ${name}`);
    }
};