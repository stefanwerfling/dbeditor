/*
 * Per-change tests for DbFsRepository.applyReverseSync. We don't build a real
 * DbFsRepository (that would require an on-disk project file) — instead we
 * construct a stub via a temp file and a minimal DbProject. Each `it` block
 * synthesises a model + live state for ONE change kind and asserts the
 * post-mutation model.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DbFsRepository} from '../../../editor_backend/DbRepository/DbFsRepository.js';
import {DbProject} from '../../../editor_backend/DbProject/DbProject.js';
import {ConfigDialect, ConfigOutputMode} from '../../../editor_backend/Config/Config.js';
import {SchemaChange, SchemaChangeKind} from '../../../editor_backend/DbDiff/ChangeTypes.js';
import {
    JsonColumn,
    JsonDataDB,
    JsonDataDBType,
    JsonForeignKey,
    JsonIndex,
    JsonIndexType,
    JsonTable,
    JsonView
} from '../../../DbEditor/JsonData.js';

let tmpFile = '';
let repo: DbFsRepository;

const projectFor = (file: string): DbProject => ({
    name: 'test',
    schemaPath: file,
    dialect: ConfigDialect.mysql,
    output: {
        mode: ConfigOutputMode.ddl_files,
        destinationPath: '/tmp/out',
        destinationClear: false,
        sqlComment: true,
        sqlIndent: '    ',
        statementTerminator: ';',
        migrationFilenamePattern: '{timestamp}__{name}'
    },
    autoGenerate: false,
    scripts_before_generate: [],
    scripts_after_generate: [],
    connections: [],
    sync: {ignoreTables: [], ignoreColumnAttributes: []}
});

const change = (kind: SchemaChangeKind, patch: Partial<SchemaChange> = {}): SchemaChange => ({
    id: `c-${kind}`,
    kind: kind,
    severity: 'safe',
    sql: [],
    ...patch
});

/* Seed the on-disk schema with one database containing the given tables/views. */
const seedSchema = (
    databaseUnid: string,
    tables: JsonTable[],
    views: JsonView[] = []
): void => {
    const data = {
        fs: {
            unid: 'root',
            name: 'root',
            type: JsonDataDBType.root,
            entrys: [{
                unid: databaseUnid,
                name: 'main',
                type: JsonDataDBType.database,
                istoggle: true,
                entrys: [],
                tables: tables,
                views: views,
                enums: []
            }],
            tables: [],
            views: [],
            enums: []
        },
        editor: {}
    };
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
};

const liveDb = (tables: JsonTable[], views: JsonView[] = []): JsonDataDB => ({
    unid: 'live:db:main',
    name: 'main',
    type: JsonDataDBType.database,
    entrys: [],
    tables: tables,
    views: views,
    enums: []
});

const liveTable = (name: string, columns: JsonColumn[], patch: Partial<JsonTable> = {}): JsonTable => ({
    unid: `live:t:main:${name}`,
    name: name,
    pos: {x: 0, y: 0},
    columns: columns,
    indexes: [],
    foreignKeys: [],
    ...patch
});

const liveColumn = (table: string, name: string, patch: Partial<JsonColumn> = {}): JsonColumn => ({
    unid: `live:c:main:${table}:${name}`,
    name: name,
    type: 'int',
    ...patch
});

const modelTable = (name: string, columns: JsonColumn[], patch: Partial<JsonTable> = {}): JsonTable => ({
    unid: `model-t-${name}`,
    name: name,
    pos: {x: 0, y: 0},
    columns: columns,
    indexes: [],
    foreignKeys: [],
    ...patch
});

const modelColumn = (name: string, patch: Partial<JsonColumn> = {}): JsonColumn => ({
    unid: `model-c-${name}`,
    name: name,
    type: 'int',
    ...patch
});

const DB_UNID = 'db-main';

beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `dbed-reverse-${process.pid}-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {fs.unlinkSync(tmpFile);}
});

describe('applyReverseSync — table-level changes', () => {

    it('tableAdded → drops table from model', () => {
        seedSchema(DB_UNID, [modelTable('users', [modelColumn('id', {primaryKey: true})])]);
        repo = new DbFsRepository(projectFor(tmpFile));

        const result = repo.applyReverseSync(
            DB_UNID,
            [change(SchemaChangeKind.tableAdded, {tableName: 'users'})],
            liveDb([]),
            null
        );

        expect(result.appliedChangeIds).toHaveLength(1);
        const dbNode = repo.data.fs.entrys[0] as JsonDataDB;
        expect(dbNode.tables).toHaveLength(0);
    });

    it('tableDropped → clones live table into model with fresh unids', () => {
        seedSchema(DB_UNID, []);
        repo = new DbFsRepository(projectFor(tmpFile));

        const liveT = liveTable('users', [
            liveColumn('users', 'id', {primaryKey: true, autoIncrement: true}),
            liveColumn('users', 'email', {type: 'varchar', length: '255', notNull: true})
        ]);
        const result = repo.applyReverseSync(
            DB_UNID,
            [change(SchemaChangeKind.tableDropped, {tableName: 'users', before: liveT})],
            liveDb([liveT]),
            null
        );

        expect(result.appliedChangeIds).toHaveLength(1);
        const dbNode = repo.data.fs.entrys[0] as JsonDataDB;
        expect(dbNode.tables).toHaveLength(1);
        const t = dbNode.tables[0];
        expect(t.name).toBe('users');
        expect(t.unid.startsWith('live:')).toBe(false);
        expect(t.columns.map(c => c.name)).toEqual(['id', 'email']);
        for (const c of t.columns) {expect(c.unid.startsWith('live:')).toBe(false);}
    });

    it('tableOptionsChanged → adopts live options', () => {
        seedSchema(DB_UNID, [modelTable('t', [modelColumn('id')], {options: {engine: 'InnoDB', charset: 'utf8'}})]);
        repo = new DbFsRepository(projectFor(tmpFile));

        const liveT = liveTable('t', [liveColumn('t', 'id')], {options: {engine: 'MyISAM', charset: 'latin1', comment: 'live'}});
        repo.applyReverseSync(
            DB_UNID,
            [change(SchemaChangeKind.tableOptionsChanged, {tableName: 't', before: liveT.options})],
            liveDb([liveT]),
            null
        );

        const dbNode = repo.data.fs.entrys[0] as JsonDataDB;
        expect(dbNode.tables[0].options).toEqual({engine: 'MyISAM', charset: 'latin1', comment: 'live'});
    });

});

describe('applyReverseSync — column-level changes', () => {

    it('columnAdded → drops column from model + cascades to indexes/FKs', () => {
        const emailCol = modelColumn('email', {type: 'varchar', length: '255'});
        const idCol = modelColumn('id', {primaryKey: true});
        const users = modelTable('users', [idCol, emailCol], {
            indexes: [{
                unid: 'model-i-email',
                name: 'idx_email',
                type: JsonIndexType.index,
                columns: [{columnUnid: emailCol.unid}]
            }]
        });
        seedSchema(DB_UNID, [users]);
        repo = new DbFsRepository(projectFor(tmpFile));

        repo.applyReverseSync(
            DB_UNID,
            [change(SchemaChangeKind.columnAdded, {tableName: 'users', columnName: 'email'})],
            liveDb([liveTable('users', [liveColumn('users', 'id', {primaryKey: true})])]),
            null
        );

        const dbNode = repo.data.fs.entrys[0] as JsonDataDB;
        const t = dbNode.tables[0];
        expect(t.columns.map(c => c.name)).toEqual(['id']);
        /* idx_email dropped because its only column went away */
        expect(t.indexes).toHaveLength(0);
    });

    it('columnDropped → adds column from live with fresh unid', () => {
        const users = modelTable('users', [modelColumn('id', {primaryKey: true})]);
        seedSchema(DB_UNID, [users]);
        repo = new DbFsRepository(projectFor(tmpFile));

        const liveColEmail = liveColumn('users', 'email', {type: 'varchar', length: '255', notNull: true});
        repo.applyReverseSync(
            DB_UNID,
            [change(SchemaChangeKind.columnDropped, {tableName: 'users', columnName: 'email', before: liveColEmail})],
            liveDb([liveTable('users', [liveColumn('users', 'id'), liveColEmail])]),
            null
        );

        const dbNode = repo.data.fs.entrys[0] as JsonDataDB;
        const t = dbNode.tables[0];
        expect(t.columns.map(c => c.name)).toEqual(['id', 'email']);
        const email = t.columns.find(c => c.name === 'email')!;
        expect(email.type).toBe('varchar');
        expect(email.length).toBe('255');
        expect(email.notNull).toBe(true);
        expect(email.unid.startsWith('live:')).toBe(false);
    });

    it('columnChanged → copies live attrs while preserving model unid', () => {
        const emailCol = modelColumn('email', {type: 'varchar', length: '64'});
        seedSchema(DB_UNID, [modelTable('users', [modelColumn('id', {primaryKey: true}), emailCol])]);
        repo = new DbFsRepository(projectFor(tmpFile));

        const originalUnid = emailCol.unid;
        const liveEmail = liveColumn('users', 'email', {type: 'varchar', length: '255', notNull: true});
        repo.applyReverseSync(
            DB_UNID,
            [change(SchemaChangeKind.columnChanged, {tableName: 'users', columnName: 'email', before: liveEmail})],
            liveDb([liveTable('users', [liveColumn('users', 'id'), liveEmail])]),
            null
        );

        const dbNode = repo.data.fs.entrys[0] as JsonDataDB;
        const email = dbNode.tables[0].columns.find(c => c.name === 'email')!;
        /* preserved through the change */
        expect(email.unid).toBe(originalUnid);
        expect(email.length).toBe('255');
        expect(email.notNull).toBe(true);
    });

});

describe('applyReverseSync — rename changes', () => {

    /*
     * Symmetric counterpart of forward-apply RENAME emission: reverse
     * adopts the live name into the model. The diff's rename hint
     * stored `change.tableName = model name (new)` and `change.before.name = live name (old)`.
     */
    it('tableRenamed → renames model table back to the live name', () => {
        seedSchema(DB_UNID, [modelTable('users_v2', [modelColumn('id', {primaryKey: true})])]);
        repo = new DbFsRepository(projectFor(tmpFile));

        const liveUsers = liveTable('users', [liveColumn('users', 'id', {primaryKey: true})]);
        const result = repo.applyReverseSync(
            DB_UNID,
            [change(SchemaChangeKind.tableRenamed, {
                tableName: 'users_v2',
                before: liveUsers,
                after: undefined
            })],
            liveDb([liveUsers]),
            null
        );

        expect(result.appliedChangeIds).toHaveLength(1);
        const dbNode = repo.data.fs.entrys[0] as JsonDataDB;
        expect(dbNode.tables[0].name).toBe('users');
    });

    it('columnRenamed → renames model column back to the live name', () => {
        seedSchema(DB_UNID, [modelTable('users', [
            modelColumn('id', {primaryKey: true}),
            modelColumn('email_new', {type: 'varchar', length: '255'})
        ])]);
        repo = new DbFsRepository(projectFor(tmpFile));

        const liveEmail = liveColumn('users', 'email_old', {type: 'varchar', length: '255'});
        const result = repo.applyReverseSync(
            DB_UNID,
            [change(SchemaChangeKind.columnRenamed, {
                tableName: 'users',
                columnName: 'email_new',
                before: liveEmail,
                after: undefined
            })],
            liveDb([liveTable('users', [liveColumn('users', 'id'), liveEmail])]),
            null
        );

        expect(result.appliedChangeIds).toHaveLength(1);
        const dbNode = repo.data.fs.entrys[0] as JsonDataDB;
        const cols = dbNode.tables[0].columns.map(c => c.name);
        expect(cols).toContain('email_old');
        expect(cols).not.toContain('email_new');
    });

    it('skips a rename whose target is missing in model', () => {
        seedSchema(DB_UNID, [modelTable('users', [modelColumn('id')])]);
        repo = new DbFsRepository(projectFor(tmpFile));

        const liveUsers = liveTable('users_old', [liveColumn('users_old', 'id')]);
        const result = repo.applyReverseSync(
            DB_UNID,
            [change(SchemaChangeKind.tableRenamed, {tableName: 'no_such_v2', before: liveUsers})],
            liveDb([liveUsers]),
            null
        );
        expect(result.appliedChangeIds).toEqual([]);
    });

});

describe('applyReverseSync — index / fk / view changes', () => {

    it('indexAdded → drops index from model', () => {
        const idCol = modelColumn('id', {primaryKey: true});
        seedSchema(DB_UNID, [modelTable('t', [idCol], {
            indexes: [{unid: 'mi', name: 'idx_x', type: JsonIndexType.index, columns: [{columnUnid: idCol.unid}]}]
        })]);
        repo = new DbFsRepository(projectFor(tmpFile));

        repo.applyReverseSync(
            DB_UNID,
            [change(SchemaChangeKind.indexAdded, {tableName: 't', indexName: 'idx_x'})],
            liveDb([liveTable('t', [liveColumn('t', 'id')])]),
            null
        );

        const dbNode = repo.data.fs.entrys[0] as JsonDataDB;
        expect(dbNode.tables[0].indexes).toHaveLength(0);
    });

    it('indexDropped → clones live index into model, remapping column unids by name', () => {
        const idCol = modelColumn('id', {primaryKey: true});
        const emailCol = modelColumn('email', {type: 'varchar', length: '255'});
        seedSchema(DB_UNID, [modelTable('users', [idCol, emailCol])]);
        repo = new DbFsRepository(projectFor(tmpFile));

        const liveIx: JsonIndex = {
            unid: 'live:i:main:users:idx_email',
            name: 'idx_email',
            type: JsonIndexType.unique,
            columns: [{columnUnid: 'live:c:main:users:email'}]
        };
        repo.applyReverseSync(
            DB_UNID,
            [change(SchemaChangeKind.indexDropped, {tableName: 'users', indexName: 'idx_email', before: liveIx})],
            liveDb([liveTable('users', [liveColumn('users', 'id'), liveColumn('users', 'email')], {indexes: [liveIx]})]),
            null
        );

        const dbNode = repo.data.fs.entrys[0] as JsonDataDB;
        const t = dbNode.tables[0];
        expect(t.indexes).toHaveLength(1);
        expect(t.indexes[0].name).toBe('idx_email');
        expect(t.indexes[0].type).toBe(JsonIndexType.unique);
        expect(t.indexes[0].columns[0].columnUnid).toBe(emailCol.unid);
    });

    it('fkDropped → clones live FK with remapped local + ref column unids', () => {
        const userIdCol = modelColumn('id', {primaryKey: true});
        const users = modelTable('users', [userIdCol]);
        const orderUserId = modelColumn('user_id');
        const orderId = modelColumn('id', {primaryKey: true});
        const orders = modelTable('orders', [orderId, orderUserId]);
        seedSchema(DB_UNID, [users, orders]);
        repo = new DbFsRepository(projectFor(tmpFile));

        const liveFk: JsonForeignKey = {
            unid: 'live:fk:main:orders:fk_user',
            name: 'fk_user',
            refTableUnid: 'live:t:main:users',
            columns: [{columnUnid: 'live:c:main:orders:user_id', refColumnUnid: 'live:c:main:users:id'}],
            onDelete: 'CASCADE'
        };
        repo.applyReverseSync(
            DB_UNID,
            [change(SchemaChangeKind.fkDropped, {tableName: 'orders', fkName: 'fk_user', before: liveFk})],
            liveDb([
                liveTable('users', [liveColumn('users', 'id')]),
                liveTable('orders', [liveColumn('orders', 'id'), liveColumn('orders', 'user_id')], {foreignKeys: [liveFk]})
            ]),
            null
        );

        const dbNode = repo.data.fs.entrys[0] as JsonDataDB;
        const ordersAfter = dbNode.tables.find(t => t.name === 'orders')!;
        expect(ordersAfter.foreignKeys).toHaveLength(1);
        const fk = ordersAfter.foreignKeys[0];
        expect(fk.name).toBe('fk_user');
        expect(fk.refTableUnid).toBe(users.unid);
        expect(fk.columns[0].columnUnid).toBe(orderUserId.unid);
        expect(fk.columns[0].refColumnUnid).toBe(userIdCol.unid);
    });

    it('viewDropped → adds view with fresh unid + default pos', () => {
        seedSchema(DB_UNID, []);
        repo = new DbFsRepository(projectFor(tmpFile));

        const liveView: JsonView = {
            unid: 'live:v:main:v_active',
            name: 'v_active',
            pos: {x: 99, y: 99},
            select: 'SELECT * FROM users'
        };
        repo.applyReverseSync(
            DB_UNID,
            [change(SchemaChangeKind.viewDropped, {viewName: 'v_active', before: liveView})],
            liveDb([], [liveView]),
            null
        );

        const dbNode = repo.data.fs.entrys[0] as JsonDataDB;
        expect(dbNode.views).toHaveLength(1);
        expect(dbNode.views[0].name).toBe('v_active');
        expect(dbNode.views[0].select).toBe('SELECT * FROM users');
        expect(dbNode.views[0].unid.startsWith('live:')).toBe(false);
    });

    it('viewChanged → adopts live select body while preserving model unid', () => {
        const liveSelectOld = 'SELECT 1';
        const liveSelectNew = 'SELECT id FROM users';
        seedSchema(DB_UNID, [], [{unid: 'mv-1', name: 'v_x', pos: {x: 10, y: 20}, select: liveSelectOld}]);
        repo = new DbFsRepository(projectFor(tmpFile));

        const liveView: JsonView = {unid: 'live:v:main:v_x', name: 'v_x', pos: {x: 0, y: 0}, select: liveSelectNew};
        repo.applyReverseSync(
            DB_UNID,
            [change(SchemaChangeKind.viewChanged, {viewName: 'v_x', before: liveView})],
            liveDb([], [liveView]),
            null
        );

        const dbNode = repo.data.fs.entrys[0] as JsonDataDB;
        /* unid + pos preserved through the change */
        expect(dbNode.views[0].unid).toBe('mv-1');
        expect(dbNode.views[0].pos).toEqual({x: 10, y: 20});
        expect(dbNode.views[0].select).toBe(liveSelectNew);
    });

});

describe('applyReverseSync — error paths', () => {

    it('returns appliedChangeIds = [] when the model database is missing', () => {
        seedSchema(DB_UNID, []);
        repo = new DbFsRepository(projectFor(tmpFile));

        expect(() => repo.applyReverseSync(
            'no-such-db',
            [change(SchemaChangeKind.tableAdded, {tableName: 'x'})],
            liveDb([]),
            null
        )).toThrow();
    });

    it('skips a change whose target object is missing in model', () => {
        seedSchema(DB_UNID, []);
        repo = new DbFsRepository(projectFor(tmpFile));

        const result = repo.applyReverseSync(
            DB_UNID,
            [change(SchemaChangeKind.columnChanged, {tableName: 'no-such-table', columnName: 'x'})],
            liveDb([]),
            null
        );
        expect(result.appliedChangeIds).toEqual([]);
    });

});