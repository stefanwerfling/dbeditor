/*
 * Integration test for the SQLite driver + introspector + executor pipeline.
 * Touches the filesystem (creates an actual SQLite DB in os.tmpdir()) and
 * exercises every diagram end-to-end, including the rebuild pattern for
 * column type changes. The other test files are pure-logic unit tests; this
 * one is the smoke that proves the pieces actually fit together.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {SqliteDriver} from '../../DbConnection/Drivers/SqliteDriver.js';
import {SqliteIntrospector} from '../../DbIntrospect/SqliteIntrospector.js';
import {SqliteDialect} from '../../DbGenerator/Dialects/SqliteDialect.js';
import {SchemaDiff} from '../../DbDiff/SchemaDiff.js';
import {SyncGenerator} from '../../DbGenerator/Sync/SyncGenerator.js';
import {SyncExecutor} from '../../DbSyncExecutor/SyncExecutor.js';
import {buildDialectContextFromModel} from '../../DbGenerator/DialectContextBuilder.js';
import {DbConnection} from '../../DbConnection/DbConnection.js';
import {DbProjectConnection} from '../../DbProject/DbProject.js';
import {JsonColumn, JsonDataDB, JsonIndex} from '../../DbEditor/JsonData.js';

let tmpDbPath = '';
let conn: DbConnection | null = null;

const cfgFor = (file: string): DbProjectConnection => ({
    databaseUnid: 'x',
    host: '',
    port: 0,
    user: '',
    password: '',
    database: file,
    ssl: false,
    readOnly: false
});

beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `dbed-sqlite-smoke-${process.pid}-${Date.now()}.db`);
});

afterEach(async() => {
    const c = conn;
    conn = null;
    if (c) {
        try {
            await c.close();
        } catch {
            /* swallow — teardown best-effort */
        }
    }
    if (tmpDbPath && fs.existsSync(tmpDbPath)) {
        fs.unlinkSync(tmpDbPath);
    }
});

