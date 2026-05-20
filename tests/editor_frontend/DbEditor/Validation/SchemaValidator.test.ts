/*
 * Pure-logic tests for the schema linter. The validator walks a
 * JsonDataDB tree and emits warnings for common modelling mistakes;
 * each test builds a minimal tree exercising one rule.
 */
import {describe, expect, it} from 'vitest';
import {SchemaValidator, SchemaWarning} from '../../../../editor_frontend/DbEditor/Validation/SchemaValidator.js';
import {JsonDataDB, JsonDataDBType, JsonTable} from '../../../../editor_frontend/DbEditor/JsonData.js';

const root = (databases: JsonDataDB[]): JsonDataDB => ({
    unid: 'root',
    name: 'root',
    type: JsonDataDBType.root,
    entrys: databases,
    tables: [],
    views: [],
    enums: []
});

const db = (name: string, opts: {tables?: JsonTable[]; enums?: JsonDataDB['enums']; entrys?: JsonDataDB[]; diagrams?: JsonDataDB['diagrams'];} = {}, unid = `db-${name}`): JsonDataDB => {
    const node: JsonDataDB = {
        unid: unid,
        name: name,
        type: JsonDataDBType.database,
        istoggle: true,
        entrys: opts.entrys ?? [],
        tables: opts.tables ?? [],
        views: [],
        enums: opts.enums ?? []
    };
    if (opts.diagrams) {node.diagrams = opts.diagrams;}
    return node;
};

const tbl = (name: string, columns: JsonTable['columns'], indexes: JsonTable['indexes'] = [], foreignKeys: JsonTable['foreignKeys'] = []): JsonTable => ({
    unid: `t-${name}`,
    name: name,
    pos: {x: 0, y: 0},
    columns: columns,
    indexes: indexes,
    foreignKeys: foreignKeys
});

const messages = (warnings: SchemaWarning[]): string[] => warnings.map(w => w.message);

describe('SchemaValidator — duplicate column names within table', () => {

    it('flags a table with two columns sharing a (case-insensitive) name', () => {
        const w = SchemaValidator.validate(root([db('mydb', {tables: [
            tbl('user', [
                {unid: 'c1', name: 'id', type: 'int', primaryKey: true},
                {unid: 'c2', name: 'ID', type: 'int'}
            ])
        ]})]));
        const dupErrors = w.filter(x => x.severity === 'error' && x.message.includes('columns named'));
        expect(dupErrors).toHaveLength(1);
        expect(dupErrors[0].message).toMatch(/Table "user" has 2 columns named "id"/u);
    });

    it('does not flag distinct column names', () => {
        const w = SchemaValidator.validate(root([db('mydb', {tables: [
            tbl('user', [
                {unid: 'c1', name: 'id', type: 'int', primaryKey: true},
                {unid: 'c2', name: 'email', type: 'varchar'}
            ])
        ]})]));
        expect(w.filter(x => x.message.includes('columns named'))).toHaveLength(0);
    });

});

describe('SchemaValidator — index with no columns', () => {

    it('flags an empty index', () => {
        const w = SchemaValidator.validate(root([db('mydb', {tables: [
            tbl(
                'user',
                [{unid: 'c1', name: 'id', type: 'int', primaryKey: true}],
                [{unid: 'ix1', name: 'ix_empty', type: 'index', columns: []}]
            )
        ]})]));
        const empties = w.filter(x => x.severity === 'error' && x.message.includes('Index') && x.message.includes('has no columns'));
        expect(empties).toHaveLength(1);
        expect(empties[0].message).toMatch(/Index "user.ix_empty" has no columns/u);
    });

});

