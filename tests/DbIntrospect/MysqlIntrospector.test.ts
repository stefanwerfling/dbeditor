/*
 * Unit test for the MySQL/MariaDB column-type parser. The introspector
 * uses `parseColumnType` to split `information_schema.COLUMNS.COLUMN_TYPE`
 * (e.g. `int(11) unsigned`) into the editor's logical fields. Display
 * width on INT-family types is deprecated cosmetic data — we strip it
 * to keep the diff stable against models that don't carry it (notably
 * `.mwb` imports). `tinyint(1)` is the documented exception because
 * it conventionally signals "boolean".
 *
 * We can't import the non-exported `parseColumnType` directly, so we
 * exercise it through `MysqlIntrospector` + a fake `DbConnection` that
 * replays canned rows.
 */
import {describe, expect, it} from 'vitest';
import {MysqlIntrospector} from '../../DbIntrospect/MysqlIntrospector.js';
import {DbConnection, DbRow} from '../../DbConnection/DbConnection.js';

class ScriptedConnection implements DbConnection {

    public constructor(private readonly responses: Map<string, DbRow[]>) {}

    public async query(sql: string): Promise<DbRow[]> {
        /* Match the first response whose key (substring) appears in sql. */
        for (const [needle, rows] of this.responses.entries()) {
            if (sql.includes(needle)) {return rows;}
        }
        return [];
    }

    public async exec(_sql: string): Promise<{affectedRows: number;}> {
        return {affectedRows: 0};
    }

    public async close(): Promise<void> {
        /* no-op for the scripted fake */
    }

}

const tableRow = (name: string): DbRow => ({
    TABLE_NAME: name,
    TABLE_COMMENT: '',
    ENGINE: 'InnoDB',
    TABLE_COLLATION: 'utf8mb4_general_ci'
});

const columnRow = (table: string, name: string, columnType: string, extras: Partial<DbRow> = {}): DbRow => ({
    TABLE_NAME: table,
    COLUMN_NAME: name,
    ORDINAL_POSITION: 1,
    COLUMN_DEFAULT: null,
    IS_NULLABLE: 'YES',
    COLUMN_TYPE: columnType,
    COLUMN_KEY: '',
    EXTRA: '',
    COLUMN_COMMENT: '',
    COLLATION_NAME: null,
    CHARACTER_SET_NAME: null,
    ...extras
});

const introspectCol = async(
    columnType: string,
    extras: Partial<DbRow> = {},
    tableExtras: Partial<DbRow> = {}
): Promise<{type?: string; length?: string; unsigned?: boolean; charset?: string; collation?: string;}> => {
    const responses = new Map<string, DbRow[]>([
        ['FROM information_schema.TABLES', [{...tableRow('t'), ...tableExtras}]],
        ['FROM information_schema.COLUMNS', [columnRow('t', 'c', columnType, extras)]],
        ['FROM information_schema.STATISTICS', []],
        ['FROM information_schema.KEY_COLUMN_USAGE', []],
        ['FROM information_schema.REFERENTIAL_CONSTRAINTS', []],
        ['FROM information_schema.VIEWS', []]
    ]);
    const conn = new ScriptedConnection(responses);
    const intro = new MysqlIntrospector();
    const db = await intro.introspect(conn, 'mydb');
    const col = db.tables[0]?.columns[0];
    return {
        type: col?.type,
        length: col?.length,
        unsigned: col?.unsigned,
        charset: col?.charset,
        collation: col?.collation
    };
};

