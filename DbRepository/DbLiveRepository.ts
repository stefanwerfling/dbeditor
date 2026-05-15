import {DbProject, DbProjectConnection} from '../DbProject/DbProject.js';
import {DbConnection} from '../DbConnection/DbConnection.js';
import {pickDriver} from '../DbConnection/DriverFactory.js';
import {pickIntrospector} from '../DbIntrospect/IntrospectorFactory.js';
import {JsonDataDB} from '../DbEditor/JsonData.js';
import {DbRepositoryEventBus} from './DbRepositoryEventBus.js';

export type DbLiveSnapshot = {
    /** Map of `databaseUnid` (as defined in `project.connections[]`) → live tree. */
    byDatabaseUnid: Record<string, JsonDataDB>;
    /** Map of `databaseUnid` → last-error string if introspection failed. */
    errors: Record<string, string>;
    /** Monotonic counter — clients use it to dedupe SSE replay. */
    rev: number;
};

/**
 * Holds the latest introspected `JsonDataDB` tree per live-DB connection of
 * one project. The repo is lazy: nothing is fetched until `refresh()` is
 * called for a given `databaseUnid`. Re-running `refresh()` reconnects,
 * re-introspects, replaces the cached tree, and emits an event on the bus.
 *
 * The bus is intentionally separate from the model `DbFsRepository.bus` —
 * live events are a different domain and the frontend subscribes to them on
 * a dedicated SSE channel.
 */
export class DbLiveRepository {

    private readonly _project: DbProject;
    private readonly _bus = new DbRepositoryEventBus();
    private readonly _byDatabaseUnid = new Map<string, JsonDataDB>();
    private readonly _errors = new Map<string, string>();
    private _rev = 0;

    public constructor(project: DbProject) {
        this._project = project;
    }

    public get project(): DbProject { return this._project; }
    public get bus(): DbRepositoryEventBus { return this._bus; }
    public get rev(): number { return this._rev; }

    public snapshot(): DbLiveSnapshot {
        const byDatabaseUnid: Record<string, JsonDataDB> = {};
        for (const [k, v] of this._byDatabaseUnid.entries()) {byDatabaseUnid[k] = v;}
        const errors: Record<string, string> = {};
        for (const [k, v] of this._errors.entries()) {errors[k] = v;}
        return {byDatabaseUnid: byDatabaseUnid, errors: errors, rev: this._rev};
    }

    public getConnectionConfig(databaseUnid: string): DbProjectConnection | undefined {
        return this._project.connections.find(c => c.databaseUnid === databaseUnid);
    }

    public getLiveTree(databaseUnid: string): JsonDataDB | undefined {
        return this._byDatabaseUnid.get(databaseUnid);
    }

    /**
     * Reconnect + re-introspect a single database. Returns the newly cached
     * tree (or throws). On success, emits a `live:refreshed` event with the
     * `databaseUnid` so SSE subscribers can pull the updated snapshot.
     */
    public async refresh(databaseUnid: string): Promise<JsonDataDB> {
        const cfg = this.getConnectionConfig(databaseUnid);
        if (!cfg) {
            throw new Error(`no connection configured for databaseUnid "${databaseUnid}"`);
        }
        const driver = pickDriver(this._project.dialect);
        const introspector = pickIntrospector(this._project.dialect);
        let conn: DbConnection | null = null;
        try {
            conn = await driver.connect(cfg);
            const tree = await introspector.introspect(conn, cfg.database, cfg.schema);
            this._byDatabaseUnid.set(databaseUnid, tree);
            this._errors.delete(databaseUnid);
            this._rev++;
            this._bus.publish({
                rev: this._rev,
                op: 'live:refreshed',
                clientId: null,
                body: {databaseUnid: databaseUnid}
            });
            return tree;
        } catch (err) {
            this._errors.set(databaseUnid, (err as Error).message);
            this._rev++;
            this._bus.publish({
                rev: this._rev,
                op: 'live:error',
                clientId: null,
                body: {databaseUnid: databaseUnid, message: (err as Error).message}
            });
            throw err;
        } finally {
            if (conn) {
                try { await conn.close(); } catch (e) { console.error('[DbLiveRepository] close failed:', e); }
            }
        }
    }

    /**
     * Pings the live DB with a no-op query to confirm credentials and
     * reachability. Returns true on success, throws on failure.
     *
     * `patch` overrides individual fields of the saved connection
     * config for THIS call only — nothing is persisted. Used by the
     * EditConnectionDialog so the user can test a host/port change
     * with the stored password without re-entering it (the server
     * never sends the saved password back to the client; it can only
     * be reused server-side).
     */
    public async testConnection(databaseUnid: string, patch?: Partial<{
        host: string;
        port: number;
        user: string;
        password: string;
        database: string;
        ssl: boolean;
    }>): Promise<boolean> {
        const saved = this.getConnectionConfig(databaseUnid);
        if (!saved) {
            throw new Error(`no connection configured for databaseUnid "${databaseUnid}"`);
        }
        const cfg = {...saved};
        if (patch) {
            if (patch.host !== undefined) {cfg.host = patch.host;}
            if (patch.port !== undefined) {cfg.port = patch.port;}
            if (patch.user !== undefined) {cfg.user = patch.user;}
            if (patch.password !== undefined) {cfg.password = patch.password;}
            if (patch.database !== undefined) {cfg.database = patch.database;}
            if (patch.ssl !== undefined) {cfg.ssl = patch.ssl;}
        }
        const driver = pickDriver(this._project.dialect);
        const conn = await driver.connect(cfg);
        try {
            await conn.query('SELECT 1');
            return true;
        } finally {
            await conn.close();
        }
    }

}