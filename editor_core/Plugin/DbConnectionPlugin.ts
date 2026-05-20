import {DbProjectConnection} from '../../editor_backend/DbProject/DbProject.js';
import {DbConnection, DbDriver} from '../../editor_backend/DbConnection/DbConnection.js';
import {DbIntrospector} from '../../editor_backend/DbIntrospect/DbIntrospector.js';
import {DumpAdapter} from '../../editor_backend/DbSyncExecutor/DumpAdapters/DumpAdapter.js';
import {Plugin} from './Plugin.js';
import {PluginKind} from './PluginKind.js';

/**
 * Abstract base for live-database connection plugins.
 *
 * Mirrors the `DialectPlugin` pattern: bridges the legacy `DbDriver`
 * interface with the plugin system. The Sync-with-DB executor and the
 * apply / introspect routes still consume `DbDriver`-shaped values, so
 * a `DbConnectionPlugin` *is* a `DbDriver` (structurally) plus the
 * plugin identity fields.
 *
 * One plugin advertises which dialect ids it can serve via
 * `supportedDialects`. The MySQL driver covers both `mysql` and
 * `mariadb` (same wire protocol), while Postgres and SQLite each cover
 * a single dialect.
 *
 * Resolution at the call site is by *dialect id*, not plugin id, since
 * the rest of the codebase carries the dialect on the project (not the
 * driver). `PluginRegistry.dbConnectionForDialect()` looks up the first
 * registered plugin whose `supportedDialects` includes the requested id.
 */
export abstract class DbConnectionPlugin extends Plugin implements DbDriver {

    public readonly kind: PluginKind = PluginKind.DbConnection;

    /** Dialect ids this driver can connect against (lowercase, no leading dot). */
    public abstract readonly supportedDialects: readonly string[];

    public abstract connect(cfg: DbProjectConnection): Promise<DbConnection>;

    /**
     * Returns the introspector paired with this driver. Sync-with-DB calls
     * `connect()` then `introspector().introspect(conn, ...)` — both halves
     * always run against the same dialect, so the pairing lives on the
     * plugin rather than in a parallel factory.
     */
    public abstract introspector(): DbIntrospector;

    /**
     * Returns the dump/restore adapter paired with this driver, or `null`
     * if the dialect doesn't support test-run snapshots yet (Postgres /
     * SQLite this iteration). Callers translate `null` into a 501
     * "not yet implemented" response.
     */
    public dumpAdapter(): DumpAdapter | null {
        return null;
    }

}