describe('MysqlIntrospector — INT-family display width', () => {

    it('strips display width from `int(11)`', async() => {
        const r = await introspectCol('int(11)');
        expect(r.type).toBe('int');
        expect(r.length).toBeUndefined();
    });

    it('strips display width from `bigint(20)`', async() => {
        const r = await introspectCol('bigint(20)');
        expect(r.type).toBe('bigint');
        expect(r.length).toBeUndefined();
    });

    it('strips display width from `smallint(6)`', async() => {
        const r = await introspectCol('smallint(6)');
        expect(r.type).toBe('smallint');
        expect(r.length).toBeUndefined();
    });

    it('strips display width from `mediumint(9)`', async() => {
        const r = await introspectCol('mediumint(9)');
        expect(r.type).toBe('mediumint');
        expect(r.length).toBeUndefined();
    });

    it('strips display width from `tinyint(1)` to match .mwb importer (no boolean exception)', async() => {
        const r = await introspectCol('tinyint(1)');
        expect(r.type).toBe('tinyint');
        expect(r.length).toBeUndefined();
    });

    it('strips display width from `tinyint(4)` too', async() => {
        const r = await introspectCol('tinyint(4)');
        expect(r.type).toBe('tinyint');
        expect(r.length).toBeUndefined();
    });

    it('preserves length on varchar / decimal (those ARE meaningful)', async() => {
        expect((await introspectCol('varchar(255)')).length).toBe('255');
        expect((await introspectCol('decimal(10,2)')).length).toBe('10,2');
    });

    it('handles unsigned modifier alongside stripped display width', async() => {
        const r = await introspectCol('int(11) unsigned');
        expect(r.type).toBe('int');
        expect(r.length).toBeUndefined();
        expect(r.unsigned).toBe(true);
    });

});

describe('MysqlIntrospector — inherited charset / collation filter', () => {

    it('drops per-column collation when it matches the table default', async() => {
        const r = await introspectCol(
            'varchar(255)',
            {COLLATION_NAME: 'utf8mb4_general_ci', CHARACTER_SET_NAME: 'utf8mb4'},
            {TABLE_COLLATION: 'utf8mb4_general_ci'}
        );
        expect(r.collation).toBeUndefined();
        expect(r.charset).toBeUndefined();
    });

    it('keeps per-column collation when it differs from the table default', async() => {
        const r = await introspectCol(
            'varchar(255)',
            {COLLATION_NAME: 'latin1_swedish_ci', CHARACTER_SET_NAME: 'latin1'},
            {TABLE_COLLATION: 'utf8mb4_general_ci'}
        );
        expect(r.collation).toBe('latin1_swedish_ci');
        expect(r.charset).toBe('latin1');
    });

    it('handles NULL collation on numeric columns without crashing', async() => {
        const r = await introspectCol(
            'int(11)',
            {COLLATION_NAME: null, CHARACTER_SET_NAME: null},
            {TABLE_COLLATION: 'utf8mb4_general_ci'}
        );
        expect(r.collation).toBeUndefined();
        expect(r.charset).toBeUndefined();
    });

});

const introspectColDefault = async(
    columnType: string,
    columnDefault: unknown
): Promise<string | undefined> => {
    const responses = new Map<string, DbRow[]>([
        ['FROM information_schema.TABLES', [tableRow('t')]],
        ['FROM information_schema.COLUMNS', [columnRow('t', 'c', columnType, {COLUMN_DEFAULT: columnDefault as DbRow[string]})]],
        ['FROM information_schema.STATISTICS', []],
        ['FROM information_schema.KEY_COLUMN_USAGE', []],
        ['FROM information_schema.REFERENTIAL_CONSTRAINTS', []],
        ['FROM information_schema.VIEWS', []]
    ]);
    const conn = new ScriptedConnection(responses);
    const intro = new MysqlIntrospector();
    const db = await intro.introspect(conn, 'mydb');
    return db.tables[0]?.columns[0]?.defaultValue;
};

describe('MysqlIntrospector — COLUMN_DEFAULT noise filter', () => {

    it('treats COLUMN_DEFAULT="NULL" (MariaDB literal) as no-default', async() => {
        const dv = await introspectColDefault('int(11)', 'NULL');
        expect(dv).toBeUndefined();
    });

    it('treats SQL NULL (MySQL 8 style) as no-default', async() => {
        const dv = await introspectColDefault('int(11)', null);
        expect(dv).toBeUndefined();
    });

    it('preserves a real numeric default like "0"', async() => {
        const dv = await introspectColDefault('int(11)', '0');
        expect(dv).toBe('0');
    });

    it('preserves CURRENT_TIMESTAMP across MariaDB parens form', async() => {
        const dv = await introspectColDefault('datetime', 'current_timestamp()');
        expect(dv).toBe('current_timestamp()');
    });

});