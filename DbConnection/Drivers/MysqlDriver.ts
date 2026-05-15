// eslint-disable-next-line import/extensions
import mysql from 'mysql2/promise';
import {DbProjectConnection} from '../../DbProject/DbProject.js';
import {DbConnection, DbDriver} from '../DbConnection.js';
import {MysqlConnection} from './MysqlConnection.js';

export class MysqlDriver implements DbDriver {

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

}