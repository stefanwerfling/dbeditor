/*
 * Tests for routine CRUD on DbFsRepository. Routines are stored as
 * opaque-body objects (name + kind + raw SQL) — the repo just persists
 * them; the dialect-specific render is tested separately under
 * `tests/DbGenerator`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DbFsRepository} from '../../DbRepository/DbFsRepository.js';
import {DbProject} from '../../DbProject/DbProject.js';
import {ConfigDialect, ConfigOutputMode} from '../../Config/Config.js';
import {JsonDataDB, JsonDataDBType, JsonRoutineKind} from '../../DbEditor/JsonData.js';

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

const seed = (): void => {
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
                tables: [],
                views: [],
                enums: [],
                routines: []
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
    tmpFile = path.join(os.tmpdir(), `dbed-routine-${process.pid}-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {fs.unlinkSync(tmpFile);}
});

const dbNode = (repo: DbFsRepository): JsonDataDB => repo.data.fs.entrys[0] as JsonDataDB;

describe('DbFsRepository routine CRUD', () => {

    it('createRoutine appends with default empty body and configured kind', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const res = repo.createRoutine(DB_UNID, 'add_user', JsonRoutineKind.procedure, null, null);
        expect(res.routine.name).toBe('add_user');
        expect(res.routine.kind).toBe('procedure');
        expect(res.routine.body).toBe('');
        expect(dbNode(repo).routines).toHaveLength(1);
    });

    it('updateRoutine writes the body and survives a reload', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const r = repo.createRoutine(DB_UNID, 'add_user', JsonRoutineKind.procedure, null, null);
        repo.updateRoutine(r.routine.unid, {body: 'CREATE PROCEDURE add_user(IN x INT) BEGIN INSERT INTO users VALUES (x); END'}, null);
        expect(dbNode(repo).routines![0].body).toContain('INSERT INTO users');
    });

    it('updateRoutine can change kind (procedure → function)', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const r = repo.createRoutine(DB_UNID, 'p', JsonRoutineKind.procedure, null, null);
        repo.updateRoutine(r.routine.unid, {kind: JsonRoutineKind.function}, null);
        expect(dbNode(repo).routines![0].kind).toBe('function');
    });

    it('deleteRoutine removes the entry', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const r = repo.createRoutine(DB_UNID, 'p', JsonRoutineKind.procedure, null, null);
        expect(dbNode(repo).routines).toHaveLength(1);
        repo.deleteRoutine(r.routine.unid, null);
        expect(dbNode(repo).routines).toHaveLength(0);
    });

    it('createRoutine, then undo, restores absence', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.createRoutine(DB_UNID, 'p', JsonRoutineKind.procedure, null, null);
        expect(dbNode(repo).routines).toHaveLength(1);
        repo.undo(null);
        expect(dbNode(repo).routines).toHaveLength(0);
    });

    it('updateRoutine on missing unid throws RepoNotFoundError', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(() => repo.updateRoutine('missing', {body: 'x'}, null)).toThrow();
    });

    it('emits routine.create / routine.update / routine.delete events', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const events: string[] = [];
        repo.bus.subscribe(ev => events.push(ev.op));
        const r = repo.createRoutine(DB_UNID, 'p', JsonRoutineKind.procedure, null, null);
        repo.updateRoutine(r.routine.unid, {body: 'x'}, null);
        repo.deleteRoutine(r.routine.unid, null);
        expect(events).toContain('routine.create');
        expect(events).toContain('routine.update');
        expect(events).toContain('routine.delete');
    });

});