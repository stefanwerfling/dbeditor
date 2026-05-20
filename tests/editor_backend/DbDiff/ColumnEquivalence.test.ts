import {describe, expect, it} from 'vitest';
import {ColumnEquivalence} from '../../../editor_backend/DbDiff/ColumnEquivalence.js';
import {
    JsonColumn,
    JsonForeignKey,
    JsonIndex,
    JsonIndexType,
    JsonTableOptions,
    JsonView
} from '../../../editor_frontend/DbEditor/JsonData.js';

const col = (patch: Partial<JsonColumn>): JsonColumn => ({
    unid: 'u',
    name: 'c',
    type: 'int',
    ...patch
});

const idx = (patch: Partial<JsonIndex>): JsonIndex => ({
    unid: 'iu',
    name: 'idx',
    type: JsonIndexType.index,
    columns: [],
    ...patch
});

const view = (patch: Partial<JsonView>): JsonView => ({
    unid: 'vu',
    name: 'v',
    pos: {x: 0, y: 0},
    select: 'SELECT 1',
    ...patch
});

describe('diffColumn', () => {

    it('returns null for identical columns', () => {
        const a = col({type: 'int', length: '11', notNull: true});
        const b = col({type: 'int', length: '11', notNull: true});
        expect(ColumnEquivalence.diffColumn(a, b, new Set())).toBeNull();
    });

    it('normalises type casing', () => {
        const a = col({type: 'INT'});
        const b = col({type: 'int'});
        expect(ColumnEquivalence.diffColumn(a, b, new Set())).toBeNull();
    });

    it('strips length on boolean / bool so live-vs-model length difference is ignored', () => {
        const a = col({type: 'boolean', length: '1'});
        const b = col({type: 'boolean'});
        expect(ColumnEquivalence.diffColumn(a, b, new Set())).toBeNull();

        const c = col({type: 'bool', length: '1'});
        const d = col({type: 'bool'});
        expect(ColumnEquivalence.diffColumn(c, d, new Set())).toBeNull();
    });

    it('detects a type change', () => {
        const a = col({type: 'int'});
        const b = col({type: 'bigint'});
        const d = ColumnEquivalence.diffColumn(a, b, new Set());
        expect(d?.fields).toContain('type');
    });

    it('detects a length change', () => {
        const a = col({type: 'varchar', length: '64'});
        const b = col({type: 'varchar', length: '255'});
        const d = ColumnEquivalence.diffColumn(a, b, new Set());
        expect(d?.fields).toContain('length');
    });

    it('treats undefined boolean flag as false', () => {
        const a = col({notNull: undefined});
        const b = col({notNull: false});
        expect(ColumnEquivalence.diffColumn(a, b, new Set())).toBeNull();
    });

    it('detects notNull / primaryKey / autoIncrement / unique / unsigned changes', () => {
        const base = col({});
        for (const flag of ['notNull', 'primaryKey', 'autoIncrement', 'unique', 'unsigned'] as const) {
            const changed = col({[flag]: true});
            const d = ColumnEquivalence.diffColumn(base, changed, new Set());
            expect(d?.fields).toContain(flag);
        }
    });

    it('case-folds CURRENT_TIMESTAMP-style defaults', () => {
        const a = col({defaultValue: 'CURRENT_TIMESTAMP'});
        const b = col({defaultValue: 'current_timestamp'});
        expect(ColumnEquivalence.diffColumn(a, b, new Set())).toBeNull();
    });

    it('treats CURRENT_TIMESTAMP and current_timestamp() as equivalent (MariaDB parens)', () => {
        const a = col({defaultValue: 'CURRENT_TIMESTAMP'});
        const b = col({defaultValue: 'current_timestamp()'});
        expect(ColumnEquivalence.diffColumn(a, b, new Set())).toBeNull();
    });

    it('treats now() and NOW() as equivalent across spelling', () => {
        const a = col({defaultValue: 'NOW()'});
        const b = col({defaultValue: 'now()'});
        expect(ColumnEquivalence.diffColumn(a, b, new Set())).toBeNull();
    });

    it('keeps literal string defaults case-sensitive', () => {
        const a = col({defaultValue: '\'A\''});
        const b = col({defaultValue: '\'a\''});
        const d = ColumnEquivalence.diffColumn(a, b, new Set());
        expect(d?.fields).toContain('defaultValue');
    });

    it('ignores comment/collation/charset whitespace', () => {
        const a = col({comment: '  hello  '});
        const b = col({comment: 'hello'});
        expect(ColumnEquivalence.diffColumn(a, b, new Set())).toBeNull();
    });

    it('honours ignore set for collation and charset', () => {
        const a = col({collation: 'utf8mb4_general_ci', charset: 'utf8mb4'});
        const b = col({collation: 'utf8mb4_unicode_ci', charset: 'utf8'});
        expect(ColumnEquivalence.diffColumn(a, b, new Set(['collation', 'charset']))).toBeNull();
        const d = ColumnEquivalence.diffColumn(a, b, new Set());
        expect(d?.fields).toEqual(expect.arrayContaining(['collation', 'charset']));
    });

});