describe('SQLite end-to-end sync pipeline', () => {

    it('introspect → diff(add column) → apply restores parity', async() => {
        conn = await new SqliteDriver().connect(cfgFor(tmpDbPath));
        await conn.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, name TEXT)');
        await conn.exec('CREATE UNIQUE INDEX uq_email ON users(email)');
        await conn.exec('INSERT INTO users(email,name) VALUES(\'a@b\',\'Alice\'),(\'c@d\',\'Carol\')');

        const intro = new SqliteIntrospector();
        const live = await intro.introspect(conn, 'main');

        /* Sanity: introspector saw what we created. */
        expect(live.tables).toHaveLength(1);
        const liveT = live.tables[0];
        expect(liveT.name).toBe('users');
        expect(liveT.columns.map(c => c.name)).toEqual(['id', 'email', 'name']);
        const idCol = liveT.columns.find(c => c.name === 'id');
        expect(idCol?.primaryKey).toBe(true);
        expect(idCol?.autoIncrement).toBe(true);
        expect(liveT.indexes.find(i => i.name === 'uq_email')?.type).toBe('unique');

        /* Build a model that's the live tree + a new `age` column. */
        const model: JsonDataDB = JSON.parse(JSON.stringify(live)) as JsonDataDB;
        model.unid = 'model-db';
        for (const t of model.tables) {
            t.unid = `mt-${t.name}`;
            for (const c of t.columns) {c.unid = `mc-${c.name}`;}
            for (const i of t.indexes) {
                i.unid = `mi-${i.name}`;
                for (const ic of i.columns) {
                    const liveCol = liveT.columns.find(lc => lc.unid === ic.columnUnid);
                    if (liveCol) {ic.columnUnid = `mc-${liveCol.name}`;}
                }
            }
        }
        model.tables[0].columns.push({
            unid: 'mc-age',
            name: 'age',
            type: 'int',
            notNull: true,
            defaultValue: '0'
        });

        const cs = SchemaDiff.diff(model, live, {ignoreTables: [], ignoreColumnAttributes: []});
        expect(cs.changes).toHaveLength(1);
        expect(cs.changes[0].kind).toBe('columnAdded');
        expect(cs.changes[0].columnName).toBe('age');

        const dialect = new SqliteDialect();
        const ctx = buildDialectContextFromModel(model, '  ', '', false);
        const statements = SyncGenerator.generate(cs, model, dialect, ctx);
        expect(statements).toHaveLength(1);
        expect(statements[0].sql).toBe('ALTER TABLE "users" ADD COLUMN "age" INTEGER NOT NULL DEFAULT 0');

        const results = await SyncExecutor.run(conn, statements);
        expect(results).toHaveLength(1);
        expect(results[0].ok).toBe(true);

        /* Re-introspect and diff again — should be 0 changes now. */
        const afterLive = await intro.introspect(conn, 'main');
        const csAfter = SchemaDiff.diff(model, afterLive, {ignoreTables: [], ignoreColumnAttributes: []});
        expect(csAfter.changes).toHaveLength(0);

        /* Existing rows survived the ADD COLUMN. */
        const rows = await conn.query('SELECT email, age FROM users ORDER BY email');
        expect(rows).toEqual([
            {email: 'a@b', age: 0},
            {email: 'c@d', age: 0}
        ]);
    });

    it('rebuild pattern: change column type preserves data + foreign keys', async() => {
        conn = await new SqliteDriver().connect(cfgFor(tmpDbPath));
        await conn.exec('CREATE TABLE org (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT)');
        await conn.exec(`CREATE TABLE acct (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            org_id INTEGER NOT NULL,
            balance TEXT NOT NULL,
            CONSTRAINT fk_acct_org FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE
        )`);
        await conn.exec('INSERT INTO org(code) VALUES(\'A\'),(\'B\')');
        await conn.exec('INSERT INTO acct(org_id, balance) VALUES(1,\'100\'),(1,\'250\'),(2,\'42\')');

        const intro = new SqliteIntrospector();
        const live = await intro.introspect(conn, 'main');
        const acct = live.tables.find(t => t.name === 'acct');
        if (!acct) {throw new Error('acct table not introspected');}
        expect(acct.foreignKeys).toHaveLength(1);
        expect(acct.columns.find(c => c.name === 'balance')?.type).toBe('text');

        /* Model: balance changes from TEXT to NUMERIC (decimal). */
        const dialect = new SqliteDialect();
        const oldBalance = acct.columns.find(c => c.name === 'balance')!;
        const newBalance: JsonColumn = {...oldBalance, type: 'decimal'};
        const modelTable = {
            ...acct,
            unid: 'mt-acct',
            columns: acct.columns.map(c => c.name === 'balance' ? newBalance : c).map(c => ({...c, unid: `mc-${c.name}`}))
        };
        modelTable.indexes = modelTable.indexes.map((i: JsonIndex) => ({
            ...i,
            unid: `mi-${i.name}`,
            columns: i.columns.map(ic => ({...ic, columnUnid: `mc-${acct.columns.find(c => c.unid === ic.columnUnid)?.name}`}))
        }));
        modelTable.foreignKeys = modelTable.foreignKeys.map(fk => ({
            ...fk,
            columns: fk.columns.map(fc => {
                const liveCol = acct.columns.find(c => c.unid === fc.columnUnid);
                return {...fc, columnUnid: liveCol ? `mc-${liveCol.name}` : fc.columnUnid};
            })
        }));

        const ctx = buildDialectContextFromModel({
            ...live,
            tables: live.tables.map(t => t.name === 'acct' ? modelTable : t)
        }, '  ', '', false);
        const sql = dialect.renderAlterTableChangeColumn(modelTable, oldBalance, newBalance, ctx);

        /*
         * Use the connection directly: the executor's `exec` strips semicolons
         * out of single statements, but the rebuild pattern is multi-statement.
         * better-sqlite3's Database.exec() handles chained DDL natively. 
         */
        await conn.exec(sql);

        /*
         * All rows survived the rebuild. SQLite's type affinity coerces
         * the previously-TEXT values to NUMERIC on read once the column
         * is declared NUMERIC, so we assert on the post-coercion numbers.
         */
        const rows = await conn.query('SELECT id, org_id, balance FROM acct ORDER BY id');
        expect(rows).toEqual([
            {id: 1, org_id: 1, balance: 100},
            {id: 2, org_id: 1, balance: 250},
            {id: 3, org_id: 2, balance: 42}
        ]);

        /* FK still enforced after rebuild — deleting parent cascades. */
        await conn.exec('DELETE FROM org WHERE id = 1');
        const remaining = await conn.query('SELECT id FROM acct ORDER BY id');
        expect(remaining).toEqual([{id: 3}]);
    });

});