import {describe, expect, it} from 'vitest';
import {ScopeNarrow} from '../../../editor_backend/DbGenerator/ScopeNarrow.js';
import {JsonData, JsonDataDB, JsonDataDBType, JsonTable, JsonView, JsonEnum} from '../../../editor_schemas/JsonData.js';

const table = (unid: string, name: string, patch: Partial<JsonTable> = {}): JsonTable => ({
    unid: unid,
    name: name,
    pos: {x: 0, y: 0},
    columns: [],
    indexes: [],
    foreignKeys: [],
    ...patch
});

const view = (unid: string, name: string): JsonView => ({
    unid: unid,
    name: name,
    pos: {x: 0, y: 0},
    select: 'SELECT 1'
});

const enm = (unid: string, name: string): JsonEnum => ({
    unid: unid,
    name: name,
    pos: {x: 0, y: 0},
    values: []
});

const dbNode = (unid: string, name: string, patch: Partial<JsonDataDB> = {}): JsonDataDB => ({
    unid: unid,
    name: name,
    type: JsonDataDBType.database,
    entrys: [],
    tables: [],
    views: [],
    enums: [],
    ...patch
});

const buildData = (databases: JsonDataDB[]): JsonData => ({
    fs: {
        unid: 'root',
        name: 'root',
        type: JsonDataDBType.root,
        entrys: databases,
        tables: [],
        views: [],
        enums: []
    },
    editor: {controls_width: 240}
});

