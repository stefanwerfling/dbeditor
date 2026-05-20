// eslint-disable-next-line import/extensions
import mysql from 'mysql2/promise';
import {DbConnectionPlugin} from '../../editor_core/plugin/DbConnectionPlugin.js';
import {MysqlIntrospector} from './MysqlIntrospector.js';
import {DbIntrospector} from '../../editor_backend/DbIntrospect/DbIntrospector.js';
import {DbProjectConnection} from '../../editor_backend/DbProject/DbProject.js';
import {DumpAdapter} from '../../editor_backend/DbSyncExecutor/DumpAdapters/DumpAdapter.js';
import {MysqlDumpAdapter} from './MysqlDumpAdapter.js';
import {DbConnection} from '../../editor_backend/DbConnection/DbConnection.js';
import {MysqlConnection} from './MysqlConnection.js';

/**
 * MySQL / MariaDB live-connection driver. Both dialects share the same wire
 * protocol, so a single plugin covers them via `supportedDialects`.
 */
export class MysqlDriver extends DbConnectionPlugin {

    public readonly id: string = 'mysql';

    public readonly displayName: string = 'MySQL / MariaDB';

    public readonly supportedDialects: readonly string[] = ['mysql', 'mariadb'];

    public async connect(cfg: DbProjectConnection): Promise<DbConnection> {
        const conn = await mysql.createConnection({
            host: cfg.host,
            port: cfg.port,
            user: cfg.user,
            password: cfg.password || undefined,
            database: cfg.database,
            ssl: cfg.ssl ? {} : undefined,
            /*
             * Multiple statements are needed so `apply` can submit a whole
             * sync changeset in one round-trip when called that way; the
             * sync executor still splits statement-by-statement for error
             * reporting, so this is just a safety net.
             */
            multipleStatements: false,
            dateStrings: true
        });
        return new MysqlConnection(conn);
    }

    public introspector(): DbIntrospector {
        return new MysqlIntrospector();
    }

    public override dumpAdapter(): DumpAdapter {
        return new MysqlDumpAdapter();
    }

}