/*
 * Tests for the whole-file MWB roundtrip passthrough on
 * DbFsRepository. The bytes are stored in-memory only and any
 * mutation flips them to null — keeps export-mwb honest when the
 * model has diverged from the original.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DbFsRepository} from '../../DbRepository/DbFsRepository.js';
import {DbProject} from '../../DbProject/DbProject.js';
import {ConfigDialect, ConfigOutputMode} from '../../Config/Config.js';
import {JsonDataDBType} from '../../DbEditor/JsonData.js';

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
                unid: 'db-1',
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
    tmpFile = path.join(os.tmpdir(), `dbed-mwbpass-${process.pid}-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {fs.unlinkSync(tmpFile);}
});

describe('DbFsRepository — MWB original-bytes passthrough', () => {

    it('starts null before any import', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(repo.getMwbOriginalBytes()).toBeNull();
    });

    it('set + get returns the same Buffer', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const bytes = Buffer.from('PK\x03\x04 fake .mwb body', 'utf-8');
        repo.setMwbOriginalBytes(bytes);
        expect(repo.getMwbOriginalBytes()).toBe(bytes);
    });

    it('clears on any mutation (e.g. createContainer)', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.setMwbOriginalBytes(Buffer.from('original'));
        expect(repo.getMwbOriginalBytes()).not.toBeNull();
        repo.createContainer('root', 'newdb', JsonDataDBType.database, null);
        expect(repo.getMwbOriginalBytes()).toBeNull();
    });

    it('clears on replaceFs too — old original is no longer valid', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.setMwbOriginalBytes(Buffer.from('old'));
        repo.replaceFs({
            unid: 'root',
            name: 'root',
            type: JsonDataDBType.root,
            entrys: [],
            tables: [],
            views: [],
            enums: []
        }, null);
        expect(repo.getMwbOriginalBytes()).toBeNull();
    });

    it('import flow: set AFTER replaceFs so the bytes survive', () => {
        /*
         * Mirrors the order used by the /api/projects/:pid/import-mwb
         * route. replaceFs commits and clears any prior original;
         * setMwbOriginalBytes runs after and arms the passthrough.
         */
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const imported = Buffer.from('imported .mwb');
        repo.replaceFs({
            unid: 'root',
            name: 'root',
            type: JsonDataDBType.root,
            entrys: [],
            tables: [],
            views: [],
            enums: []
        }, null);
        repo.setMwbOriginalBytes(imported);
        expect(repo.getMwbOriginalBytes()).toBe(imported);
    });

    it('undo clears it too (post-undo state need not match the original)', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.setMwbOriginalBytes(Buffer.from('original'));
        repo.createContainer('root', 'newdb', JsonDataDBType.database, null);
        /* After the mutation the original is gone — undo doesn't restore it. */
        repo.undo(null);
        expect(repo.getMwbOriginalBytes()).toBeNull();
    });

});

describe('DbFsRepository — Phase E.2 per-routine XML cache', () => {

    /*
     * Per-object granularity: routine entries persist through
     * mutations on OTHER objects (createContainer, updateTable…)
     * but evaporate when the specific routine is updated/deleted.
     * The whole-file cache (E.1) still clears on every mutation.
     */
    const seedWithRoutine = (): {repo: DbFsRepository; dbUnid: string; routineUnid: string;} => {
        const data = {
            fs: {
                unid: 'root',
                name: 'root',
                type: JsonDataDBType.root,
                entrys: [{
                    unid: 'db-1',
                    name: 'main',
                    type: JsonDataDBType.database,
                    istoggle: true,
                    entrys: [],
                    tables: [],
                    views: [],
                    enums: [],
                    routines: [{
                        unid: 'r-1',
                        name: 'sp_calc',
                        pos: {x: 0, y: 0},
                        kind: 'procedure',
                        body: 'BEGIN SELECT 1; END'
                    }]
                }],
                tables: [], views: [], enums: []
            },
            editor: {}
        };
        fs.writeFileSync(tmpFile, JSON.stringify(data));
        const repo = new DbFsRepository(projectFor(tmpFile));
        return {repo: repo, dbUnid: 'db-1', routineUnid: 'r-1'};
    };

    it('starts empty', () => {
        const {repo} = seedWithRoutine();
        expect(repo.getMwbRoutineOriginalXml().size).toBe(0);
    });

    it('set + get returns a copy with the same entries', () => {
        const {repo, routineUnid} = seedWithRoutine();
        const map = new Map([[routineUnid, '<value type="object" struct-name="db.mysql.Routine" id="wb-id-1">…</value>']]);
        repo.setMwbRoutineOriginalXml(map);
        const back = repo.getMwbRoutineOriginalXml();
        expect(back.size).toBe(1);
        expect(back.get(routineUnid)).toContain('db.mysql.Routine');
    });

    it('updateRoutine drops the matching entry', () => {
        const {repo, routineUnid} = seedWithRoutine();
        repo.setMwbRoutineOriginalXml(new Map([[routineUnid, '<raw/>']]));
        expect(repo.getMwbRoutineOriginalXml().has(routineUnid)).toBe(true);
        repo.updateRoutine(routineUnid, {body: 'BEGIN SELECT 2; END'}, null);
        expect(repo.getMwbRoutineOriginalXml().has(routineUnid)).toBe(false);
    });

    it('deleteRoutine drops the matching entry', () => {
        const {repo, routineUnid} = seedWithRoutine();
        repo.setMwbRoutineOriginalXml(new Map([[routineUnid, '<raw/>']]));
        repo.deleteRoutine(routineUnid, null);
        expect(repo.getMwbRoutineOriginalXml().has(routineUnid)).toBe(false);
    });

    it('mutations on OTHER objects keep the cache intact (per-object granularity)', () => {
        const {repo, routineUnid} = seedWithRoutine();
        repo.setMwbRoutineOriginalXml(new Map([[routineUnid, '<raw/>']]));
        repo.createContainer('root', 'second_db', JsonDataDBType.database, null);
        expect(repo.getMwbRoutineOriginalXml().has(routineUnid)).toBe(true);
    });

    it('replaceFs clears the whole map (whole-tree change invalidates everything)', () => {
        const {repo, routineUnid} = seedWithRoutine();
        repo.setMwbRoutineOriginalXml(new Map([[routineUnid, '<raw/>']]));
        repo.replaceFs({
            unid: 'root',
            name: 'root',
            type: JsonDataDBType.root,
            entrys: [],
            tables: [], views: [], enums: []
        }, null);
        expect(repo.getMwbRoutineOriginalXml().size).toBe(0);
    });

});