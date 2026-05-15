import * as path from 'path';
import Database from 'better-sqlite3';
import {DbProjectConnection} from '../../DbProject/DbProject.js';
import {DbConnection, DbDriver} from '../DbConnection.js';
import {SqliteConnection} from './SqliteConnection.js';

/**
 * SQLite driver. The "database" name is the file path — relative paths are
 * resolved against the project root via `process.env.DBEDITOR_PROJECT_ROOT`
 * if set, otherwise `process.cwd()`. The `host` / `port` / `user` /
 * `password` fields of `DbProjectConnection` are ignored.
 *
 * Sets `PRAGMA foreign_keys = ON` immediately after open — SQLite ships
 * with FK enforcement disabled per connection, and we want apply-side
 * referential integrity to behave like the other dialects.
 */
export class SqliteDriver implements DbDriver {

    public async connect(cfg: DbProjectConnection): Promise<DbConnection> {
        const root = process.env.DBEDITOR_PROJECT_ROOT ?? process.cwd();
        const file = path.isAbsolute(cfg.database) ? cfg.database : path.resolve(root, cfg.database);
        const db = new Database(file, {readonly: cfg.readOnly});
        db.pragma('foreign_keys = ON');
        return new SqliteConnection(db);
    }

}