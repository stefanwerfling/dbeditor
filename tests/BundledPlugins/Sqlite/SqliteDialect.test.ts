import {describe, expect, it} from 'vitest';
import {SqliteDialect} from '../../../BundledPlugins/Sqlite/SqliteDialect.js';
import {DialectContext} from '../../../editor_backend/DbGenerator/DbDialect.js';
import {DialectContextBuilder} from '../../../editor_backend/DbGenerator/DialectContextBuilder.js';
import {
    JsonColumn,
    JsonDataDB,
    JsonDataDBType,
    JsonEnum,
    JsonForeignKey,
    JsonIndex,
    JsonIndexType,
    JsonTable,
    JsonView
} from '../../../editor_frontend/DbEditor/JsonData.js';

const col = (name: string, patch: Partial<JsonColumn> = {}): JsonColumn => ({
    unid: `col-${name}`,
    name: name,
    type: 'int',
    ...patch
});

const table = (
    name: string,
    columns: JsonColumn[],
    patch: Partial<JsonTable> = {}
): JsonTable => ({
    unid: `tbl-${name}`,
    name: name,
    pos: {x: 0, y: 0},
    columns: columns,
    indexes: [],
    foreignKeys: [],
    options: undefined,
    ...patch
});

const db = (tables: JsonTable[], enums: JsonEnum[] = []): JsonDataDB => ({
    unid: 'db-test',
    name: 'test',
    type: JsonDataDBType.database,
    entrys: [],
    tables: tables,
    views: [],
    enums: enums
});

const ctxFor = (tables: JsonTable[], enums: JsonEnum[] = []): DialectContext =>
    DialectContextBuilder.fromModel(db(tables, enums), '    ', ';', true);

describe('SqliteDialect.quote', () => {

    const d = new SqliteDialect();

    it('wraps identifier in double quotes', () => {
        expect(d.quote('users')).toBe('"users"');
    });

    it('escapes embedded double quotes', () => {
        expect(d.quote('a"b')).toBe('"a""b"');
    });

});

