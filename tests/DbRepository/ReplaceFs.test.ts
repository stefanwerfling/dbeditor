/*
 * `DbFsRepository.replaceFs` is the backend side of the Import feature.
 * It must: replace the live `data.fs`, preserve `data.editor` and
 * `data.sync`, push an undo snapshot so the import is reversible, and
 * emit a state-replacing event so SSE clients refresh.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DbFsRepository} from '../../DbRepository/DbFsRepository.js';
import {DbProject} from '../../DbProject/DbProject.js';
import {ConfigDialect, ConfigOutputMode} from '../../Config/Config.js';
import {JsonDataDB, JsonDataDBType} from '../../DbEditor/JsonData.js';

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

const seed = (): void => {
    const data = {
        fs: {
            unid: 'root',
            name: 'root',
            type: JsonDataDBType.root,
            entrys: [{
                unid: 'db-orig',
                name: 'original',
                type: JsonDataDBType.database,
                istoggle: true,
                entrys: [],
                tables: [{
                    unid: 't-1',
                    name: 'orig_table',
                    pos: {x: 0, y: 0},
                    columns: [],
                    indexes: [],
                    foreignKeys: []
                }],
                views: [],
                enums: []
            }],
            tables: [],
            views: [],
            enums: []
        },
        editor: {controls_width: 240},
        sync: {ignoreTables: ['audit_log']}
    };
    fs.writeFileSync(tmpFile, JSON.stringify(data));
};

const newFs = (dbName: string, tableName: string): JsonDataDB => ({
    unid: 'root',
    name: 'root',
    type: JsonDataDBType.root,
    entrys: [{
        unid: 'db-imported',
        name: dbName,
        type: JsonDataDBType.database,
        istoggle: true,
        entrys: [],
        tables: [{
            unid: 't-imported',
            name: tableName,
            pos: {x: 0, y: 0},
            columns: [],
            indexes: [],
            foreignKeys: []
        }],
        views: [],
        enums: []
    }],
    tables: [],
    views: [],
    enums: []
});

beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `dbed-replacefs-${process.pid}-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {fs.unlinkSync(tmpFile);}
});

describe('DbFsRepository.replaceFs', () => {

    it('replaces fs with the new tree', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.replaceFs(newFs('imported', 'new_table'), null);

        const db = repo.data.fs.entrys[0] as JsonDataDB;
        expect(db.name).toBe('imported');
        expect(db.tables.map(t => t.name)).toEqual(['new_table']);
    });

    it('preserves editor and sync alongside the replacement', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const editorBefore = repo.data.editor;
        const syncBefore = repo.data.sync;
        repo.replaceFs(newFs('imported', 'new_table'), null);

        expect(repo.data.editor).toEqual(editorBefore);
        expect(repo.data.sync).toEqual(syncBefore);
    });

    it('the import shows up in the undo stack — undo restores prior fs', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(repo.canUndo).toBe(false);
        repo.replaceFs(newFs('imported', 'new_table'), null);
        expect(repo.canUndo).toBe(true);

        repo.undo(null);
        const db = repo.data.fs.entrys[0] as JsonDataDB;
        expect(db.name).toBe('original');
        expect(db.tables[0].name).toBe('orig_table');
    });

    it('publishes a fs.replaced event', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const events: string[] = [];
        repo.bus.subscribe(ev => events.push(ev.op));

        repo.replaceFs(newFs('imported', 'x'), null);
        expect(events).toContain('fs.replaced');
    });

    it('mutates the incoming tree defensively (deep clone)', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const incoming = newFs('imported', 'new_table');
        repo.replaceFs(incoming, null);

        /*
         * If the repo aliased `incoming` directly, mutating it from the
         * outside would leak into the stored state.
         */
        (incoming.entrys[0] as JsonDataDB).tables[0].name = 'should_not_leak';
        const db = repo.data.fs.entrys[0] as JsonDataDB;
        expect(db.tables[0].name).toBe('new_table');
    });

});

const dbFragment = (dbName: string, tableName: string, dbUnid = 'db-imported', tableUnid = 't-imported'): JsonDataDB => ({
    unid: dbUnid,
    name: dbName,
    type: JsonDataDBType.database,
    istoggle: true,
    entrys: [],
    tables: [{
        unid: tableUnid,
        name: tableName,
        pos: {x: 0, y: 0},
        columns: [],
        indexes: [],
        foreignKeys: []
    }],
    views: [],
    enums: []
});

describe('DbFsRepository.appendDatabases', () => {

    it('keeps the existing tree and appends the imported databases', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.appendDatabases([dbFragment('imported', 'new_table')], null);

        const entrys = repo.data.fs.entrys as JsonDataDB[];
        expect(entrys).toHaveLength(2);
        expect(entrys[0].name).toBe('original');
        expect(entrys[0].tables[0].name).toBe('orig_table');
        expect(entrys[1].name).toBe('imported');
        expect(entrys[1].tables[0].name).toBe('new_table');
    });

    it('handles multiple databases in one call', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.appendDatabases([
            dbFragment('a', 'ta', 'db-a', 't-a'),
            dbFragment('b', 'tb', 'db-b', 't-b')
        ], null);

        const entrys = repo.data.fs.entrys as JsonDataDB[];
        expect(entrys.map(e => e.name)).toEqual(['original', 'a', 'b']);
    });

    it('is undoable as a single step', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(repo.canUndo).toBe(false);
        repo.appendDatabases([dbFragment('imported', 'new_table')], null);
        expect(repo.canUndo).toBe(true);

        repo.undo(null);
        const entrys = repo.data.fs.entrys as JsonDataDB[];
        expect(entrys).toHaveLength(1);
        expect(entrys[0].name).toBe('original');
    });

    it('publishes a fs.replaced event so SSE clients refresh', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const events: string[] = [];
        repo.bus.subscribe(ev => events.push(ev.op));

        repo.appendDatabases([dbFragment('imported', 'x')], null);
        expect(events).toContain('fs.replaced');
    });

    it('no-op (and does not bump rev) when called with empty list', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const revBefore = repo.rev;
        const returned = repo.appendDatabases([], null);

        expect(returned).toBe(revBefore);
        expect(repo.rev).toBe(revBefore);
        expect(repo.canUndo).toBe(false);
    });

    it('deep-clones incoming databases — outside mutation does not leak', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const incoming = dbFragment('imported', 'new_table');
        repo.appendDatabases([incoming], null);

        incoming.tables[0].name = 'should_not_leak';
        const entrys = repo.data.fs.entrys as JsonDataDB[];
        expect(entrys[1].tables[0].name).toBe('new_table');
    });

});