describe('indexesEquivalent', () => {

    it('returns true for identical single-column index', () => {
        const a = idx({columns: [{columnUnid: 'a', order: 'ASC'}]});
        const b = idx({columns: [{columnUnid: 'a', order: 'ASC'}]});
        expect(ColumnEquivalence.indexesEquivalent(a, b)).toBe(true);
    });

    it('detects a type difference', () => {
        const a = idx({type: JsonIndexType.index, columns: [{columnUnid: 'a'}]});
        const b = idx({type: JsonIndexType.unique, columns: [{columnUnid: 'a'}]});
        expect(ColumnEquivalence.indexesEquivalent(a, b)).toBe(false);
    });

    it('detects a column-count difference', () => {
        const a = idx({columns: [{columnUnid: 'a'}]});
        const b = idx({columns: [{columnUnid: 'a'}, {columnUnid: 'b'}]});
        expect(ColumnEquivalence.indexesEquivalent(a, b)).toBe(false);
    });

    it('treats missing order as ASC', () => {
        const a = idx({columns: [{columnUnid: 'a'}]});
        const b = idx({columns: [{columnUnid: 'a', order: 'ASC'}]});
        expect(ColumnEquivalence.indexesEquivalent(a, b)).toBe(true);
    });

    it('detects a length difference between index columns', () => {
        const a = idx({columns: [{columnUnid: 'a', length: 10}]});
        const b = idx({columns: [{columnUnid: 'a', length: 20}]});
        expect(ColumnEquivalence.indexesEquivalent(a, b)).toBe(false);
    });

});

describe('indexColumnNamesEqual', () => {

    it('matches column unids via the resolver to names', () => {
        const a = idx({columns: [{columnUnid: 'L1'}, {columnUnid: 'L2'}]});
        const b = idx({columns: [{columnUnid: 'M1'}, {columnUnid: 'M2'}]});
        const live = (u: string): string => ({L1: 'id', L2: 'created'} as Record<string, string>)[u] ?? '';
        const model = (u: string): string => ({M1: 'id', M2: 'created'} as Record<string, string>)[u] ?? '';
        expect(ColumnEquivalence.indexColumnNamesEqual(a, b, live, model)).toBe(true);
    });

    it('detects a renamed column position', () => {
        const a = idx({columns: [{columnUnid: 'L1'}, {columnUnid: 'L2'}]});
        const b = idx({columns: [{columnUnid: 'M1'}, {columnUnid: 'M2'}]});
        const live = (u: string): string => ({L1: 'id', L2: 'created'} as Record<string, string>)[u] ?? '';
        const model = (u: string): string => ({M1: 'created', M2: 'id'} as Record<string, string>)[u] ?? '';
        expect(ColumnEquivalence.indexColumnNamesEqual(a, b, live, model)).toBe(false);
    });

});

