/*
 * Unit test for the multi-schema scoping added in Iter 7. The
 * introspector inlines the schema name into its SQL query strings;
 * a fake `DbConnection` records every query so we can assert the
 * configured schema flows through to every `WHERE n.nspname / ...
 * schemaname = '<schema>'` clause.
 *
 * No live Postgres is exercised here — that's deferred until the user
 * has a real DB to test against. The fake just guarantees the queries
 * we send LOOK right.
 */
import {describe, expect, it} from 'vitest';
import {PostgresIntrospector} from '../../../BundledPlugins/Postgres/PostgresIntrospector.js';
import {DbConnection, DbRow} from '../../../editor_backend/DbConnection/DbConnection.js';

class RecordingConnection implements DbConnection {

    public readonly queries: string[] = [];

    public async query(sql: string): Promise<DbRow[]> {
        this.queries.push(sql);
        return [];
    }

    public async exec(sql: string): Promise<{affectedRows: number;}> {
        this.queries.push(sql);
        /* recording fake — no real rows affected */
        return {affectedRows: 0};
    }

    public async close(): Promise<void> {
        /* no-op for the recording fake */
    }

}

describe('PostgresIntrospector — schema scoping', () => {

    it('defaults to schema = public when none is supplied', async() => {
        const conn = new RecordingConnection();
        const intro = new PostgresIntrospector();
        await intro.introspect(conn, 'mydb');
        for (const q of conn.queries) {
            /*
             * Every query mentions either `nspname = 'public'`,
             * `schemaname = 'public'`, or `constraint_schema = 'public'`
             * — the join filter that scopes results to the target
             * schema. Confirm at least one such mention per query.
             */
            const mentions = /'public'/u.test(q);
            expect(mentions).toBe(true);
        }
        expect(conn.queries.length).toBeGreaterThan(0);
    });

    it('substitutes the configured schema into every query', async() => {
        const conn = new RecordingConnection();
        const intro = new PostgresIntrospector();
        await intro.introspect(conn, 'mydb', 'app');
        for (const q of conn.queries) {
            expect(q).toContain('\'app\'');
            expect(q).not.toContain('\'public\'');
        }
        expect(conn.queries.length).toBeGreaterThan(0);
    });

    it('rejects an unsafe schema name (SQL-injection guard)', async() => {
        const conn = new RecordingConnection();
        const intro = new PostgresIntrospector();
        await expect(intro.introspect(conn, 'mydb', 'x\'; DROP TABLE y; --')).rejects.toThrow(/unsafe schema name/u);
        /* No queries should have been issued before the guard fired. */
        expect(conn.queries.length).toBe(0);
    });

    it('accepts underscored + alphanumeric schema names', async() => {
        const conn = new RecordingConnection();
        const intro = new PostgresIntrospector();
        await intro.introspect(conn, 'mydb', '_legacy_audit_v2');
        for (const q of conn.queries) {
            expect(q).toContain('\'_legacy_audit_v2\'');
        }
    });

    it('rejects names starting with a digit (Postgres ident rule)', async() => {
        const conn = new RecordingConnection();
        const intro = new PostgresIntrospector();
        await expect(intro.introspect(conn, 'mydb', '2023_audit')).rejects.toThrow(/unsafe schema name/u);
    });

});