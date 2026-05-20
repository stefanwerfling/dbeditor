import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DbFsRepository} from '../../../editor_backend/DbRepository/DbFsRepository.js';
import {DbProject} from '../../../editor_backend/DbProject/DbProject.js';
import {ConfigDialect, ConfigOutputMode} from '../../../editor_backend/Config/Config.js';
import {
    JsonColumn,
    JsonDataDB,
    JsonDataDBType,
    JsonForeignKey,
    JsonIndex,
    JsonIndexType,
    JsonTable
} from '../../../editor_schemas/JsonData.js';

let tmpFile = '';
const DB_UNID = 'db-main';

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

const seed = (tables: JsonTable[]): void => {
    const data = {
        fs: {
            unid: 'root',
            name: 'root',
            type: JsonDataDBType.root,
            entrys: [{
                unid: DB_UNID,
                name: 'main',
                type: JsonDataDBType.database,
                istoggle: true,
                entrys: [],
                tables: tables,
                views: [],
                enums: []
            }],
            tables: [],
            views: [],
            enums: []
        },
        editor: {}
    };
    fs.writeFileSync(tmpFile, JSON.stringify(data));
};

const col = (unid: string, name: string, patch: Partial<JsonColumn> = {}): JsonColumn => ({
    unid: unid,
    name: name,
    type: 'int',
    ...patch
});

const table = (unid: string, name: string, columns: JsonColumn[], patch: Partial<JsonTable> = {}): JsonTable => ({
    unid: unid,
    name: name,
    pos: {x: 0, y: 0},
    columns: columns,
    indexes: [],
    foreignKeys: [],
    ...patch
});

beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `dbed-duplicate-${process.pid}-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {fs.unlinkSync(tmpFile);}
});

const dbNode = (repo: DbFsRepository): JsonDataDB => repo.data.fs.entrys[0] as JsonDataDB;

describe('DbFsRepository.duplicateTable', () => {

    it('creates a sibling with _copy suffix and fresh unids', () => {
        seed([table('t-orig', 'users', [
            col('c-id', 'id', {primaryKey: true}),
            col('c-email', 'email', {type: 'varchar', length: '255'})
        ])]);
        const repo = new DbFsRepository(projectFor(tmpFile));
        const res = repo.duplicateTable('t-orig', null);

        expect(res.table.name).toBe('users_copy');
        expect(res.table.unid).not.toBe('t-orig');
        expect(res.table.columns.map(c => c.unid)).not.toContain('c-id');
        expect(res.table.columns.map(c => c.unid)).not.toContain('c-email');
        expect(res.table.columns.map(c => c.name)).toEqual(['id', 'email']);
        expect(res.table.pos).toEqual({x: 40, y: 40});

        const db = dbNode(repo);
        expect(db.tables.map(t => t.name)).toEqual(['users', 'users_copy']);
    });

    it('falls back to _copy_2 / _copy_3 on name collisions', () => {
        seed([
            table('t-1', 'users', [col('c-id', 'id')]),
            table('t-2', 'users_copy', [col('c-id-2', 'id')])
        ]);
        const repo = new DbFsRepository(projectFor(tmpFile));
        const r1 = repo.duplicateTable('t-1', null);
        expect(r1.table.name).toBe('users_copy_2');

        const r2 = repo.duplicateTable('t-1', null);
        expect(r2.table.name).toBe('users_copy_3');
    });

    it('remaps index columnUnids to the new columns', () => {
        const idCol = col('c-id', 'id', {primaryKey: true});
        const emailCol = col('c-email', 'email', {type: 'varchar', length: '255'});
        const ix: JsonIndex = {
            unid: 'i-1',
            name: 'idx_email',
            type: JsonIndexType.index,
            columns: [{columnUnid: emailCol.unid}]
        };
        seed([table('t-1', 'users', [idCol, emailCol], {indexes: [ix]})]);
        const repo = new DbFsRepository(projectFor(tmpFile));
        const res = repo.duplicateTable('t-1', null);

        const newEmailUnid = res.table.columns.find(c => c.name === 'email')!.unid;
        expect(res.table.indexes).toHaveLength(1);
        expect(res.table.indexes[0].columns[0].columnUnid).toBe(newEmailUnid);
        expect(res.table.indexes[0].unid).not.toBe('i-1');
    });

    it('remaps local FK columnUnids and PRESERVES cross-table refColumnUnid', () => {
        const userIdCol = col('c-user-id', 'id', {primaryKey: true});
        const users = table('t-users', 'users', [userIdCol]);
        const orderUserCol = col('c-order-uid', 'user_id');
        const orderFk: JsonForeignKey = {
            unid: 'fk-1',
            name: 'fk_user',
            refTableUnid: users.unid,
            columns: [{columnUnid: orderUserCol.unid, refColumnUnid: userIdCol.unid}]
        };
        const orders = table('t-orders', 'orders', [
            col('c-order-id', 'id', {primaryKey: true}),
            orderUserCol
        ], {foreignKeys: [orderFk]});
        seed([users, orders]);
        const repo = new DbFsRepository(projectFor(tmpFile));
        const res = repo.duplicateTable('t-orders', null);

        const fk = res.table.foreignKeys[0];
        const newUserIdCol = res.table.columns.find(c => c.name === 'user_id')!.unid;
        expect(fk.unid).not.toBe('fk-1');
        expect(fk.refTableUnid).toBe('t-users');
        expect(fk.columns[0].columnUnid).toBe(newUserIdCol);
        /* refColumnUnid stays — target table not duplicated */
        expect(fk.columns[0].refColumnUnid).toBe('c-user-id');
    });

    it('the duplicate shows up in the undo stack', () => {
        seed([table('t-1', 'x', [col('c-1', 'a')])]);
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(repo.canUndo).toBe(false);
        repo.duplicateTable('t-1', null);
        expect(dbNode(repo).tables).toHaveLength(2);
        expect(repo.canUndo).toBe(true);

        repo.undo(null);
        expect(dbNode(repo).tables).toHaveLength(1);
        expect(dbNode(repo).tables[0].name).toBe('x');
    });

    it('publishes a table.duplicate event with the new table', () => {
        seed([table('t-1', 'x', [])]);
        const repo = new DbFsRepository(projectFor(tmpFile));
        const events: {op: string; body: unknown;}[] = [];
        repo.bus.subscribe(ev => events.push({op: ev.op, body: ev.body}));

        repo.duplicateTable('t-1', null);
        const dup = events.find(e => e.op === 'table.duplicate');
        expect(dup).toBeDefined();
        const body = dup!.body as {sourceUnid: string; table: JsonTable;};
        expect(body.sourceUnid).toBe('t-1');
        expect(body.table.name).toBe('x_copy');
    });

    it('throws RepoNotFoundError for unknown table unid', () => {
        seed([]);
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(() => repo.duplicateTable('missing', null)).toThrow();
    });

});