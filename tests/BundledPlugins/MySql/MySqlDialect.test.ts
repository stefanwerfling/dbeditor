import {describe, expect, it} from 'vitest';
import {MySqlDialect} from '../../../BundledPlugins/MySql/MySqlDialect.js';
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
    JsonTableOptions,
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

describe('MySqlDialect.quote', () => {

    const d = new MySqlDialect();

    it('wraps identifier in backticks', () => {
        expect(d.quote('users')).toBe('`users`');
    });

    it('doubles existing backticks', () => {
        expect(d.quote('a`b')).toBe('`a``b`');
    });

});

describe('MySqlDialect.mapColumnType', () => {

    const d = new MySqlDialect();
    const ctx = ctxFor([]);

    it('maps int variants', () => {
        expect(d.mapColumnType(col('c', {type: 'int', length: '11'}), ctx)).toBe('INT(11)');
        expect(d.mapColumnType(col('c', {type: 'integer'}), ctx)).toBe('INT');
        expect(d.mapColumnType(col('c', {type: 'bigint'}), ctx)).toBe('BIGINT');
    });

    it('forces boolean to TINYINT(1)', () => {
        expect(d.mapColumnType(col('c', {type: 'boolean', length: '99'}), ctx)).toBe('TINYINT(1)');
        expect(d.mapColumnType(col('c', {type: 'bool'}), ctx)).toBe('TINYINT(1)');
    });

    it('supplies a default varchar length when missing', () => {
        expect(d.mapColumnType(col('c', {type: 'varchar'}), ctx)).toBe('VARCHAR(255)');
        expect(d.mapColumnType(col('c', {type: 'varchar', length: '64'}), ctx)).toBe('VARCHAR(64)');
    });

    it('renders uuid as CHAR(36)', () => {
        expect(d.mapColumnType(col('c', {type: 'uuid'}), ctx)).toBe('CHAR(36)');
    });

    it('renders decimal with default precision if length missing', () => {
        expect(d.mapColumnType(col('c', {type: 'decimal'}), ctx)).toBe('DECIMAL(10,0)');
        expect(d.mapColumnType(col('c', {type: 'decimal', length: '8,2'}), ctx)).toBe('DECIMAL(8,2)');
    });

    it('inlines enum values from the enum referenced by unid', () => {
        const e: JsonEnum = {
            unid: 'enum-status',
            name: 'status',
            pos: {x: 0, y: 0},
            values: [
                {unid: 'v1', value: 'active'},
                {unid: 'v2', value: 'with\'quote'}
            ]
        };
        const ctxWithEnum = ctxFor([], [e]);
        const c = col('status', {type: 'enum', enumRef: 'enum-status'});
        expect(d.mapColumnType(c, ctxWithEnum)).toBe('ENUM(\'active\', \'with\'\'quote\')');
    });

    it('falls back to VARCHAR(64) for enum type without a resolvable enum', () => {
        expect(d.mapColumnType(col('c', {type: 'enum'}), ctx)).toBe('VARCHAR(64)');
        expect(d.mapColumnType(col('c', {type: 'enum', enumRef: 'missing'}), ctx)).toBe('VARCHAR(64)');
    });

    it('passes unknown types through uppercased', () => {
        expect(d.mapColumnType(col('c', {type: 'point'}), ctx)).toBe('POINT');
        expect(d.mapColumnType(col('c', {type: 'point', length: '4'}), ctx)).toBe('POINT(4)');
    });

});