describe('fksEquivalent', () => {

    const fk = (patch: Partial<JsonForeignKey>): JsonForeignKey => ({
        unid: 'f',
        name: 'fk1',
        refTableUnid: 'live:t:db:users',
        columns: [{columnUnid: 'L1', refColumnUnid: 'L9'}],
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION',
        ...patch
    });

    const liveCol = (u: string): string => ({L1: 'user_id', L9: 'id'} as Record<string, string>)[u] ?? '';
    const modelCol = (u: string): string => ({M1: 'user_id', M9: 'id'} as Record<string, string>)[u] ?? '';
    const liveTbl = (_u: string): string => 'users';
    const modelTbl = (_u: string): string => 'users';

    it('treats matching FKs as equivalent', () => {
        const a = fk({});
        const b = fk({columns: [{columnUnid: 'M1', refColumnUnid: 'M9'}]});
        expect(ColumnEquivalence.fksEquivalent(a, b, liveCol, modelCol, liveTbl, modelTbl)).toBe(true);
    });

    it('detects an onDelete change', () => {
        const a = fk({onDelete: 'CASCADE'});
        const b = fk({onDelete: 'RESTRICT', columns: [{columnUnid: 'M1', refColumnUnid: 'M9'}]});
        expect(ColumnEquivalence.fksEquivalent(a, b, liveCol, modelCol, liveTbl, modelTbl)).toBe(false);
    });

    it('case-folds onDelete / onUpdate', () => {
        const a = fk({onDelete: 'cascade'});
        const b = fk({onDelete: 'CASCADE', columns: [{columnUnid: 'M1', refColumnUnid: 'M9'}]});
        expect(ColumnEquivalence.fksEquivalent(a, b, liveCol, modelCol, liveTbl, modelTbl)).toBe(true);
    });

    it('detects a referenced-table change', () => {
        const a = fk({});
        const b = fk({columns: [{columnUnid: 'M1', refColumnUnid: 'M9'}]});
        expect(ColumnEquivalence.fksEquivalent(a, b, liveCol, modelCol, liveTbl, (): string => 'accounts')).toBe(false);
    });

});

describe('tableOptionsEquivalent', () => {

    const opt = (patch: Partial<JsonTableOptions>): JsonTableOptions => ({...patch});

    it('treats undefined and {} as equal', () => {
        expect(ColumnEquivalence.tableOptionsEquivalent(undefined, {}, new Set())).toBe(true);
    });

    it('case-folds engine names', () => {
        expect(ColumnEquivalence.tableOptionsEquivalent(opt({engine: 'innodb'}), opt({engine: 'InnoDB'}), new Set())).toBe(true);
    });

    it('detects a charset change', () => {
        expect(ColumnEquivalence.tableOptionsEquivalent(opt({charset: 'utf8'}), opt({charset: 'utf8mb4'}), new Set())).toBe(false);
    });

    it('honours ignore set', () => {
        expect(ColumnEquivalence.tableOptionsEquivalent(
            opt({charset: 'utf8'}),
            opt({charset: 'utf8mb4'}),
            new Set(['charset'])
        )).toBe(true);
    });

});

describe('tableOptionsEquivalent — modelDefaults inheritance', () => {

    it('treats unset model collation as inherited from modelDefaults.collation', () => {
        const live = {engine: 'InnoDB', collation: 'utf8mb4_unicode_ci'};
        const model = {engine: 'InnoDB'};
        const ok = ColumnEquivalence.tableOptionsEquivalent(live, model, new Set(), {collation: 'utf8mb4_unicode_ci'});
        expect(ok).toBe(true);
    });

    it('still fires when live collation differs from modelDefaults', () => {
        const live = {engine: 'InnoDB', collation: 'latin1_general_ci'};
        const model = {engine: 'InnoDB'};
        const ok = ColumnEquivalence.tableOptionsEquivalent(live, model, new Set(), {collation: 'utf8mb4_unicode_ci'});
        expect(ok).toBe(false);
    });

    it('per-table explicit override beats modelDefaults', () => {
        const live = {engine: 'InnoDB', collation: 'utf8mb4_bin'};
        const model = {engine: 'InnoDB', collation: 'utf8mb4_bin'};
        const ok = ColumnEquivalence.tableOptionsEquivalent(live, model, new Set(), {collation: 'utf8mb4_unicode_ci'});
        expect(ok).toBe(true);
    });

    it('falls back for engine + charset the same way', () => {
        const live = {engine: 'InnoDB', charset: 'utf8mb4'};
        const model = {};
        const ok = ColumnEquivalence.tableOptionsEquivalent(live, model, new Set(), {engine: 'InnoDB', charset: 'utf8mb4'});
        expect(ok).toBe(true);
    });

});

describe('viewsEquivalent', () => {

    it('detects a materialized flag change', () => {
        expect(ColumnEquivalence.viewsEquivalent(view({materialized: false}), view({materialized: true}))).toBe(false);
    });

    it('treats undefined materialized as false', () => {
        expect(ColumnEquivalence.viewsEquivalent(view({}), view({materialized: false}))).toBe(true);
    });

    it('detects a select-body difference', () => {
        expect(ColumnEquivalence.viewsEquivalent(view({select: 'SELECT 1'}), view({select: 'SELECT 2'}))).toBe(false);
    });

    it('ignores leading/trailing whitespace in select body', () => {
        expect(ColumnEquivalence.viewsEquivalent(view({select: '  SELECT 1  '}), view({select: 'SELECT 1'}))).toBe(true);
    });

});