describe('SchemaValidator — enum-typed column refs', () => {

    it('flags an enum column with no enumRef', () => {
        const w = SchemaValidator.validate(root([db('mydb', {tables: [
            tbl('user', [
                {unid: 'c1', name: 'id', type: 'int', primaryKey: true},
                {unid: 'c2', name: 'role', type: 'enum'}
            ])
        ]})]));
        expect(messages(w)).toContain('Column "user.role" is type enum but has no enumRef set.');
    });

    it('flags an enum column whose enumRef does not resolve', () => {
        const w = SchemaValidator.validate(root([db('mydb', {tables: [
            tbl('user', [
                {unid: 'c1', name: 'id', type: 'int', primaryKey: true},
                {unid: 'c2', name: 'role', type: 'enum', enumRef: 'gone'}
            ])
        ]})]));
        expect(messages(w)).toContain('Column "user.role" references a deleted enum.');
    });

    it('accepts an enum column whose enumRef resolves to a sibling enum', () => {
        const w = SchemaValidator.validate(root([db('mydb', {
            enums: [{unid: 'e1', name: 'role_t', pos: {x: 0, y: 0}, values: [{unid: 'v1', value: 'admin'}]}],
            tables: [
                tbl('user', [
                    {unid: 'c1', name: 'id', type: 'int', primaryKey: true},
                    {unid: 'c2', name: 'role', type: 'enum', enumRef: 'e1'}
                ])
            ]
        })]));
        expect(w.filter(x => x.message.includes('enum'))).toHaveLength(0);
    });

    it('resolves enums declared in nested folders, not just the database root', () => {
        const folder: JsonDataDB = {
            unid: 'f1',
            name: 'shared',
            type: JsonDataDBType.folder,
            istoggle: true,
            entrys: [],
            tables: [],
            views: [],
            enums: [{unid: 'e1', name: 'role_t', pos: {x: 0, y: 0}, values: [{unid: 'v1', value: 'admin'}]}]
        };
        const w = SchemaValidator.validate(root([db('mydb', {
            entrys: [folder],
            tables: [
                tbl('user', [
                    {unid: 'c1', name: 'id', type: 'int', primaryKey: true},
                    {unid: 'c2', name: 'role', type: 'enum', enumRef: 'e1'}
                ])
            ]
        })]));
        expect(w.filter(x => x.message.includes('enum'))).toHaveLength(0);
    });

});

describe('SchemaValidator — dangling diagramUnid', () => {

    it('flags a table whose diagramUnid does not resolve', () => {
        const w = SchemaValidator.validate(root([db('mydb', {
            tables: [{
                unid: 't-1', name: 'user', pos: {x: 0, y: 0},
                columns: [{unid: 'c1', name: 'id', type: 'int', primaryKey: true}],
                indexes: [], foreignKeys: [],
                diagramUnid: 'gone'
            }]
        })]));
        expect(messages(w)).toContain('Table "user" references a deleted diagram.');
    });

    it('does not flag a table whose diagramUnid resolves to a sibling diagram', () => {
        const w = SchemaValidator.validate(root([db('mydb', {
            tables: [{
                unid: 't-1', name: 'user', pos: {x: 0, y: 0},
                columns: [{unid: 'c1', name: 'id', type: 'int', primaryKey: true}],
                indexes: [], foreignKeys: [],
                diagramUnid: 'L1'
            }],
            diagrams: [{unid: 'L1', name: 'People'}]
        })]));
        expect(w.find(x => x.message.includes('deleted diagram'))).toBeUndefined();
    });

    it('flags a diagramPlacements entry pointing at a deleted diagram', () => {
        const w = SchemaValidator.validate(root([db('mydb', {
            tables: [{
                unid: 't-1', name: 'user', pos: {x: 0, y: 0},
                columns: [{unid: 'c1', name: 'id', type: 'int', primaryKey: true}],
                indexes: [], foreignKeys: [],
                diagramUnid: 'L1',
                diagramPlacements: [
                    {diagramUnid: 'L1', pos: {x: 0, y: 0}},
                    {diagramUnid: 'gone', pos: {x: 100, y: 100}}
                ]
            }],
            diagrams: [{unid: 'L1', name: 'People'}]
        })]));
        expect(messages(w)).toContain('Table "user" placement references a deleted diagram.');
    });

    it('flags a view whose diagramUnid does not resolve', () => {
        const dbNode = db('mydb', {});
        dbNode.views = [{unid: 'v-1', name: 'active_users', pos: {x: 0, y: 0}, select: 'SELECT 1', diagramUnid: 'gone'}];
        const w = SchemaValidator.validate(root([dbNode]));
        expect(messages(w)).toContain('View "active_users" references a deleted diagram.');
    });

    it('does not flag a view whose diagramUnid resolves', () => {
        const dbNode = db('mydb', {
            diagrams: [{unid: 'L1', name: 'People'}]
        });
        dbNode.views = [{unid: 'v-1', name: 'active_users', pos: {x: 0, y: 0}, select: 'SELECT 1', diagramUnid: 'L1'}];
        const w = SchemaValidator.validate(root([dbNode]));
        expect(w.find(x => x.message.includes('deleted diagram'))).toBeUndefined();
    });

    it('flags a view diagramPlacements entry pointing at a deleted diagram', () => {
        const dbNode = db('mydb', {
            diagrams: [{unid: 'L1', name: 'People'}]
        });
        dbNode.views = [{
            unid: 'v-1', name: 'active_users', pos: {x: 0, y: 0}, select: 'SELECT 1',
            diagramUnid: 'L1',
            diagramPlacements: [{diagramUnid: 'gone', pos: {x: 1, y: 1}}]
        }];
        const w = SchemaValidator.validate(root([dbNode]));
        expect(messages(w)).toContain('View "active_users" placement references a deleted diagram.');
    });

});