describe('MySqlDialect.renderCreateTable', () => {

    const d = new MySqlDialect();

    it('emits PK / NOT NULL / AUTO_INCREMENT for a typical id column', () => {
        const t = table('users', [
            col('id', {type: 'int', primaryKey: true, notNull: true, autoIncrement: true, unsigned: true}),
            col('email', {type: 'varchar', length: '255', notNull: true})
        ]);
        const sql = d.renderCreateTable(t, ctxFor([t]));
        expect(sql).toContain('CREATE TABLE `users` (');
        expect(sql).toContain('`id` INT UNSIGNED NOT NULL AUTO_INCREMENT');
        expect(sql).toContain('`email` VARCHAR(255) NOT NULL');
        expect(sql).toContain('PRIMARY KEY (`id`)');
    });

    it('emits inline UNIQUE but suppresses it on PK columns', () => {
        const t = table('t', [
            col('id', {primaryKey: true, unique: true}),
            col('slug', {type: 'varchar', length: '50', unique: true})
        ]);
        const sql = d.renderCreateTable(t, ctxFor([t]));
        expect(sql).toContain('`slug` VARCHAR(50) NULL UNIQUE');
        expect(sql).not.toContain('`id` INT NULL UNIQUE');
    });

    it('emits NULL / DEFAULT / COMMENT', () => {
        const t = table('t', [
            col('label', {type: 'varchar', length: '32', defaultValue: '\'n/a\'', comment: 'a label'})
        ]);
        const sql = d.renderCreateTable(t, ctxFor([t]));
        expect(sql).toContain('`label` VARCHAR(32) NULL DEFAULT \'n/a\' COMMENT \'a label\'');
    });

    it('appends table options', () => {
        const opts: JsonTableOptions = {
            engine: 'InnoDB',
            charset: 'utf8mb4',
            collation: 'utf8mb4_unicode_ci',
            comment: 'core'
        };
        const t = table('t', [col('id', {primaryKey: true})], {options: opts});
        const sql = d.renderCreateTable(t, ctxFor([t]));
        expect(sql).toContain('ENGINE=InnoDB');
        expect(sql).toContain('DEFAULT CHARSET=utf8mb4');
        expect(sql).toContain('COLLATE=utf8mb4_unicode_ci');
        expect(sql).toContain('COMMENT=\'core\'');
    });

    it('inlines an enum reference into the column type', () => {
        const e: JsonEnum = {
            unid: 'enum-status',
            name: 'status',
            pos: {x: 0, y: 0},
            values: [{unid: 'v1', value: 'a'}, {unid: 'v2', value: 'b'}]
        };
        const t = table('t', [col('status', {type: 'enum', enumRef: 'enum-status', notNull: true})]);
        const sql = d.renderCreateTable(t, ctxFor([t], [e]));
        expect(sql).toContain('`status` ENUM(\'a\', \'b\') NOT NULL');
    });

});

describe('MySqlDialect.renderCreateIndex', () => {

    const d = new MySqlDialect();

    it('renders a plain index', () => {
        const t = table('users', [col('email', {type: 'varchar', length: '255'})]);
        const ix: JsonIndex = {
            unid: 'i1',
            name: 'idx_email',
            type: JsonIndexType.index,
            columns: [{columnUnid: 'col-email'}]
        };
        expect(d.renderCreateIndex(t, ix, ctxFor([t])))
        .toBe('CREATE INDEX `idx_email` ON `users` (`email`)');
    });

    it('renders a unique index', () => {
        const t = table('users', [col('email')]);
        const ix: JsonIndex = {
            unid: 'i1',
            name: 'uq_email',
            type: JsonIndexType.unique,
            columns: [{columnUnid: 'col-email'}]
        };
        expect(d.renderCreateIndex(t, ix, ctxFor([t])))
        .toBe('CREATE UNIQUE INDEX `uq_email` ON `users` (`email`)');
    });

    it('renders a fulltext index via ALTER TABLE', () => {
        const t = table('docs', [col('body')]);
        const ix: JsonIndex = {
            unid: 'i1',
            name: 'ft_body',
            type: JsonIndexType.fulltext,
            columns: [{columnUnid: 'col-body'}]
        };
        expect(d.renderCreateIndex(t, ix, ctxFor([t])))
        .toBe('ALTER TABLE `docs` ADD FULLTEXT INDEX `ft_body` (`body`)');
    });

    it('emits DESC and prefix length per index column', () => {
        const t = table('t', [col('a'), col('b')]);
        const ix: JsonIndex = {
            unid: 'i1',
            name: 'idx_ab',
            type: JsonIndexType.index,
            columns: [
                {columnUnid: 'col-a', length: 8, order: 'DESC'},
                {columnUnid: 'col-b'}
            ]
        };
        expect(d.renderCreateIndex(t, ix, ctxFor([t])))
        .toBe('CREATE INDEX `idx_ab` ON `t` (`a`(8) DESC, `b`)');
    });

    it('returns null for an empty column list', () => {
        const t = table('t', [col('a')]);
        const ix: JsonIndex = {unid: 'i1', name: 'empty', type: JsonIndexType.index, columns: []};
        expect(d.renderCreateIndex(t, ix, ctxFor([t]))).toBeNull();
    });

});

