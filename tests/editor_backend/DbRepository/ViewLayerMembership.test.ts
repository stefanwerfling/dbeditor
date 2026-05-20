/*
 * Tests for the `diagramUnid` field on `JsonView` and its set/clear
 * semantics via `DbFsRepository.updateView`. Mirrors the
 * already-tested table-side membership: empty string clears,
 * non-empty value sets, no key in the patch means leave alone.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DbFsRepository} from '../../../editor_backend/DbRepository/DbFsRepository.js';
import {DbProject} from '../../../editor_backend/DbProject/DbProject.js';
import {ConfigDialect, ConfigOutputMode} from '../../../editor_backend/Config/Config.js';
import {JsonDataDB, JsonDataDBType} from '../../../editor_frontend/DbEditor/JsonData.js';

let tmpFile = '';
const DB_UNID = 'db-main';
const LAYER_UNID = 'lay-1';
const VIEW_UNID = 'view-1';

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

const seed = (initialLayerUnid?: string): void => {
    const view: Record<string, unknown> = {
        unid: VIEW_UNID,
        name: 'active_users',
        pos: {x: 100, y: 100},
        select: 'SELECT * FROM users WHERE active = 1'
    };
    if (initialLayerUnid !== undefined) {view.diagramUnid = initialLayerUnid;}
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
                views: [view],
                enums: [],
                diagrams: [{
                    unid: LAYER_UNID,
                    name: 'EER Diagram 1'
                }]
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
    tmpFile = path.join(os.tmpdir(), `dbed-view-mem-${process.pid}-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {fs.unlinkSync(tmpFile);}
});

const viewNode = (repo: DbFsRepository): Record<string, unknown> => {
    const db = repo.data.fs.entrys[0] as JsonDataDB;
    return db.views[0] as unknown as Record<string, unknown>;
};

describe('DbFsRepository.updateView — diagramUnid membership', () => {

    it('sets diagramUnid when patch carries a non-empty string', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(viewNode(repo).diagramUnid).toBeUndefined();
        repo.updateView(VIEW_UNID, {diagramUnid: LAYER_UNID}, null);
        expect(viewNode(repo).diagramUnid).toBe(LAYER_UNID);
    });

    it('clears diagramUnid when patch carries an empty string', () => {
        seed(LAYER_UNID);
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(viewNode(repo).diagramUnid).toBe(LAYER_UNID);
        repo.updateView(VIEW_UNID, {diagramUnid: ''}, null);
        expect(viewNode(repo).diagramUnid).toBeUndefined();
    });

    it('leaves diagramUnid alone when key is omitted from the patch', () => {
        seed(LAYER_UNID);
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateView(VIEW_UNID, {name: 'renamed'}, null);
        expect(viewNode(repo).name).toBe('renamed');
        expect(viewNode(repo).diagramUnid).toBe(LAYER_UNID);
    });

    it('publishes view.update and is undoable', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const events: string[] = [];
        repo.bus.subscribe(ev => events.push(ev.op));
        repo.updateView(VIEW_UNID, {diagramUnid: LAYER_UNID}, null);
        expect(events).toContain('view.update');
        repo.undo(null);
        expect(viewNode(repo).diagramUnid).toBeUndefined();
    });

});

describe('DbFsRepository.updateView — diagramPlacements multi-membership', () => {

    it('sets diagramPlacements when patch carries a non-empty array', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(viewNode(repo).diagramPlacements).toBeUndefined();
        repo.updateView(VIEW_UNID, {diagramPlacements: [{diagramUnid: LAYER_UNID, pos: {x: 200, y: 300}}]}, null);
        expect(viewNode(repo).diagramPlacements).toEqual([{diagramUnid: LAYER_UNID, pos: {x: 200, y: 300}}]);
    });

    it('clears diagramPlacements when patch carries an empty array', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateView(VIEW_UNID, {diagramPlacements: [{diagramUnid: LAYER_UNID, pos: {x: 200, y: 300}}]}, null);
        expect(viewNode(repo).diagramPlacements).toBeDefined();
        repo.updateView(VIEW_UNID, {diagramPlacements: []}, null);
        expect(viewNode(repo).diagramPlacements).toBeUndefined();
    });

    it('replaces the array on each update (not merged)', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateView(VIEW_UNID, {diagramPlacements: [{diagramUnid: 'L1', pos: {x: 1, y: 1}}]}, null);
        repo.updateView(VIEW_UNID, {diagramPlacements: [{diagramUnid: 'L2', pos: {x: 2, y: 2}}]}, null);
        expect(viewNode(repo).diagramPlacements).toEqual([{diagramUnid: 'L2', pos: {x: 2, y: 2}}]);
    });

});