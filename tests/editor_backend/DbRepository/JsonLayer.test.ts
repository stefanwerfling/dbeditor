/*
 * Phase 3: JsonLayer CRUD — a visual grouping rectangle attached
 * to a parent JsonDiagram. Covers create, update, delete, cascade-
 * on-diagram-delete, and the diagram-must-exist guard.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DbFsRepository} from '../../../editor_backend/DbRepository/DbFsRepository.js';
import {DbProject} from '../../../editor_backend/DbProject/DbProject.js';
import {ConfigDialect, ConfigOutputMode} from '../../../editor_backend/Config/Config.js';
import {JsonDataDB, JsonDataDBType} from '../../../editor_schemas/JsonData.js';
import {RepoNotFoundError} from '../../../editor_backend/DbRepository/DbRepositoryErrors.js';

let tmpFile = '';
const DB_UNID = 'db-main';
const DIAGRAM_UNID = 'dg-1';

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
                diagrams: [{unid: DIAGRAM_UNID, name: 'People'}]
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
    tmpFile = path.join(os.tmpdir(), `dbed-layer-${process.pid}-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {fs.unlinkSync(tmpFile);}
});

const dbNode = (repo: DbFsRepository): JsonDataDB => repo.data.fs.entrys[0] as JsonDataDB;

describe('DbFsRepository.createLayer', () => {

    it('appends a layer linked to its parent diagram', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const result = repo.createLayer(DB_UNID, DIAGRAM_UNID, 'Customers', {x: 100, y: 200}, 500, 350, 'rgba(0, 0, 0, 0.05)', null);
        expect(result.layer.name).toBe('Customers');
        expect(result.layer.diagramUnid).toBe(DIAGRAM_UNID);
        expect(result.layer.pos).toEqual({x: 100, y: 200});
        expect(result.layer.width).toBe(500);
        expect(result.layer.height).toBe(350);
        expect(result.layer.color).toBe('rgba(0, 0, 0, 0.05)');
        expect(dbNode(repo).layers ?? []).toHaveLength(1);
    });

    it('uses sensible defaults when pos/size/color omitted', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const result = repo.createLayer(DB_UNID, DIAGRAM_UNID, 'X', null, null, null, null, null);
        expect(result.layer.pos).toEqual({x: 80, y: 80});
        expect(result.layer.width).toBe(400);
        expect(result.layer.height).toBe(300);
        expect(result.layer.color).toBeUndefined();
    });

    it('throws when the diagram does not exist', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(() => repo.createLayer(DB_UNID, 'no-such-diagram', 'X', null, null, null, null, null)).toThrow(RepoNotFoundError);
    });

    it('throws on missing container', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(() => repo.createLayer('no-db', DIAGRAM_UNID, 'X', null, null, null, null, null)).toThrow(RepoNotFoundError);
    });

    it('throws on empty name', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(() => repo.createLayer(DB_UNID, DIAGRAM_UNID, '   ', null, null, null, null, null)).toThrow();
    });

    it('publishes a layer.create event and is undoable', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const events: string[] = [];
        repo.bus.subscribe(ev => events.push(ev.op));
        repo.createLayer(DB_UNID, DIAGRAM_UNID, 'NewOne', null, null, null, null, null);
        expect(events).toContain('layer.create');
        repo.undo(null);
        expect(dbNode(repo).layers ?? []).toHaveLength(0);
    });

});

describe('DbFsRepository.updateLayer', () => {

    const seedWithLayer = (): string => {
        const data = {
            fs: {
                unid: 'root', name: 'root', type: JsonDataDBType.root,
                entrys: [{
                    unid: DB_UNID, name: 'main', type: JsonDataDBType.database,
                    istoggle: true, entrys: [],
                    tables: [], views: [], enums: [],
                    diagrams: [{unid: DIAGRAM_UNID, name: 'People'}],
                    layers: [{
                        unid: 'lay-1', name: 'GroupA',
                        diagramUnid: DIAGRAM_UNID,
                        pos: {x: 0, y: 0}, width: 200, height: 200,
                        color: 'rgba(64, 145, 220, 0.10)'
                    }]
                }],
                tables: [], views: [], enums: []
            },
            editor: {}
        };
        fs.writeFileSync(tmpFile, JSON.stringify(data));
        return 'lay-1';
    };

    it('updates fields in place', () => {
        const lid = seedWithLayer();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateLayer(lid, {name: 'X', pos: {x: 50, y: 60}, width: 300, height: 250, color: 'red', description: 'note'}, null);
        const layer = (dbNode(repo).layers ?? [])[0];
        expect(layer.name).toBe('X');
        expect(layer.pos).toEqual({x: 50, y: 60});
        expect(layer.width).toBe(300);
        expect(layer.height).toBe(250);
        expect(layer.color).toBe('red');
        expect(layer.description).toBe('note');
    });

    it('throws on unknown unid', () => {
        seedWithLayer();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(() => repo.updateLayer('nope', {name: 'X'}, null)).toThrow(RepoNotFoundError);
    });

    it('partial patch leaves other fields untouched', () => {
        const lid = seedWithLayer();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateLayer(lid, {name: 'X'}, null);
        const layer = (dbNode(repo).layers ?? [])[0];
        expect(layer.pos).toEqual({x: 0, y: 0});
        expect(layer.width).toBe(200);
        expect(layer.height).toBe(200);
    });

});

describe('DbFsRepository.deleteLayer', () => {

    const seedWithLayer = (): string => {
        const data = {
            fs: {
                unid: 'root', name: 'root', type: JsonDataDBType.root,
                entrys: [{
                    unid: DB_UNID, name: 'main', type: JsonDataDBType.database,
                    istoggle: true, entrys: [],
                    tables: [], views: [], enums: [],
                    diagrams: [{unid: DIAGRAM_UNID, name: 'People'}],
                    layers: [{
                        unid: 'lay-1', name: 'GroupA',
                        diagramUnid: DIAGRAM_UNID,
                        pos: {x: 0, y: 0}, width: 200, height: 200
                    }]
                }],
                tables: [], views: [], enums: []
            },
            editor: {}
        };
        fs.writeFileSync(tmpFile, JSON.stringify(data));
        return 'lay-1';
    };

    it('removes the layer', () => {
        const lid = seedWithLayer();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.deleteLayer(lid, null);
        expect(dbNode(repo).layers ?? []).toHaveLength(0);
    });

    it('is undoable', () => {
        const lid = seedWithLayer();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.deleteLayer(lid, null);
        repo.undo(null);
        expect(dbNode(repo).layers ?? []).toHaveLength(1);
    });

});

describe('DbFsRepository.deleteDiagram cascades to layers', () => {

    it('removes every layer whose diagramUnid matched the deleted diagram', () => {
        const data = {
            fs: {
                unid: 'root', name: 'root', type: JsonDataDBType.root,
                entrys: [{
                    unid: DB_UNID, name: 'main', type: JsonDataDBType.database,
                    istoggle: true, entrys: [],
                    tables: [], views: [], enums: [],
                    diagrams: [
                        {unid: DIAGRAM_UNID, name: 'People'},
                        {unid: 'dg-keep', name: 'Other'}
                    ],
                    layers: [
                        {unid: 'lay-a', name: 'A', diagramUnid: DIAGRAM_UNID, pos: {x: 0, y: 0}, width: 100, height: 100},
                        {unid: 'lay-b', name: 'B', diagramUnid: DIAGRAM_UNID, pos: {x: 0, y: 0}, width: 100, height: 100},
                        {unid: 'lay-c', name: 'C', diagramUnid: 'dg-keep',    pos: {x: 0, y: 0}, width: 100, height: 100}
                    ]
                }],
                tables: [], views: [], enums: []
            },
            editor: {}
        };
        fs.writeFileSync(tmpFile, JSON.stringify(data));
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.deleteDiagram(DIAGRAM_UNID, null);
        const surviving = (dbNode(repo).layers ?? []).map(l => l.unid);
        expect(surviving).toEqual(['lay-c']);
    });

});