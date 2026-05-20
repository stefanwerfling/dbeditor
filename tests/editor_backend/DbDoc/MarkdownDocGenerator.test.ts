import {describe, expect, it} from 'vitest';
import {MarkdownDocGenerator} from '../../../editor_backend/DbDoc/MarkdownDocGenerator.js';
import {JsonDataDB, JsonDataDBType} from '../../../DbEditor/JsonData.js';

const root = (entrys: JsonDataDB[]): JsonDataDB => ({
    unid: 'root',
    name: 'root',
    type: JsonDataDBType.root,
    entrys: entrys,
    tables: [],
    views: [],
    enums: [],
    routines: []
});

const db = (name: string, init: Partial<JsonDataDB> = {}): JsonDataDB => ({
    unid: `db-${name}`,
    name: name,
    type: JsonDataDBType.database,
    entrys: [],
    tables: [],
    views: [],
    enums: [],
    routines: [],
    ...init
});

const pos = (): {x: number; y: number;} => ({x: 0, y: 0});

describe('MarkdownDocGenerator.generate', () => {

    it('returns one document per database', () => {
        const data = root([db('main'), db('analytics')]);
        const out = MarkdownDocGenerator.generate(data);
        expect(out).toHaveLength(2);
        expect(out.map(d => d.path)).toEqual(['main.md', 'analytics.md']);
    });

    it('emits a TOC listing tables / views / enums / routines that exist', () => {
        const data = root([db('main', {
            tables: [{
                unid: 't1', name: 'users', pos: pos(), columns: [], indexes: [], foreignKeys: []
            }],
            views: [{unid: 'v1', name: 'active_users', pos: pos(), select: 'SELECT 1'}],
            enums: [{unid: 'e1', name: 'role', pos: pos(), values: [{unid: 'ev1', value: 'admin'}]}],
            routines: [{unid: 'r1', name: 'recount', kind: 'procedure', pos: pos(), body: 'BEGIN END'}]
        })]);
        const [doc] = MarkdownDocGenerator.generate(data);
        expect(doc.content).toContain('## Contents');
        expect(doc.content).toContain('### Tables');
        expect(doc.content).toContain('[`users`]');
        expect(doc.content).toContain('### Views');
        expect(doc.content).toContain('[`active_users`]');
        expect(doc.content).toContain('### Enums');
        expect(doc.content).toContain('[`role`]');
        expect(doc.content).toContain('### Routines');
        expect(doc.content).toContain('[`recount`]');
    });

    it('renders a column table with PK/NN/AI flags', () => {
        const data = root([db('main', {
            tables: [{
                unid: 't1', name: 'users', pos: pos(),
                columns: [
                    {unid: 'c1', name: 'id', type: 'int', primaryKey: true, autoIncrement: true, notNull: true, unsigned: true},
                    {unid: 'c2', name: 'email', type: 'varchar', length: '255', notNull: true, unique: true}
                ],
                indexes: [],
                foreignKeys: []
            }]
        })]);
        const [doc] = MarkdownDocGenerator.generate(data);
        expect(doc.content).toContain('| 1 | id | int | PK, NN, AI, UN |');
        expect(doc.content).toContain('| 2 | email | varchar(255) | NN, UQ |');
    });

    it('resolves enum type with referenced enum name', () => {
        const data = root([db('main', {
            tables: [{
                unid: 't1', name: 'users', pos: pos(),
                columns: [{unid: 'c1', name: 'role', type: 'enum', enumRef: 'e1'}],
                indexes: [],
                foreignKeys: []
            }],
            enums: [{
                unid: 'e1', name: 'user_role', pos: pos(),
                values: [{unid: 'ev1', value: 'admin'}, {unid: 'ev2', value: 'user'}]
            }]
        })]);
        const [doc] = MarkdownDocGenerator.generate(data);
        expect(doc.content).toContain('enum (user_role)');
    });

    it('shows outgoing FKs with resolved reference link', () => {
        const data = root([db('main', {
            tables: [
                {
                    unid: 't1', name: 'orders', pos: pos(),
                    columns: [{unid: 'c1', name: 'user_id', type: 'int'}],
                    indexes: [],
                    foreignKeys: [{
                        unid: 'fk1', name: 'fk_orders_user',
                        refTableUnid: 't2',
                        columns: [{columnUnid: 'c1', refColumnUnid: 'c2'}],
                        onDelete: 'CASCADE'
                    }]
                },
                {
                    unid: 't2', name: 'users', pos: pos(),
                    columns: [{unid: 'c2', name: 'id', type: 'int', primaryKey: true}],
                    indexes: [], foreignKeys: []
                }
            ]
        })]);
        const [doc] = MarkdownDocGenerator.generate(data);
        expect(doc.content).toContain('Foreign keys (outgoing)');
        expect(doc.content).toContain('fk_orders_user');
        expect(doc.content).toContain('[users](#table-users) (id)');
        expect(doc.content).toContain('CASCADE');
    });

    it('marks unresolved FK as (unresolved)', () => {
        const data = root([db('main', {
            tables: [{
                unid: 't1', name: 'orders', pos: pos(),
                columns: [{unid: 'c1', name: 'user_id', type: 'int'}],
                indexes: [],
                foreignKeys: [{
                    unid: 'fk1', name: 'fk_dangling',
                    refTableUnid: 'does-not-exist',
                    columns: [{columnUnid: 'c1', refColumnUnid: 'whatever'}]
                }]
            }]
        })]);
        const [doc] = MarkdownDocGenerator.generate(data);
        expect(doc.content).toContain('_(unresolved)_');
    });

    it('emits a "Referenced by" section for incoming FKs', () => {
        const data = root([db('main', {
            tables: [
                {
                    unid: 't1', name: 'orders', pos: pos(),
                    columns: [{unid: 'c1', name: 'user_id', type: 'int'}],
                    indexes: [],
                    foreignKeys: [{
                        unid: 'fk1', name: 'fk_orders_user', refTableUnid: 't2',
                        columns: [{columnUnid: 'c1', refColumnUnid: 'c2'}]
                    }]
                },
                {
                    unid: 't2', name: 'users', pos: pos(),
                    columns: [{unid: 'c2', name: 'id', type: 'int', primaryKey: true}],
                    indexes: [], foreignKeys: []
                }
            ]
        })]);
        const [doc] = MarkdownDocGenerator.generate(data);
        const usersSection = doc.content.slice(doc.content.indexOf('### Table `users`'));
        expect(usersSection).toContain('Referenced by');
        expect(usersSection).toContain('[orders](#table-orders)');
    });

    it('emits indexes table including ASC/DESC order suffix', () => {
        const data = root([db('main', {
            tables: [{
                unid: 't1', name: 'logs', pos: pos(),
                columns: [{unid: 'c1', name: 'ts', type: 'datetime'}],
                indexes: [{
                    unid: 'i1', name: 'idx_logs_ts', type: 'index',
                    columns: [{columnUnid: 'c1', order: 'DESC'}]
                }],
                foreignKeys: []
            }]
        })]);
        const [doc] = MarkdownDocGenerator.generate(data);
        expect(doc.content).toContain('idx_logs_ts');
        expect(doc.content).toContain('ts DESC');
    });

    it('escapes pipe and newline chars in user-supplied strings', () => {
        const data = root([db('main', {
            tables: [{
                unid: 't1', name: 'users', pos: pos(),
                columns: [{
                    unid: 'c1', name: 'note', type: 'text',
                    comment: 'multi-line\ncomment with | pipe'
                }],
                indexes: [], foreignKeys: []
            }]
        })]);
        const [doc] = MarkdownDocGenerator.generate(data);
        expect(doc.content).toContain('multi-line comment with \\| pipe');
        expect(doc.content).not.toContain('multi-line\ncomment');
    });

    it('handles fully empty database without throwing', () => {
        const data = root([db('empty')]);
        const [doc] = MarkdownDocGenerator.generate(data);
        expect(doc.content).toContain('# Database `empty`');
        expect(doc.content).toContain('0 table(s)');
    });

    it('walks nested folders inside databases when collecting tables', () => {
        const data = root([db('main', {
            entrys: [{
                unid: 'f1', name: 'subfolder', type: JsonDataDBType.folder,
                entrys: [], tables: [{
                    unid: 't1', name: 'nested', pos: pos(),
                    columns: [], indexes: [], foreignKeys: []
                }], views: [], enums: [], routines: []
            }]
        })]);
        const [doc] = MarkdownDocGenerator.generate(data);
        expect(doc.content).toContain('[`nested`]');
    });

    it('renders view bodies inside a fenced SQL code block', () => {
        const data = root([db('main', {
            views: [{unid: 'v1', name: 'recent', pos: pos(), select: 'SELECT * FROM users LIMIT 10', materialized: true}]
        })]);
        const [doc] = MarkdownDocGenerator.generate(data);
        expect(doc.content).toContain('### View `recent` (materialized)');
        expect(doc.content).toContain('```sql\nSELECT * FROM users LIMIT 10\n```');
    });

});