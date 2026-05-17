/*
 * Tests for the multi-diagram placement helpers on DbFsRepository.
 * Covers `setTablePlacement` (add/update) and `removeTablePlacement`,
 * plus the `diagramPlacements` field on `updateTable`'s patch.
 *
 * Membership semantics under test:
 *   - `diagramUnid` + `pos` = the table's PRIMARY diagram (legacy
 *     single-membership). Placement writes for the primary update
 *     the top-level `pos` directly.
 *   - `diagramPlacements[]` = ADDITIONAL diagrams the same table also
 *     appears in. Each carries its own per-diagram position.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DbFsRepository} from '../../DbRepository/DbFsRepository.js';
import {DbProject} from '../../DbProject/DbProject.js';
import {ConfigDialect, ConfigOutputMode} from '../../Config/Config.js';
import {JsonDataDB, JsonDataDBType, JsonTable} from '../../DbEditor/JsonData.js';

let tmpFile = '';
const DB_UNID = 'db-main';
const TABLE_UNID = 'tab-1';
const LAYER_A = 'lay-A';
const LAYER_B = 'lay-B';

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

const seed = (tablePatch: Partial<JsonTable> = {}): void => {
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
                    unid: TABLE_UNID,
                    name: 'users',
                    pos: {x: 10, y: 20},
                    columns: [],
                    indexes: [],
                    foreignKeys: [],
                    ...tablePatch
                }],
                views: [],
                enums: [],
                diagrams: [
                    {unid: LAYER_A, name: 'Diagram A', pos: {x: 0, y: 0}, width: 300, height: 200},
                    {unid: LAYER_B, name: 'Diagram B', pos: {x: 400, y: 0}, width: 300, height: 200}
                ]
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
    tmpFile = path.join(os.tmpdir(), `dbed-pl-${process.pid}-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {fs.unlinkSync(tmpFile);}
});

const tableOf = (repo: DbFsRepository): JsonTable => {
    const db = repo.data.fs.entrys[0] as JsonDataDB;
    return db.tables[0];
};

describe('setTablePlacement', () => {

    it('adds a new placement when table has no membership for this diagram', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.setTablePlacement(TABLE_UNID, LAYER_A, {x: 50, y: 60}, null);
        const t = tableOf(repo);
        expect(t.diagramPlacements).toEqual([{diagramUnid: LAYER_A, pos: {x: 50, y: 60}}]);
        /* primary stays unchanged */
        expect(t.diagramUnid).toBeUndefined();
        expect(t.pos).toEqual({x: 10, y: 20});
    });

    it('updates an existing placement in place rather than appending', () => {
        seed({diagramPlacements: [{diagramUnid: LAYER_A, pos: {x: 50, y: 60}}]});
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.setTablePlacement(TABLE_UNID, LAYER_A, {x: 80, y: 90}, null);
        const t = tableOf(repo);
        expect(t.diagramPlacements).toHaveLength(1);
        expect(t.diagramPlacements![0]).toEqual({diagramUnid: LAYER_A, pos: {x: 80, y: 90}});
    });

    it('writes to top-level pos when the diagram is the primary one', () => {
        seed({diagramUnid: LAYER_A});
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.setTablePlacement(TABLE_UNID, LAYER_A, {x: 500, y: 600}, null);
        const t = tableOf(repo);
        expect(t.pos).toEqual({x: 500, y: 600});
        /* no placement entry should sneak in for the primary diagram */
        expect(t.diagramPlacements).toBeUndefined();
    });

    it('allows a table to be in two diagrams with distinct positions', () => {
        seed({diagramUnid: LAYER_A});
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.setTablePlacement(TABLE_UNID, LAYER_B, {x: 700, y: 80}, null);
        const t = tableOf(repo);
        expect(t.diagramUnid).toBe(LAYER_A);
        expect(t.pos).toEqual({x: 10, y: 20});
        expect(t.diagramPlacements).toEqual([{diagramUnid: LAYER_B, pos: {x: 700, y: 80}}]);
    });

});

describe('removeTablePlacement', () => {

    it('strips a matching placement entry', () => {
        seed({diagramPlacements: [
            {diagramUnid: LAYER_A, pos: {x: 50, y: 60}},
            {diagramUnid: LAYER_B, pos: {x: 700, y: 80}}
        ]});
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.removeTablePlacement(TABLE_UNID, LAYER_A, null);
        const t = tableOf(repo);
        expect(t.diagramPlacements).toEqual([{diagramUnid: LAYER_B, pos: {x: 700, y: 80}}]);
    });

    it('clears the primary diagramUnid when the diagram matches', () => {
        seed({diagramUnid: LAYER_A});
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.removeTablePlacement(TABLE_UNID, LAYER_A, null);
        const t = tableOf(repo);
        expect(t.diagramUnid).toBeUndefined();
    });

    it('drops the placements key entirely when emptied', () => {
        seed({diagramPlacements: [{diagramUnid: LAYER_A, pos: {x: 50, y: 60}}]});
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.removeTablePlacement(TABLE_UNID, LAYER_A, null);
        const t = tableOf(repo);
        expect(t.diagramPlacements).toBeUndefined();
    });

    it('is a no-op when the table is not in the diagram', () => {
        seed();
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.removeTablePlacement(TABLE_UNID, LAYER_A, null);
        const t = tableOf(repo);
        expect(t.diagramUnid).toBeUndefined();
        expect(t.diagramPlacements).toBeUndefined();
    });

});

describe('updateTable accepts diagramPlacements in the patch', () => {

    it('full-replaces the placement list', () => {
        seed({diagramPlacements: [{diagramUnid: LAYER_A, pos: {x: 50, y: 60}}]});
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateTable(TABLE_UNID, {diagramPlacements: [
            {diagramUnid: LAYER_B, pos: {x: 700, y: 80}}
        ]}, null);
        const t = tableOf(repo);
        expect(t.diagramPlacements).toEqual([{diagramUnid: LAYER_B, pos: {x: 700, y: 80}}]);
    });

    it('drops the key when patched to an empty list', () => {
        seed({diagramPlacements: [{diagramUnid: LAYER_A, pos: {x: 50, y: 60}}]});
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateTable(TABLE_UNID, {diagramPlacements: []}, null);
        const t = tableOf(repo);
        expect(t.diagramPlacements).toBeUndefined();
    });

});