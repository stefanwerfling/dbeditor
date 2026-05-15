/*
 * Tests for layer CRUD on DbFsRepository. Layers come from the .mwb
 * import flow (no `createLayer` route exists), so this file only covers
 * `updateLayer` + `deleteLayer` — the two operations the user can
 * trigger from the canvas.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DbFsRepository} from '../../DbRepository/DbFsRepository.js';
import {DbProject} from '../../DbProject/DbProject.js';
import {ConfigDialect, ConfigOutputMode} from '../../Config/Config.js';
import {JsonDataDB, JsonDataDBType} from '../../DbEditor/JsonData.js';
import {RepoNotFoundError} from '../../DbRepository/DbRepositoryErrors.js';

let tmpFile = '';
const DB_UNID = 'db-main';
const LAYER_UNID = 'lay-1';

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
                layers: [{
                    unid: LAYER_UNID,
                    name: 'EER Diagram 1',
                    pos: {x: 50, y: 60},
                    width: 400,
                    height: 300,
                    color: 'rgba(64, 145, 220, 0.10)'
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
    tmpFile = path.join(os.tmpdir(), `dbed-layer-${process.pid}-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {fs.unlinkSync(tmpFile);}
});

const dbNode = (repo: DbFsRepository): JsonDataDB => repo.data.fs.entrys[0] as JsonDataDB;

describe('DbFsRepository.createLayer', () => {

    it('appends a layer to the container with the given name + bounds', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const result = repo.createLayer(DB_UNID, 'Customers', {x: 100, y: 200}, 500, 350, 'rgba(0, 0, 0, 0.05)', null);
        expect(result.layer.name).toBe('Customers');
        expect(result.layer.pos).toEqual({x: 100, y: 200});
        expect(result.layer.width).toBe(500);
        expect(result.layer.height).toBe(350);
        expect(result.layer.color).toBe('rgba(0, 0, 0, 0.05)');
        const layers = dbNode(repo).layers ?? [];
        expect(layers).toHaveLength(2);
        expect(layers[1].unid).toBe(result.layer.unid);
    });

    it('uses sensible defaults when pos/size/color omitted', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const result = repo.createLayer(DB_UNID, 'X', null, null, null, null, null);
        expect(result.layer.pos).toEqual({x: 80, y: 80});
        expect(result.layer.width).toBe(400);
        expect(result.layer.height).toBe(300);
        expect(result.layer.color).toBeUndefined();
    });

    it('trims whitespace from the name', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const result = repo.createLayer(DB_UNID, '  Padded  ', null, null, null, null, null);
        expect(result.layer.name).toBe('Padded');
    });

    it('throws on missing container', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(() => repo.createLayer('no-such-db', 'X', null, null, null, null, null)).toThrow(RepoNotFoundError);
    });

    it('throws on empty name', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(() => repo.createLayer(DB_UNID, '   ', null, null, null, null, null)).toThrow();
    });

    it('publishes a layer.create event and is undoable', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const events: string[] = [];
        repo.bus.subscribe(ev => events.push(ev.op));
        repo.createLayer(DB_UNID, 'NewOne', null, null, null, null, null);
        expect(events).toContain('layer.create');
        repo.undo(null);
        expect((dbNode(repo).layers ?? []).map(l => l.name)).toEqual(['EER Diagram 1']);
    });

});

describe('DbFsRepository.updateLayer', () => {

    it('renames a layer in place', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateLayer(LAYER_UNID, {name: 'People'}, null);
        const layer = (dbNode(repo).layers ?? [])[0];
        expect(layer.name).toBe('People');
    });

    it('partial patch leaves other fields untouched', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateLayer(LAYER_UNID, {name: 'X'}, null);
        const layer = (dbNode(repo).layers ?? [])[0];
        expect(layer.pos).toEqual({x: 50, y: 60});
        expect(layer.width).toBe(400);
        expect(layer.height).toBe(300);
        expect(layer.color).toBe('rgba(64, 145, 220, 0.10)');
    });

    it('updates pos / size / color when provided', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateLayer(LAYER_UNID, {
            pos: {x: 100, y: 200},
            width: 500,
            height: 350,
            color: 'rgba(0, 0, 0, 0.05)',
            description: 'note'
        }, null);
        const layer = (dbNode(repo).layers ?? [])[0];
        expect(layer.pos).toEqual({x: 100, y: 200});
        expect(layer.width).toBe(500);
        expect(layer.height).toBe(350);
        expect(layer.color).toBe('rgba(0, 0, 0, 0.05)');
        expect(layer.description).toBe('note');
    });

    it('throws RepoNotFoundError on unknown unid', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(() => repo.updateLayer('does-not-exist', {name: 'X'}, null)).toThrow(RepoNotFoundError);
    });

    it('publishes a layer.update event', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const events: string[] = [];
        repo.bus.subscribe(ev => events.push(ev.op));
        repo.updateLayer(LAYER_UNID, {name: 'X'}, null);
        expect(events).toContain('layer.update');
    });

    it('is undoable', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateLayer(LAYER_UNID, {name: 'NewName'}, null);
        repo.undo(null);
        const layer = (dbNode(repo).layers ?? [])[0];
        expect(layer.name).toBe('EER Diagram 1');
    });

});

describe('DbFsRepository.updateTable layerUnid semantics', () => {

    const seedWithTable = (): void => {
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
                    tables: [{
                        unid: 't-1',
                        name: 'orders',
                        pos: {x: 0, y: 0},
                        columns: [{unid: 'c1', name: 'id', type: 'int', primaryKey: true}],
                        indexes: [],
                        foreignKeys: []
                    }],
                    views: [],
                    enums: [],
                    layers: [{
                        unid: LAYER_UNID,
                        name: 'L1',
                        pos: {x: 0, y: 0},
                        width: 200,
                        height: 200
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

    it('assigns layerUnid via updateTable', () => {
        seedWithTable();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateTable('t-1', {layerUnid: LAYER_UNID}, null);
        const t = dbNode(repo).tables[0];
        expect(t.layerUnid).toBe(LAYER_UNID);
    });

    it('empty string unassigns (deletes the field entirely)', () => {
        seedWithTable();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateTable('t-1', {layerUnid: LAYER_UNID}, null);
        repo.updateTable('t-1', {layerUnid: ''}, null);
        const t = dbNode(repo).tables[0];
        expect(t.layerUnid).toBeUndefined();
    });

});

describe('DbFsRepository.deleteLayer', () => {

    it('removes the layer from its container', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.deleteLayer(LAYER_UNID, null);
        expect(dbNode(repo).layers ?? []).toHaveLength(0);
    });

    it('throws RepoNotFoundError on unknown unid', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(() => repo.deleteLayer('nope', null)).toThrow(RepoNotFoundError);
    });

    it('does NOT clear layerUnid on tables that referenced it (leaves dangling for validator)', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        /*
         * Add a table that references this layer, then delete the
         * layer — table.layerUnid should still point at the deleted
         * unid (the user might re-create the layer with the same unid
         * via undo). The validator surfaces dangling refs separately.
         */
        const db = dbNode(repo);
        db.tables.push({
            unid: 't-1',
            name: 't',
            pos: {x: 0, y: 0},
            columns: [{unid: 'c1', name: 'id', type: 'int', primaryKey: true}],
            indexes: [],
            foreignKeys: [],
            layerUnid: LAYER_UNID
        });
        repo.deleteLayer(LAYER_UNID, null);
        expect(dbNode(repo).tables[0].layerUnid).toBe(LAYER_UNID);
    });

    it('publishes a layer.delete event', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const events: string[] = [];
        repo.bus.subscribe(ev => events.push(ev.op));
        repo.deleteLayer(LAYER_UNID, null);
        expect(events).toContain('layer.delete');
    });

    it('is undoable', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.deleteLayer(LAYER_UNID, null);
        expect(dbNode(repo).layers ?? []).toHaveLength(0);
        repo.undo(null);
        const layers = dbNode(repo).layers ?? [];
        expect(layers).toHaveLength(1);
        expect(layers[0].unid).toBe(LAYER_UNID);
        expect(layers[0].name).toBe('EER Diagram 1');
    });

});