describe('ScopeNarrow.narrow', () => {

    it('database-only scope keeps that database and drops siblings', () => {
        const data = buildData([
            dbNode('db-A', 'A', {tables: [table('t-A1', 'a1')], views: [view('v-A1', 'av1')]}),
            dbNode('db-B', 'B', {tables: [table('t-B1', 'b1')]})
        ]);
        const out = ScopeNarrow.narrow(data, {databaseUnid: 'db-A'});
        const dbs = out.fs.entrys as JsonDataDB[];
        expect(dbs).toHaveLength(1);
        expect(dbs[0].name).toBe('A');
        expect(dbs[0].tables.map(t => t.name)).toEqual(['a1']);
        expect(dbs[0].views.map(v => v.name)).toEqual(['av1']);
    });

    it('table-only scope keeps only the matching table within its database', () => {
        const data = buildData([
            dbNode('db-A', 'A', {
                tables: [table('t-A1', 'a1'), table('t-A2', 'a2'), table('t-A3', 'a3')],
                enums: [enm('e-A1', 'kind')],
                views: [view('v-A1', 'av1')]
            }),
            dbNode('db-B', 'B', {tables: [table('t-B1', 'b1')]})
        ]);
        const out = ScopeNarrow.narrow(data, {tableUnid: 't-A2'});
        const dbs = out.fs.entrys as JsonDataDB[];
        expect(dbs).toHaveLength(1);
        expect(dbs[0].name).toBe('A');
        expect(dbs[0].tables.map(t => t.name)).toEqual(['a2']);
        /* enums kept (table might reference one); views dropped (table-isolated) */
        expect(dbs[0].enums.map(e => e.name)).toEqual(['kind']);
        expect(dbs[0].views).toEqual([]);
    });

    it('table-only scope strips FKs pointing at now-dropped sibling tables', () => {
        const data = buildData([
            dbNode('db-A', 'A', {tables: [
                table('t-1', 't1'),
                table('t-2', 't2', {foreignKeys: [{
                    unid: 'fk-1', name: 'fk_to_t1',
                    refTableUnid: 't-1',
                    columns: []
                }]})
            ]})
        ]);
        const out = ScopeNarrow.narrow(data, {tableUnid: 't-2'});
        const dbs = out.fs.entrys as JsonDataDB[];
        expect(dbs[0].tables[0].foreignKeys).toEqual([]);
    });

    it('preserves editor settings verbatim', () => {
        const data = buildData([dbNode('db-A', 'A')]);
        data.editor.active_entry_unid = 'whatever';
        const out = ScopeNarrow.narrow(data, {databaseUnid: 'db-A'});
        expect(out.editor).toEqual(data.editor);
    });

    it('walks through folder ancestors and rebuilds them as empty shells', () => {
        const innerDb = dbNode('db-inner', 'innerDb', {tables: [table('t-1', 'x')]});
        const folder = dbNode('f-1', 'subfolder', {type: JsonDataDBType.folder, entrys: [innerDb]});
        const outerDb = dbNode('db-outer', 'outerDb', {entrys: [folder]});
        const data = buildData([outerDb]);
        const out = ScopeNarrow.narrow(data, {tableUnid: 't-1'});
        /* root → outerDb shell → folder shell → innerDb (with the one table) */
        const root = out.fs;
        const outer = root.entrys[0] as JsonDataDB;
        const sub = outer.entrys[0] as JsonDataDB;
        const inner = sub.entrys[0] as JsonDataDB;
        expect(outer.name).toBe('outerDb');
        expect(outer.tables).toEqual([]);
        expect(sub.name).toBe('subfolder');
        expect(inner.name).toBe('innerDb');
        expect(inner.tables.map(t => t.name)).toEqual(['x']);
    });

    it('throws when both unids are missing', () => {
        const data = buildData([dbNode('db-A', 'A')]);
        expect(() => ScopeNarrow.narrow(data, {})).toThrow();
    });

    it('multi-table: keeps the requested tables and PRESERVES FKs between them', () => {
        const userIdCol = 't-A1';
        const fkAcrossKept = {
            unid: 'fk-1', name: 'fk_users',
            refTableUnid: userIdCol,
            columns: []
        };
        const data = buildData([
            dbNode('db-A', 'A', {tables: [
                table('t-A1', 'users'),
                table('t-A2', 'orders', {foreignKeys: [fkAcrossKept]}),
                table('t-A3', 'archive')
            ]})
        ]);
        const out = ScopeNarrow.narrow(data, {tableUnids: ['t-A1', 't-A2']});
        const dbs = out.fs.entrys as JsonDataDB[];
        expect(dbs[0].tables.map(t => t.name).sort()).toEqual(['orders', 'users']);
        const orders = dbs[0].tables.find(t => t.name === 'orders')!;
        expect(orders.foreignKeys).toHaveLength(1);
        expect(orders.foreignKeys[0].name).toBe('fk_users');
    });

    it('multi-table: STRIPS FKs that point at tables not in the kept set', () => {
        const fkToArchive = {
            unid: 'fk-2', name: 'fk_archive',
            refTableUnid: 't-A3',
            columns: []
        };
        const data = buildData([
            dbNode('db-A', 'A', {tables: [
                table('t-A1', 'users'),
                table('t-A2', 'orders', {foreignKeys: [fkToArchive]}),
                table('t-A3', 'archive')
            ]})
        ]);
        const out = ScopeNarrow.narrow(data, {tableUnids: ['t-A1', 't-A2']});
        const dbs = out.fs.entrys as JsonDataDB[];
        const orders = dbs[0].tables.find(t => t.name === 'orders')!;
        expect(orders.foreignKeys).toEqual([]);
    });

    it('multi-table: rejects mixed-database selection', () => {
        const data = buildData([
            dbNode('db-A', 'A', {tables: [table('t-A1', 'a1')]}),
            dbNode('db-B', 'B', {tables: [table('t-B1', 'b1')]})
        ]);
        expect(() => ScopeNarrow.narrow(data, {tableUnids: ['t-A1', 't-B1']}))
        .toThrow(/same database/u);
    });

    it('multi-table: a single-element array behaves like tableUnid (FKs stripped)', () => {
        const fk = {unid: 'fk', name: 'fk1', refTableUnid: 't-other', columns: []};
        const data = buildData([
            dbNode('db-A', 'A', {tables: [
                table('t-A1', 'x', {foreignKeys: [fk]}),
                table('t-other', 'other')
            ]})
        ]);
        const out = ScopeNarrow.narrow(data, {tableUnids: ['t-A1']});
        const dbs = out.fs.entrys as JsonDataDB[];
        expect(dbs[0].tables.map(t => t.name)).toEqual(['x']);
        expect(dbs[0].tables[0].foreignKeys).toEqual([]);
    });

    it('throws when databaseUnid does not resolve', () => {
        const data = buildData([dbNode('db-A', 'A')]);
        expect(() => ScopeNarrow.narrow(data, {databaseUnid: 'missing'})).toThrow();
    });

    it('throws when tableUnid does not resolve', () => {
        const data = buildData([dbNode('db-A', 'A')]);
        expect(() => ScopeNarrow.narrow(data, {tableUnid: 'missing'})).toThrow();
    });

    it('tableUnid wins when both unids are provided (mismatched databaseUnid ignored)', () => {
        const data = buildData([
            dbNode('db-A', 'A', {tables: [table('t-A1', 'a1')]}),
            dbNode('db-B', 'B', {tables: [table('t-B1', 'b1')]})
        ]);
        const out = ScopeNarrow.narrow(data, {databaseUnid: 'db-A', tableUnid: 't-B1'});
        const dbs = out.fs.entrys as JsonDataDB[];
        expect(dbs).toHaveLength(1);
        expect(dbs[0].name).toBe('B');
        expect(dbs[0].tables.map(t => t.name)).toEqual(['b1']);
    });

});