describe('SqliteDialect.mapColumnType', () => {

    const d = new SqliteDialect();
    const ctx = ctxFor([]);

    it('collapses every integer variant onto INTEGER', () => {
        for (const t of ['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'bool', 'boolean']) {
            expect(d.mapColumnType(col('c', {type: t}), ctx)).toBe('INTEGER');
        }
    });

    it('collapses every text/char/json/uuid/datetime variant onto TEXT', () => {
        for (const t of ['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'json', 'uuid', 'enum', 'date', 'time', 'datetime', 'timestamp']) {
            expect(d.mapColumnType(col('c', {type: t}), ctx)).toBe('TEXT');
        }
    });

    it('maps float/double to REAL and decimal/numeric to NUMERIC', () => {
        expect(d.mapColumnType(col('c', {type: 'float'}), ctx)).toBe('REAL');
        expect(d.mapColumnType(col('c', {type: 'double'}), ctx)).toBe('REAL');
        expect(d.mapColumnType(col('c', {type: 'decimal'}), ctx)).toBe('NUMERIC');
        expect(d.mapColumnType(col('c', {type: 'numeric'}), ctx)).toBe('NUMERIC');
    });

    it('maps blob variants onto BLOB', () => {
        for (const t of ['blob', 'longblob', 'binary', 'varbinary']) {
            expect(d.mapColumnType(col('c', {type: t}), ctx)).toBe('BLOB');
        }
    });

    it('passes unknown types through uppercased', () => {
        expect(d.mapColumnType(col('c', {type: 'geometry'}), ctx)).toBe('GEOMETRY');
    });

});

describe('SqliteDialect.renderCreateTable', () => {

    const d = new SqliteDialect();

    it('renders PRIMARY KEY AUTOINCREMENT inline for AI+PK column', () => {
        const t = table('users', [
            col('id', {type: 'int', primaryKey: true, autoIncrement: true, notNull: true}),
            col('email', {type: 'varchar', length: '255', notNull: true})
        ]);
        const sql = d.renderCreateTable(t, ctxFor([t]));
        expect(sql).toContain('"id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT');
        expect(sql).toContain('"email" TEXT NOT NULL');
        /* table-level PK row only emitted for composite/non-autoinc PK */
        expect(sql).not.toContain('PRIMARY KEY ("id")');
    });

    it('emits table-level PRIMARY KEY clause for composite / non-AI PKs', () => {
        const t = table('t', [
            col('a', {primaryKey: true}),
            col('b', {primaryKey: true})
        ]);
        const sql = d.renderCreateTable(t, ctxFor([t]));
        expect(sql).toContain('PRIMARY KEY ("a", "b")');
    });

    it('renders enum as TEXT + CHECK constraint inline', () => {
        const e: JsonEnum = {
            unid: 'enum-status',
            name: 'status',
            pos: {x: 0, y: 0},
            values: [{unid: 'v1', value: 'a'}, {unid: 'v2', value: 'b'}]
        };
        const t = table('t', [col('s', {type: 'enum', enumRef: 'enum-status'})]);
        const sql = d.renderCreateTable(t, ctxFor([t], [e]));
        expect(sql).toContain('"s" TEXT CHECK ("s" IN (\'a\', \'b\'))');
    });

    it('inlines FOREIGN KEY constraints (no separate ALTER)', () => {
        const users = table('users', [col('id', {primaryKey: true})]);
        const fk: JsonForeignKey = {
            unid: 'fk1',
            name: 'fk_user',
            refTableUnid: 'tbl-users',
            columns: [{columnUnid: 'col-user_id', refColumnUnid: 'col-id'}],
            onDelete: 'CASCADE'
        };
        const orders = table('orders', [col('user_id')], {foreignKeys: [fk]});
        const sql = d.renderCreateTable(orders, ctxFor([users, orders]));
        expect(sql).toContain('CONSTRAINT "fk_user" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE');
    });

});

describe('SqliteDialect.renderCreateIndex', () => {

    const d = new SqliteDialect();

    it('renders plain + unique index', () => {
        const t = table('t', [col('a')]);
        const plain: JsonIndex = {unid: 'i', name: 'idx', type: JsonIndexType.index, columns: [{columnUnid: 'col-a'}]};
        expect(d.renderCreateIndex(t, plain, ctxFor([t])))
        .toBe('CREATE INDEX "idx" ON "t" ("a")');
        const uq: JsonIndex = {unid: 'i2', name: 'uq', type: JsonIndexType.unique, columns: [{columnUnid: 'col-a'}]};
        expect(d.renderCreateIndex(t, uq, ctxFor([t])))
        .toBe('CREATE UNIQUE INDEX "uq" ON "t" ("a")');
    });

    it('renders DESC + partial WHERE', () => {
        const t = table('t', [col('a')]);
        const ix: JsonIndex = {
            unid: 'i',
            name: 'p',
            type: JsonIndexType.index,
            columns: [{columnUnid: 'col-a', order: 'DESC'}],
            where: 'deleted_at IS NULL'
        };
        expect(d.renderCreateIndex(t, ix, ctxFor([t])))
        .toBe('CREATE INDEX "p" ON "t" ("a" DESC) WHERE deleted_at IS NULL');
    });

});

describe('SqliteDialect non-applicable renderers return null', () => {

    const d = new SqliteDialect();

    it('renderAddForeignKey returns null (handled inline)', () => {
        const t = table('t', [col('a')]);
        const fk: JsonForeignKey = {unid: 'f', name: 'fk', refTableUnid: 'x', columns: []};
        expect(d.renderAddForeignKey(t, fk, ctxFor([t]))).toBeNull();
    });

    it('renderCreateEnum / renderDropEnum return null (SQLite has no enums)', () => {
        const e: JsonEnum = {unid: 'e', name: 's', pos: {x: 0, y: 0}, values: []};
        expect(d.renderCreateEnum(e, ctxFor([]))).toBeNull();
        expect(d.renderDropEnum(e, ctxFor([]))).toBeNull();
    });

    it('renderAlterTableOptions always returns null', () => {
        const t = table('t', [col('a')], {options: {engine: 'foo', tablespace: 'bar'}});
        expect(d.renderAlterTableOptions(t, ctxFor([t]))).toBeNull();
    });

});

describe('SqliteDialect view renderers', () => {

    const d = new SqliteDialect();

    const view = (select: string): JsonView => ({
        unid: 'v',
        name: 'v_active',
        pos: {x: 0, y: 0},
        select: select
    });

    it('CREATE VIEW chained after DROP IF EXISTS for renderCreateView', () => {
        const sql = d.renderCreateView(view('SELECT 1'), ctxFor([]));
        expect(sql).toBe('DROP VIEW IF EXISTS "v_active";\nCREATE VIEW "v_active" AS\nSELECT 1');
    });

    it('renderReplaceView mirrors renderCreateView', () => {
        const sql = d.renderReplaceView(view('SELECT 9'), ctxFor([]));
        expect(sql).toBe('DROP VIEW IF EXISTS "v_active";\nCREATE VIEW "v_active" AS\nSELECT 9');
    });

    it('renderDropView returns DROP VIEW IF EXISTS', () => {
        expect(d.renderDropView(view('SELECT 1'), ctxFor([]))).toBe('DROP VIEW IF EXISTS "v_active"');
    });

});

describe('SqliteDialect ALTER renderers (native + rebuild)', () => {

    const d = new SqliteDialect();

    it('renders ADD COLUMN natively', () => {
        const t = table('users', [col('email', {type: 'varchar', length: '255', notNull: true})]);
        expect(d.renderAlterTableAddColumn(t, t.columns[0], ctxFor([t])))
        .toBe('ALTER TABLE "users" ADD COLUMN "email" TEXT NOT NULL');
    });

    it('renders DROP COLUMN natively (SQLite >= 3.35)', () => {
        const t = table('users', [col('email')]);
        expect(d.renderAlterTableDropColumn(t, t.columns[0], ctxFor([t])))
        .toBe('ALTER TABLE "users" DROP COLUMN "email"');
    });

    it('CHANGE COLUMN emits the canonical rebuild pattern with FK-pragma wrap', () => {
        const oldCol = col('email', {type: 'varchar', length: '64', notNull: true});
        const newCol = col('email', {type: 'varchar', length: '255', notNull: true});
        const t = table('users', [
            col('id', {type: 'int', primaryKey: true, autoIncrement: true}),
            newCol
        ]);
        const sql = d.renderAlterTableChangeColumn(t, oldCol, newCol, ctxFor([t]));
        expect(sql).toContain('PRAGMA foreign_keys = OFF');
        expect(sql).toContain('BEGIN TRANSACTION');
        expect(sql).toContain('CREATE TABLE "users__dbed_tmp__"');
        expect(sql).toContain('"email" TEXT NOT NULL');
        expect(sql).toContain('INSERT INTO "users__dbed_tmp__" ("id", "email") SELECT "id", "email" FROM "users"');
        expect(sql).toContain('DROP TABLE "users"');
        expect(sql).toContain('ALTER TABLE "users__dbed_tmp__" RENAME TO "users"');
        expect(sql).toContain('COMMIT');
        expect(sql).toContain('PRAGMA foreign_keys = ON');
    });

    it('CHANGE COLUMN preserves remaining foreign keys in the rebuilt table', () => {
        const users = table('users', [col('id', {primaryKey: true})]);
        const fk: JsonForeignKey = {
            unid: 'f',
            name: 'fk_user',
            refTableUnid: 'tbl-users',
            columns: [{columnUnid: 'col-user_id', refColumnUnid: 'col-id'}]
        };
        const oldCol = col('amount', {type: 'int'});
        const newCol = col('amount', {type: 'bigint'});
        const orders = table('orders', [
            col('id', {type: 'int', primaryKey: true, autoIncrement: true}),
            col('user_id'),
            newCol
        ], {foreignKeys: [fk]});
        const sql = d.renderAlterTableChangeColumn(orders, oldCol, newCol, ctxFor([users, orders]));
        expect(sql).toContain('CONSTRAINT "fk_user" FOREIGN KEY ("user_id") REFERENCES "users" ("id")');
    });

    it('DROP FOREIGN KEY rebuilds the table without the named FK', () => {
        const users = table('users', [col('id', {primaryKey: true})]);
        const kept: JsonForeignKey = {
            unid: 'f1',
            name: 'fk_keep',
            refTableUnid: 'tbl-users',
            columns: [{columnUnid: 'col-keep_id', refColumnUnid: 'col-id'}]
        };
        const dropped: JsonForeignKey = {
            unid: 'f2',
            name: 'fk_drop',
            refTableUnid: 'tbl-users',
            columns: [{columnUnid: 'col-drop_id', refColumnUnid: 'col-id'}]
        };
        const t = table('orders', [
            col('id', {type: 'int', primaryKey: true, autoIncrement: true}),
            col('keep_id'),
            col('drop_id')
        ], {foreignKeys: [kept, dropped]});
        const sql = d.renderDropForeignKey(t, 'fk_drop', ctxFor([users, t]));
        expect(sql).toContain('CONSTRAINT "fk_keep"');
        expect(sql).not.toContain('CONSTRAINT "fk_drop"');
        expect(sql).toContain('PRAGMA foreign_keys = OFF');
        expect(sql).toContain('PRAGMA foreign_keys = ON');
    });

});