import * as path from 'path';
import Database from 'better-sqlite3';
import {DbConnectionPlugin} from '../../editor_core/plugin/DbConnectionPlugin.js';
import {DbIntrospector} from '../../DbIntrospect/DbIntrospector.js';
import {SqliteIntrospector} from '../../DbIntrospect/SqliteIntrospector.js';
import {DbProjectConnection} from '../../DbProject/DbProject.js';
import {DbConnection} from '../DbConnection.js';
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
export class SqliteDriver extends DbConnectionPlugin {

    public readonly id: string = 'sqlite';

    public readonly displayName: string = 'SQLite';

    public readonly supportedDialects: readonly string[] = ['sqlite'];

    public async connect(cfg: DbProjectConnection): Promise<DbConnection> {
        const root = process.env.DBEDITOR_PROJECT_ROOT ?? process.cwd();
        const file = path.isAbsolute(cfg.database) ? cfg.database : path.resolve(root, cfg.database);
        const db = new Database(file, {readonly: cfg.readOnly});
        db.pragma('foreign_keys = ON');
        return new SqliteConnection(db);
    }

    public introspector(): DbIntrospector {
        return new SqliteIntrospector();
    }

}