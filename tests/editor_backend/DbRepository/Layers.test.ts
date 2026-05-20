/*
 * Tests for diagram CRUD on DbFsRepository. JsonDiagram is a pure
 * logical container (Phase 2 of the layer→diagram refactor) — name +
 * description only. Legacy visual props (pos/width/height/color) on
 * the seed data are stripped by `_migrateLegacyLayerSchema` on load.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DbFsRepository} from '../../../editor_backend/DbRepository/DbFsRepository.js';
import {DbProject} from '../../../editor_backend/DbProject/DbProject.js';
import {ConfigDialect, ConfigOutputMode} from '../../../editor_backend/Config/Config.js';
import {JsonDataDB, JsonDataDBType} from '../../../editor_frontend/DbEditor/JsonData.js';
import {RepoNotFoundError} from '../../../editor_backend/DbRepository/DbRepositoryErrors.js';

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
    tmpFile = path.join(os.tmpdir(), `dbed-diagram-${process.pid}-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {fs.unlinkSync(tmpFile);}
});

const dbNode = (repo: DbFsRepository): JsonDataDB => repo.data.fs.entrys[0] as JsonDataDB;

describe('DbFsRepository.createDiagram', () => {

    it('appends a diagram to the container with the given name', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const result = repo.createDiagram(DB_UNID, 'Customers', null);
        expect(result.diagram.name).toBe('Customers');
        const layers = dbNode(repo).diagrams ?? [];
        expect(layers).toHaveLength(2);
        expect(layers[1].unid).toBe(result.diagram.unid);
    });

    it('trims whitespace from the name', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const result = repo.createDiagram(DB_UNID, '  Padded  ', null);
        expect(result.diagram.name).toBe('Padded');
    });

    it('throws on missing container', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(() => repo.createDiagram('no-such-db', 'X', null)).toThrow(RepoNotFoundError);
    });

    it('throws on empty name', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(() => repo.createDiagram(DB_UNID, '   ', null)).toThrow();
    });

    it('publishes a diagram.create event and is undoable', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const events: string[] = [];
        repo.bus.subscribe(ev => events.push(ev.op));
        repo.createDiagram(DB_UNID, 'NewOne', null);
        expect(events).toContain('diagram.create');
        repo.undo(null);
        expect((dbNode(repo).diagrams ?? []).map(l => l.name)).toEqual(['EER Diagram 1']);
    });

});

describe('DbFsRepository.updateDiagram', () => {

    it('renames a diagram in place', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateDiagram(LAYER_UNID, {name: 'People'}, null);
        const diagram = (dbNode(repo).diagrams ?? [])[0];
        expect(diagram.name).toBe('People');
    });

    it('sets description when provided', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateDiagram(LAYER_UNID, {description: 'note'}, null);
        const diagram = (dbNode(repo).diagrams ?? [])[0];
        expect(diagram.description).toBe('note');
    });

    it('throws RepoNotFoundError on unknown unid', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(() => repo.updateDiagram('does-not-exist', {name: 'X'}, null)).toThrow(RepoNotFoundError);
    });

    it('publishes a diagram.update event', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const events: string[] = [];
        repo.bus.subscribe(ev => events.push(ev.op));
        repo.updateDiagram(LAYER_UNID, {name: 'X'}, null);
        expect(events).toContain('diagram.update');
    });

    it('is undoable', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateDiagram(LAYER_UNID, {name: 'NewName'}, null);
        repo.undo(null);
        const diagram = (dbNode(repo).diagrams ?? [])[0];
        expect(diagram.name).toBe('EER Diagram 1');
    });

});

describe('DbFsRepository.updateTable diagramUnid semantics', () => {

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
                    diagrams: [{
                        unid: LAYER_UNID,
                        name: 'L1'
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

    it('assigns diagramUnid via updateTable', () => {
        seedWithTable();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateTable('t-1', {diagramUnid: LAYER_UNID}, null);
        const t = dbNode(repo).tables[0];
        expect(t.diagramUnid).toBe(LAYER_UNID);
    });

    it('empty string unassigns (deletes the field entirely)', () => {
        seedWithTable();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateTable('t-1', {diagramUnid: LAYER_UNID}, null);
        repo.updateTable('t-1', {diagramUnid: ''}, null);
        const t = dbNode(repo).tables[0];
        expect(t.diagramUnid).toBeUndefined();
    });

});

describe('DbFsRepository.deleteDiagram', () => {

    it('removes the diagram from its container', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.deleteDiagram(LAYER_UNID, null);
        expect(dbNode(repo).diagrams ?? []).toHaveLength(0);
    });

    it('throws RepoNotFoundError on unknown unid', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(() => repo.deleteDiagram('nope', null)).toThrow(RepoNotFoundError);
    });

    it('does NOT clear diagramUnid on tables that referenced it (leaves dangling for validator)', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        /*
         * Add a table that references this diagram, then delete the
         * diagram — table.diagramUnid should still point at the deleted
         * unid (the user might re-create the diagram with the same unid
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
            diagramUnid: LAYER_UNID
        });
        repo.deleteDiagram(LAYER_UNID, null);
        expect(dbNode(repo).tables[0].diagramUnid).toBe(LAYER_UNID);
    });

    it('publishes a diagram.delete event', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        const events: string[] = [];
        repo.bus.subscribe(ev => events.push(ev.op));
        repo.deleteDiagram(LAYER_UNID, null);
        expect(events).toContain('diagram.delete');
    });

    it('is undoable', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.deleteDiagram(LAYER_UNID, null);
        expect(dbNode(repo).diagrams ?? []).toHaveLength(0);
        repo.undo(null);
        const layers = dbNode(repo).diagrams ?? [];
        expect(layers).toHaveLength(1);
        expect(layers[0].unid).toBe(LAYER_UNID);
        expect(layers[0].name).toBe('EER Diagram 1');
    });

});

describe('DbFsRepository legacy schema migration', () => {

    it('strips pos/width/height/color from legacy diagram entries on load', () => {
        const legacy = {
            fs: {
                unid: 'root',
                name: 'root',
                type: JsonDataDBType.root,
                entrys: [{
                    unid: DB_UNID,
                    name: 'main',
                    type: JsonDataDBType.database,
                    entrys: [],
                    tables: [],
                    views: [],
                    enums: [],
                    layers: [{
                        unid: LAYER_UNID,
                        name: 'Legacy',
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
        fs.writeFileSync(tmpFile, JSON.stringify(legacy));
        const repo = new DbFsRepository(projectFor(tmpFile));
        const diagrams = dbNode(repo).diagrams ?? [];
        expect(diagrams).toHaveLength(1);
        const d = diagrams[0] as Record<string, unknown>;
        expect(d.name).toBe('Legacy');
        expect(d.pos).toBeUndefined();
        expect(d.width).toBeUndefined();
        expect(d.height).toBeUndefined();
        expect(d.color).toBeUndefined();
    });

});