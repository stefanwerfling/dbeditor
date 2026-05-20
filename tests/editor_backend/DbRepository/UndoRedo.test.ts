/*
 * Undo/Redo on DbFsRepository. Snapshot strategy: every `_commit` pushes a
 * deep clone of the current data; `undo` pops, restores predecessor, and
 * stashes the popped state on the redo stack. A fresh mutation after undo
 * clears the redo stack.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DbFsRepository} from '../../../editor_backend/DbRepository/DbFsRepository.js';
import {DbProject} from '../../../editor_backend/DbProject/DbProject.js';
import {ConfigDialect, ConfigOutputMode} from '../../../editor_backend/Config/Config.js';
import {JsonDataDB, JsonDataDBType} from '../../../editor_schemas/JsonData.js';

let tmpFile = '';

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

const DB_UNID = 'db-main';

const seed = (containerUnid: string): void => {
    const data = {
        fs: {
            unid: 'root',
            name: 'root',
            type: JsonDataDBType.root,
            entrys: [{
                unid: containerUnid,
                name: 'main',
                type: JsonDataDBType.database,
                istoggle: true,
                entrys: [],
                tables: [],
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

beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `dbed-undo-${process.pid}-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {fs.unlinkSync(tmpFile);}
});

const tableCount = (repo: DbFsRepository): number => {
    const db = repo.data.fs.entrys[0] as JsonDataDB;
    return db.tables.length;
};

describe('DbFsRepository undo/redo', () => {

    it('initial state has nothing to undo or redo', () => {
        seed(DB_UNID);
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(repo.canUndo).toBe(false);
        expect(repo.canRedo).toBe(false);
    });

    it('after one mutation: canUndo=true, canRedo=false', () => {
        seed(DB_UNID);
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.createTable(DB_UNID, 'users', null, null);
        expect(repo.canUndo).toBe(true);
        expect(repo.canRedo).toBe(false);
    });

    it('undo restores the pre-mutation state', () => {
        seed(DB_UNID);
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.createTable(DB_UNID, 'users', null, null);
        expect(tableCount(repo)).toBe(1);

        const r = repo.undo(null);
        expect(r.applied).toBe(true);
        expect(tableCount(repo)).toBe(0);
        expect(repo.canUndo).toBe(false);
        expect(repo.canRedo).toBe(true);
    });

    it('redo brings the change back', () => {
        seed(DB_UNID);
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.createTable(DB_UNID, 'users', null, null);
        repo.undo(null);

        const r = repo.redo(null);
        expect(r.applied).toBe(true);
        expect(tableCount(repo)).toBe(1);
        expect(repo.canUndo).toBe(true);
        expect(repo.canRedo).toBe(false);
    });

    it('a fresh mutation after undo clears the redo stack', () => {
        seed(DB_UNID);
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.createTable(DB_UNID, 'users', null, null);
        repo.undo(null);
        expect(repo.canRedo).toBe(true);

        repo.createTable(DB_UNID, 'accounts', null, null);
        expect(repo.canRedo).toBe(false);
        expect(tableCount(repo)).toBe(1);
        const db = repo.data.fs.entrys[0] as JsonDataDB;
        expect(db.tables[0].name).toBe('accounts');
    });

    it('undo at the bottom of the stack is a no-op', () => {
        seed(DB_UNID);
        const repo = new DbFsRepository(projectFor(tmpFile));
        const r = repo.undo(null);
        expect(r.applied).toBe(false);
        expect(repo.canUndo).toBe(false);
    });

    it('redo with empty redo stack is a no-op', () => {
        seed(DB_UNID);
        const repo = new DbFsRepository(projectFor(tmpFile));
        const r = repo.redo(null);
        expect(r.applied).toBe(false);
    });

    it('stack respects the 100-entry cap (oldest pre-states are dropped)', () => {
        seed(DB_UNID);
        const repo = new DbFsRepository(projectFor(tmpFile));
        /* 105 mutations: each pushes a snapshot, max stack = 100 */
        for (let i = 0; i < 105; i++) {
            repo.createTable(DB_UNID, `t${i}`, null, null);
        }
        expect(tableCount(repo)).toBe(105);

        /* Can undo at most 99 times (one entry stays as "current") */
        let undone = 0;
        while (repo.canUndo) {
            repo.undo(null);
            undone++;
        }
        expect(undone).toBe(99);
        /* After exhausting undo, some early tables remain because their pre-states fell off the stack */
        expect(tableCount(repo)).toBeGreaterThan(0);
    });

    it('publishes a state.replaced event on undo and redo', () => {
        seed(DB_UNID);
        const repo = new DbFsRepository(projectFor(tmpFile));
        const events: string[] = [];
        repo.bus.subscribe(ev => events.push(ev.op));

        repo.createTable(DB_UNID, 'users', null, null);
        const before = events.length;

        repo.undo(null);
        repo.redo(null);

        const after = events.slice(before);
        expect(after.filter(e => e === 'state.replaced')).toHaveLength(2);
    });

    it('rev increments on undo and redo', () => {
        seed(DB_UNID);
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.createTable(DB_UNID, 'users', null, null);
        const r1 = repo.rev;
        repo.undo(null);
        const r2 = repo.rev;
        repo.redo(null);
        const r3 = repo.rev;
        expect(r2).toBeGreaterThan(r1);
        expect(r3).toBeGreaterThan(r2);
    });

});