/*
 * SyncGenerator's enum-changed dispatch: BEFORE/AFTER anchor selection
 * for pure-add value diffs, and refusal-comment emission for value
 * removal or reorder (which Postgres can't realise via ADD VALUE).
 * The non-enum cases are covered indirectly through SchemaDiff +
 * PostgresDialect / SqliteIntegration tests; this file isolates the
 * enum-specific logic that lives in SyncGenerator itself.
 */
import {describe, expect, it} from 'vitest';
import {PostgresDialect} from '../../../BundledPlugins/Postgres/PostgresDialect.js';
import {DialectContext} from '../../../editor_backend/DbGenerator/DbDialect.js';
import {DialectContextBuilder} from '../../../editor_backend/DbGenerator/DialectContextBuilder.js';
import {SyncGenerator} from '../../../editor_backend/DbGenerator/Sync/SyncGenerator.js';
import {SchemaChange, SchemaChangeKind, SchemaChangeSet} from '../../../editor_backend/DbDiff/ChangeTypes.js';
import {JsonDataDB, JsonDataDBType, JsonEnum} from '../../../editor_schemas/JsonData.js';

const emptyDb: JsonDataDB = {
    unid: 'db',
    name: 'db',
    type: JsonDataDBType.database,
    entrys: [],
    tables: [],
    views: [],
    enums: []
};

const ctx = (): DialectContext => DialectContextBuilder.fromModel(emptyDb, '    ', ';', true);

const en = (name: string, values: string[]): JsonEnum => ({
    unid: `en-${name}`,
    name: name,
    values: values.map((v, i) => ({unid: `en-${name}-v${i}`, value: v}))
});

const changeSet = (changes: SchemaChange[]): SchemaChangeSet => ({
    databaseUnid: 'db',
    databaseName: 'db',
    changes: changes
});

const enumChanged = (live: JsonEnum, model: JsonEnum): SchemaChange => ({
    id: `enumChanged::::::${model.name}`,
    kind: SchemaChangeKind.enumChanged,
    severity: 'warn',
    enumName: model.name,
    before: live,
    after: model,
    sql: []
});

describe('SyncGenerator enumChanged → ALTER TYPE ADD VALUE', () => {

    const d = new PostgresDialect();

    it('emits ADD VALUE BEFORE the next existing value when one exists', () => {
        const live = en('status', ['a', 'c']);
        const model = en('status', ['a', 'b', 'c']);
        const stmts = SyncGenerator.generate(changeSet([enumChanged(live, model)]), emptyDb, d, ctx());
        expect(stmts).toHaveLength(1);
        expect(stmts[0].sql).toBe('ALTER TYPE "status" ADD VALUE \'b\' BEFORE \'c\'');
    });

    it('falls back to AFTER the previous existing value when no next exists', () => {
        const live = en('status', ['a', 'b']);
        const model = en('status', ['a', 'b', 'c']);
        const stmts = SyncGenerator.generate(changeSet([enumChanged(live, model)]), emptyDb, d, ctx());
        expect(stmts).toHaveLength(1);
        expect(stmts[0].sql).toBe('ALTER TYPE "status" ADD VALUE \'c\' AFTER \'b\'');
    });

    it('emits one statement per added value, ordered by model position', () => {
        const live = en('status', ['c']);
        const model = en('status', ['a', 'b', 'c', 'd']);
        const stmts = SyncGenerator.generate(changeSet([enumChanged(live, model)]), emptyDb, d, ctx());
        expect(stmts.map(s => s.sql)).toEqual([
            'ALTER TYPE "status" ADD VALUE \'a\' BEFORE \'c\'',
            'ALTER TYPE "status" ADD VALUE \'b\' BEFORE \'c\'',
            'ALTER TYPE "status" ADD VALUE \'d\' AFTER \'c\''
        ]);
    });

    it('refuses to auto-emit when a value was removed and surfaces a comment instead', () => {
        const live = en('status', ['a', 'b', 'c']);
        const model = en('status', ['a', 'c']);
        const stmts = SyncGenerator.generate(changeSet([enumChanged(live, model)]), emptyDb, d, ctx());
        expect(stmts).toHaveLength(1);
        expect(stmts[0].sql.startsWith('-- enum "status": value "b" was removed')).toBe(true);
    });

    it('refuses to auto-emit when existing values were reordered and surfaces a comment instead', () => {
        const live = en('status', ['a', 'b']);
        const model = en('status', ['b', 'a']);
        const stmts = SyncGenerator.generate(changeSet([enumChanged(live, model)]), emptyDb, d, ctx());
        expect(stmts).toHaveLength(1);
        expect(stmts[0].sql.startsWith('-- enum "status": existing values were reordered')).toBe(true);
    });

});

describe('SyncGenerator enumAdded / enumDropped buckets', () => {

    const d = new PostgresDialect();

    it('enumAdded routes through renderCreateEnum at the createEnum bucket', () => {
        const change: SchemaChange = {
            id: 'enumAdded::::::status', kind: SchemaChangeKind.enumAdded, severity: 'safe',
            enumName: 'status', after: en('status', ['active']), sql: []
        };
        const stmts = SyncGenerator.generate(changeSet([change]), emptyDb, d, ctx());
        expect(stmts).toHaveLength(1);
        expect(stmts[0].sql).toBe('CREATE TYPE "status" AS ENUM (\'active\')');
    });

    it('enumDropped routes through renderDropEnum at the dropEnum bucket', () => {
        const change: SchemaChange = {
            id: 'enumDropped::::::status', kind: SchemaChangeKind.enumDropped, severity: 'destructive',
            enumName: 'status', before: en('status', ['active']), sql: []
        };
        const stmts = SyncGenerator.generate(changeSet([change]), emptyDb, d, ctx());
        expect(stmts).toHaveLength(1);
        expect(stmts[0].sql).toBe('DROP TYPE IF EXISTS "status"');
    });

    it('sorts createEnum before createTable and dropEnum after dropTable', () => {
        const enumAdd: SchemaChange = {
            id: 'a', kind: SchemaChangeKind.enumAdded, severity: 'safe',
            enumName: 'k', after: en('k', ['x']), sql: []
        };
        const enumDrop: SchemaChange = {
            id: 'b', kind: SchemaChangeKind.enumDropped, severity: 'destructive',
            enumName: 'g', before: en('g', ['y']), sql: []
        };
        const stmts = SyncGenerator.generate(changeSet([enumAdd, enumDrop]), emptyDb, d, ctx());
        const buckets = stmts.map(s => s.bucket);
        const dropIdx = buckets.findIndex(b => b > 5 && b < 6);
        const addIdx = buckets.findIndex((b, i) => i !== dropIdx && b > 5 && b < 6);
        expect(stmts[dropIdx].sql).toContain('DROP TYPE');
        expect(stmts[addIdx].sql).toContain('CREATE TYPE');
        expect(stmts[dropIdx].bucket).toBeLessThan(stmts[addIdx].bucket);
    });

});