describe('MySqlDialect.renderAddForeignKey', () => {

    const d = new MySqlDialect();

    it('emits a single-column FK with ON DELETE/UPDATE', () => {
        const users = table('users', [col('id', {primaryKey: true})]);
        const orders = table('orders', [col('user_id')]);
        const fk: JsonForeignKey = {
            unid: 'fk1',
            name: 'fk_user',
            refTableUnid: 'tbl-users',
            columns: [{columnUnid: 'col-user_id', refColumnUnid: 'col-id'}],
            onDelete: 'CASCADE',
            onUpdate: 'NO ACTION'
        };
        const sql = d.renderAddForeignKey(orders, fk, ctxFor([users, orders]));
        expect(sql).toBe(
            'ALTER TABLE `orders` ADD CONSTRAINT `fk_user` ' +
            'FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ' +
            'ON DELETE CASCADE ON UPDATE NO ACTION'
        );
    });

    it('returns null when the referenced table is missing', () => {
        const orders = table('orders', [col('user_id')]);
        const fk: JsonForeignKey = {
            unid: 'fk1',
            name: 'fk_user',
            refTableUnid: 'tbl-nonexistent',
            columns: [{columnUnid: 'col-user_id', refColumnUnid: 'col-id'}]
        };
        expect(d.renderAddForeignKey(orders, fk, ctxFor([orders]))).toBeNull();
    });

    it('omits ON DELETE / ON UPDATE when not set', () => {
        const users = table('users', [col('id')]);
        const orders = table('orders', [col('user_id')]);
        const fk: JsonForeignKey = {
            unid: 'fk1',
            name: 'fk_user',
            refTableUnid: 'tbl-users',
            columns: [{columnUnid: 'col-user_id', refColumnUnid: 'col-id'}]
        };
        const sql = d.renderAddForeignKey(orders, fk, ctxFor([users, orders]));
        expect(sql).not.toContain('ON DELETE');
        expect(sql).not.toContain('ON UPDATE');
    });

});

