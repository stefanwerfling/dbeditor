import {describe, expect, it} from 'vitest';
import {buildSearchIndex, buildTableIndex, scoreMatch, topMatches} from '../../DbEditor/Util/SearchIndex.js';
import {JsonColumn, JsonDataDB, JsonDataDBType, JsonTable} from '../../DbEditor/JsonData.js';

const col = (unid: string, name: string): JsonColumn => ({unid: unid, name: name, type: 'int'});

const table = (unid: string, name: string, columns: JsonColumn[] = []): JsonTable => ({
    unid: unid,
    name: name,
    pos: {x: 0, y: 0},
    columns: columns,
    indexes: [],
    foreignKeys: []
});

const db = (unid: string, name: string, tables: JsonTable[] = [], entrys: JsonDataDB[] = []): JsonDataDB => ({
    unid: unid,
    name: name,
    type: JsonDataDBType.database,
    entrys: entrys,
    tables: tables,
    views: [],
    enums: []
});

const root = (children: JsonDataDB[]): JsonDataDB => ({
    unid: 'root',
    name: 'root',
    type: JsonDataDBType.root,
    entrys: children,
    tables: [],
    views: [],
    enums: []
});

describe('buildTableIndex (tables only)', () => {

    it('flattens tables across multiple databases with qualified names', () => {
        const idx = buildTableIndex(root([
            db('db-A', 'app', [table('t1', 'users'), table('t2', 'orders')]),
            db('db-B', 'log', [table('t3', 'events')])
        ]));
        expect(idx).toHaveLength(3);
        const byName = new Map(idx.map(e => [e.name, e]));
        expect(byName.get('users')?.qualifiedName).toBe('app.users');
        expect(byName.get('orders')?.qualifiedName).toBe('app.orders');
        expect(byName.get('events')?.qualifiedName).toBe('log.events');
        expect(byName.get('users')?.containerUnid).toBe('db-A');
        expect(byName.get('events')?.containerUnid).toBe('db-B');
        for (const e of idx) {expect(e.kind).toBe('table');}
    });

    it('walks through folders, attributing tables to the enclosing database', () => {
        const folder: JsonDataDB = {
            unid: 'f-1', name: 'sub', type: JsonDataDBType.folder,
            entrys: [], tables: [table('t-nested', 'audit_log')],
            views: [], enums: []
        };
        const idx = buildTableIndex(root([db('db-A', 'app', [], [folder])]));
        expect(idx).toHaveLength(1);
        expect(idx[0].qualifiedName).toBe('app.audit_log');
        expect(idx[0].containerUnid).toBe('db-A');
    });

});

describe('buildSearchIndex (tables + columns)', () => {

    it('emits one entry per table and one per column', () => {
        const idx = buildSearchIndex(root([
            db('db-A', 'app', [
                table('t1', 'users', [col('c-1', 'id'), col('c-2', 'email')]),
                table('t2', 'orders', [col('c-3', 'id')])
            ])
        ]));
        const tables = idx.filter(e => e.kind === 'table');
        const columns = idx.filter(e => e.kind === 'column');
        expect(tables.map(t => t.name)).toEqual(['users', 'orders']);
        expect(columns.map(c => c.qualifiedName)).toEqual([
            'app.users.id', 'app.users.email', 'app.orders.id'
        ]);
    });

    it('column entries carry the parent table unid + the column unid', () => {
        const idx = buildSearchIndex(root([
            db('db-A', 'app', [table('t1', 'users', [col('c-1', 'id')])])
        ]));
        const colEntry = idx.find(e => e.kind === 'column' && e.name === 'id');
        expect(colEntry?.tableUnid).toBe('t1');
        expect(colEntry?.columnUnid).toBe('c-1');
        expect(colEntry?.containerUnid).toBe('db-A');
    });

    it('table entries appear before their own column entries (browse-friendly order)', () => {
        const idx = buildSearchIndex(root([
            db('db-A', 'app', [table('t1', 'users', [col('c-1', 'id'), col('c-2', 'email')])])
        ]));
        expect(idx[0].kind).toBe('table');
        expect(idx[0].name).toBe('users');
        expect(idx[1].kind).toBe('column');
        expect(idx[1].name).toBe('id');
    });

});

describe('scoreMatch', () => {

    const entry = {tableUnid: 't', containerUnid: 'c', name: 'users', qualifiedName: 'app.users'};

    it('exact name → 100', () => {
        expect(scoreMatch(entry, 'users')).toBe(100);
        expect(scoreMatch(entry, 'USERS')).toBe(100);
    });

    it('exact qualified name → 90', () => {
        expect(scoreMatch(entry, 'app.users')).toBe(90);
    });

    it('name prefix → 80', () => {
        expect(scoreMatch(entry, 'us')).toBe(80);
        expect(scoreMatch(entry, 'use')).toBe(80);
    });

    it('qualified prefix (not name prefix) → 70', () => {
        expect(scoreMatch(entry, 'app.u')).toBe(70);
        expect(scoreMatch(entry, 'ap')).toBe(70);
    });

    it('name substring → 50', () => {
        expect(scoreMatch(entry, 'ser')).toBe(50);
    });

    it('qualified substring (not name substring) → 40', () => {
        const e2 = {...entry, name: 'orders', qualifiedName: 'app.orders'};
        expect(scoreMatch(e2, 'p.o')).toBe(40);
    });

    it('fuzzy subsequence → 20', () => {
        expect(scoreMatch(entry, 'urs')).toBe(20);
        expect(scoreMatch(entry, 'usr')).toBe(20);
    });

    it('non-matching → 0', () => {
        expect(scoreMatch(entry, 'xyz')).toBe(0);
        expect(scoreMatch(entry, 'zzz')).toBe(0);
    });

    it('empty query → 0', () => {
        expect(scoreMatch(entry, '')).toBe(0);
    });

});

describe('topMatches', () => {

    const index = [
        {tableUnid: 't1', containerUnid: 'd', name: 'users', qualifiedName: 'app.users'},
        {tableUnid: 't2', containerUnid: 'd', name: 'orders', qualifiedName: 'app.orders'},
        {tableUnid: 't3', containerUnid: 'd', name: 'user_logs', qualifiedName: 'app.user_logs'},
        {tableUnid: 't4', containerUnid: 'd', name: 'sessions', qualifiedName: 'app.sessions'}
    ];

    it('exact name beats prefix beats substring', () => {
        const r = topMatches(index, 'users');
        expect(r[0].entry.name).toBe('users');
        expect(r[0].score).toBe(100);
    });

    it('drops non-matches', () => {
        const r = topMatches(index, 'xyz');
        expect(r).toEqual([]);
    });

    it('orders ties alphabetically by qualifiedName', () => {
        const r = topMatches(index, 'a');
        const namesByOrder = r.map(x => x.entry.name);
        /* All four match (prefix on qualifiedName "app.*"), tied at score 70 → alphabetic */
        expect(namesByOrder).toEqual(['orders', 'sessions', 'user_logs', 'users']);
    });

    it('empty query shows everything up to the limit', () => {
        const r = topMatches(index, '');
        expect(r).toHaveLength(4);
        const r2 = topMatches(index, '', 2);
        expect(r2).toHaveLength(2);
    });

    it('respects the limit', () => {
        const big = Array.from({length: 200}, (_, i) => ({
            tableUnid: `t${i}`, containerUnid: 'd', name: `t${i}`, qualifiedName: `app.t${i}`
        }));
        expect(topMatches(big, 't', 50)).toHaveLength(50);
    });

});