describe('SchemaValidator — duplicate table names within database', () => {

    it('flags two tables sharing a name in the same database (one warning per table)', () => {
        const w = SchemaValidator.validate(root([db('mydb', {tables: [
            tbl('user', [{unid: 'c1', name: 'id', type: 'int', primaryKey: true}]),
            {...tbl('USER', [{unid: 'c2', name: 'id', type: 'int', primaryKey: true}]), unid: 't-user-2'}
        ]})]));
        const dups = w.filter(x => x.message.includes('tables named'));
        expect(dups).toHaveLength(2);
        for (const d of dups) {expect(d.message).toMatch(/2 tables named "user"/u);}
    });

    it('does not flag same-named tables in DIFFERENT databases', () => {
        const w = SchemaValidator.validate(root([
            db('a', {tables: [tbl('user', [{unid: 'c1', name: 'id', type: 'int', primaryKey: true}])]}, 'db-a'),
            db('b', {tables: [tbl('user', [{unid: 'c2', name: 'id', type: 'int', primaryKey: true}])]}, 'db-b')
        ]));
        expect(w.filter(x => x.message.includes('tables named'))).toHaveLength(0);
    });

    it('catches sibling-folder duplicates within the same database', () => {
        const f1: JsonDataDB = {
            unid: 'f1', name: 'a', type: JsonDataDBType.folder, istoggle: true,
            entrys: [], tables: [tbl('user', [{unid: 'c1', name: 'id', type: 'int', primaryKey: true}])],
            views: [], enums: []
        };
        const f2: JsonDataDB = {
            unid: 'f2', name: 'b', type: JsonDataDBType.folder, istoggle: true,
            entrys: [], tables: [{...tbl('user', [{unid: 'c2', name: 'id', type: 'int', primaryKey: true}]), unid: 't-user-2'}],
            views: [], enums: []
        };
        const w = SchemaValidator.validate(root([db('mydb', {entrys: [f1, f2]})]));
        const dups = w.filter(x => x.message.includes('tables named'));
        expect(dups).toHaveLength(2);
    });

});

describe('SchemaValidator — existing rules still fire', () => {

    /*
     * Smoke: make sure the refactor for enums/threading didn't
     * accidentally break the original four warnings.
     */
    it('table without primary key + auto-increment without PK + multiple AIs', () => {
        const w = SchemaValidator.validate(root([db('mydb', {tables: [
            tbl('thing', [
                {unid: 'c1', name: 'a', type: 'int', autoIncrement: true},
                {unid: 'c2', name: 'b', type: 'int', autoIncrement: true}
            ])
        ]})]));
        expect(messages(w)).toContain('Table "thing" has no primary key.');
        expect(messages(w)).toContain('Column "thing.a" is auto-increment but not a primary key.');
        expect(messages(w)).toContain('Column "thing.b" is auto-increment but not a primary key.');
        expect(messages(w)).toContain('Table "thing" has multiple auto-increment columns (a, b).');
    });

});