describe('MySqlDialect ALTER renderers (sync path)', () => {

    const d = new MySqlDialect();

    it('renders ADD COLUMN', () => {
        const t = table('users', [col('email', {type: 'varchar', length: '255', notNull: true})]);
        const ctx = ctxFor([t]);
        const sql = d.renderAlterTableAddColumn(t, t.columns[0], ctx);
        expect(sql).toBe('ALTER TABLE `users` ADD COLUMN `email` VARCHAR(255) NOT NULL');
    });

    it('renders DROP COLUMN', () => {
        const t = table('users', [col('email')]);
        expect(d.renderAlterTableDropColumn(t, t.columns[0], ctxFor([t])))
        .toBe('ALTER TABLE `users` DROP COLUMN `email`');
    });

    it('renders CHANGE COLUMN as MODIFY (no rename in v1)', () => {
        const t = table('users', [col('email', {type: 'varchar', length: '512', notNull: true})]);
        const sql = d.renderAlterTableChangeColumn(t, t.columns[0], t.columns[0], ctxFor([t]));
        expect(sql).toBe('ALTER TABLE `users` MODIFY COLUMN `email` VARCHAR(512) NOT NULL');
    });

    it('renders DROP FOREIGN KEY by name (back-tick quoted)', () => {
        const t = table('orders', [col('id')]);
        expect(d.renderDropForeignKey(t, 'fk_user', ctxFor([t])))
        .toBe('ALTER TABLE `orders` DROP FOREIGN KEY `fk_user`');
    });

    it('renders ALTER OPTIONS for non-empty options, null otherwise', () => {
        const ctx = ctxFor([]);
        const empty = table('t', [col('id')], {options: undefined});
        expect(d.renderAlterTableOptions(empty, ctx)).toBeNull();

        const opts: JsonTableOptions = {engine: 'InnoDB', charset: 'utf8mb4'};
        const t = table('t', [col('id')], {options: opts});
        expect(d.renderAlterTableOptions(t, ctx))
        .toBe('ALTER TABLE `t` ENGINE=InnoDB, DEFAULT CHARSET=utf8mb4');
    });

    it('renders RENAME TABLE via the multi-rename form', () => {
        expect(d.renderRenameTable('users', 'users_v2', ctxFor([])))
        .toBe('RENAME TABLE `users` TO `users_v2`');
    });

    it('renders RENAME COLUMN using MySQL 8+ syntax (no type re-spec)', () => {
        const t = table('users', [col('email_new', {type: 'varchar', length: '255'})]);
        expect(d.renderRenameColumn(t, 'email_old', t.columns[0], ctxFor([t])))
        .toBe('ALTER TABLE `users` RENAME COLUMN `email_old` TO `email_new`');
    });

});

describe('MySqlDialect view renderers', () => {

    const d = new MySqlDialect();

    const view = (select: string): JsonView => ({
        unid: 'v1',
        name: 'v_active',
        pos: {x: 0, y: 0},
        select: select
    });

    it('renders CREATE OR REPLACE VIEW for non-empty body', () => {
        const sql = d.renderCreateView(view('SELECT * FROM users WHERE active = 1'), ctxFor([]));
        expect(sql).toBe('CREATE OR REPLACE VIEW `v_active` AS\nSELECT * FROM users WHERE active = 1');
    });

    it('returns null for an empty select body', () => {
        expect(d.renderCreateView(view('   '), ctxFor([]))).toBeNull();
    });

    it('renderReplaceView mirrors renderCreateView for MySQL', () => {
        const v = view('SELECT 1');
        expect(d.renderReplaceView(v, ctxFor([]))).toBe(d.renderCreateView(v, ctxFor([])));
    });

    it('renders DROP VIEW', () => {
        expect(d.renderDropView(view('SELECT 1'), ctxFor([])))
        .toBe('DROP VIEW IF EXISTS `v_active`');
    });

});

describe('MySqlDialect drop renderers', () => {

    const d = new MySqlDialect();

    it('DROP TABLE IF EXISTS', () => {
        const t = table('users', [col('id')]);
        expect(d.renderDropTable(t, ctxFor([t]))).toBe('DROP TABLE IF EXISTS `users`');
    });

    it('DROP INDEX ... ON ...', () => {
        const t = table('users', [col('email')]);
        const ix: JsonIndex = {
            unid: 'i1',
            name: 'idx_email',
            type: JsonIndexType.index,
            columns: [{columnUnid: 'col-email'}]
        };
        expect(d.renderDropIndex(t, ix, ctxFor([t]))).toBe('DROP INDEX `idx_email` ON `users`');
    });

    it('renderCreateEnum / renderDropEnum return null (MySQL inlines)', () => {
        const e: JsonEnum = {unid: 'e', name: 'x', pos: {x: 0, y: 0}, values: []};
        expect(d.renderCreateEnum(e, ctxFor([]))).toBeNull();
        expect(d.renderDropEnum(e, ctxFor([]))).toBeNull();
    });

});