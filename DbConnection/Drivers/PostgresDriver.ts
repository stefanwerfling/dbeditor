import pg from 'pg';
import {DbProjectConnection} from '../../DbProject/DbProject.js';
import {DbConnection, DbDriver} from '../DbConnection.js';
import {PostgresConnection} from './PostgresConnection.js';

const {Client} = pg;

/**
 * Postgres driver. `pg` is a default-export CJS module — we import it as the
 * whole namespace and pull `Client` off it so this file works both under
 * Node's ESM resolver and the typings.
 *
 * SSL: pg accepts a full SSLOption; for the simple "yes/no" config we have
 * we emit `{rejectUnauthorized: false}` for `ssl: true`. The CA-cert path
 * is out of scope for iter 3 — call sites with strict TLS needs can fall
 * back to a `connectionString` in a later polish iteration.
 */
export class PostgresDriver implements DbDriver {

    public async connect(cfg: DbProjectConnection): Promise<DbConnection> {
        const client = new Client({
            host: cfg.host,
            port: cfg.port,
            user: cfg.user,
            password: cfg.password || undefined,
            database: cfg.database,
            ssl: cfg.ssl ? {rejectUnauthorized: false} : undefined
        });
        await client.connect();
        return new PostgresConnection(client);
    }

}