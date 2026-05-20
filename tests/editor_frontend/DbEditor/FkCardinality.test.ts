import {describe, expect, it} from 'vitest';
import {FkCardinality} from '../../../editor_frontend/DbEditor/Util/FkCardinality.js';
import {JsonColumn, JsonIndex, JsonIndexType, JsonTable} from '../../../editor_schemas/JsonData.js';

const col = (name: string, patch: Partial<JsonColumn> = {}): JsonColumn => ({
    unid: `c-${name}`,
    name: name,
    type: 'int',
    ...patch
});

const index = (name: string, type: JsonIndexType, columnUnids: string[]): JsonIndex => ({
    unid: `i-${name}`,
    name: name,
    type: type,
    columns: columnUnids.map(u => ({columnUnid: u}))
});

const table = (columns: JsonColumn[], indexes: JsonIndex[] = []): JsonTable => ({
    unid: 't',
    name: 't',
    pos: {x: 0, y: 0},
    columns: columns,
    indexes: indexes,
    foreignKeys: []
});

describe('isOneToOneFk — single-column FKs', () => {

    it('single-column FK to a PK column is 1:1', () => {
        const t = table([col('id', {primaryKey: true})]);
        expect(FkCardinality.isOneToOne(t, ['c-id'])).toBe(true);
    });

    it('single-column FK to a non-PK / non-unique column is 1:n', () => {
        const t = table([col('owner_id')]);
        expect(FkCardinality.isOneToOne(t, ['c-owner_id'])).toBe(false);
    });

    it('single-column FK to a column with legacy unique flag is 1:1', () => {
        const t = table([col('email', {unique: true})]);
        expect(FkCardinality.isOneToOne(t, ['c-email'])).toBe(true);
    });

    it('single-column FK covered by a UNIQUE index is 1:1', () => {
        const t = table(
            [col('slug')],
            [index('uq_slug', JsonIndexType.unique, ['c-slug'])]
        );
        expect(FkCardinality.isOneToOne(t, ['c-slug'])).toBe(true);
    });

    it('single-column FK NOT covered by a non-unique index is 1:n', () => {
        const t = table(
            [col('owner_id')],
            [index('idx_owner', JsonIndexType.index, ['c-owner_id'])]
        );
        expect(FkCardinality.isOneToOne(t, ['c-owner_id'])).toBe(false);
    });

});

describe('isOneToOneFk — composite FKs', () => {

    it('composite FK matching the table PK (same order) is 1:1', () => {
        const t = table([
            col('a', {primaryKey: true}),
            col('b', {primaryKey: true})
        ]);
        expect(FkCardinality.isOneToOne(t, ['c-a', 'c-b'])).toBe(true);
    });

    it('composite FK matching the table PK (reversed order) is 1:1', () => {
        const t = table([
            col('a', {primaryKey: true}),
            col('b', {primaryKey: true})
        ]);
        expect(FkCardinality.isOneToOne(t, ['c-b', 'c-a'])).toBe(true);
    });

    it('composite FK on a SUBSET of the PK is 1:n', () => {
        const t = table([
            col('a', {primaryKey: true}),
            col('b', {primaryKey: true})
        ]);
        expect(FkCardinality.isOneToOne(t, ['c-a'])).toBe(false);
    });

    it('composite FK on a SUPERSET of the PK is 1:n (no tuple uniqueness guarantee)', () => {
        const t = table([
            col('a', {primaryKey: true}),
            col('b'),
            col('c')
        ]);
        expect(FkCardinality.isOneToOne(t, ['c-a', 'c-b', 'c-c'])).toBe(false);
    });

    it('composite FK matching a UNIQUE index is 1:1', () => {
        const t = table(
            [col('a'), col('b')],
            [index('uq_ab', JsonIndexType.unique, ['c-a', 'c-b'])]
        );
        expect(FkCardinality.isOneToOne(t, ['c-a', 'c-b'])).toBe(true);
    });

    it('composite FK matching a UNIQUE index regardless of column order is 1:1', () => {
        const t = table(
            [col('a'), col('b')],
            [index('uq_ab', JsonIndexType.unique, ['c-a', 'c-b'])]
        );
        expect(FkCardinality.isOneToOne(t, ['c-b', 'c-a'])).toBe(true);
    });

    it('composite FK NOT covered by any UNIQUE index is 1:n even if each column is individually unique', () => {
        const t = table(
            [col('a', {unique: true}), col('b', {unique: true})]
        );
        /*
         * Two independent UNIQUEs across two columns do not guarantee the
         * TUPLE is unique — that's exactly the proxy bug this fix addresses.
         */
        expect(FkCardinality.isOneToOne(t, ['c-a', 'c-b'])).toBe(false);
    });

    it('composite FK matching a non-unique index is 1:n', () => {
        const t = table(
            [col('a'), col('b')],
            [index('idx_ab', JsonIndexType.index, ['c-a', 'c-b'])]
        );
        expect(FkCardinality.isOneToOne(t, ['c-a', 'c-b'])).toBe(false);
    });

    it('UNIQUE index on a superset of the FK columns does NOT make the FK 1:1', () => {
        const t = table(
            [col('a'), col('b'), col('c')],
            [index('uq_abc', JsonIndexType.unique, ['c-a', 'c-b', 'c-c'])]
        );
        expect(FkCardinality.isOneToOne(t, ['c-a', 'c-b'])).toBe(false);
    });

});

describe('isOneToOneFk — edge cases', () => {

    it('empty column list returns false', () => {
        const t = table([col('a', {primaryKey: true})]);
        expect(FkCardinality.isOneToOne(t, [])).toBe(false);
    });

    it('duplicate column unids in the input return false (malformed FK)', () => {
        const t = table([col('a', {primaryKey: true})]);
        expect(FkCardinality.isOneToOne(t, ['c-a', 'c-a'])).toBe(false);
    });

    it('table with no PK and no indexes returns false', () => {
        const t = table([col('a'), col('b')]);
        expect(FkCardinality.isOneToOne(t, ['c-a'])).toBe(false);
    });

});