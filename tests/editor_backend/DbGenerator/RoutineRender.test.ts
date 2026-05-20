/*
 * Dialect-specific routine emit. Each dialect frames the user's opaque
 * body differently (DELIMITER swap on MySQL, dollar-quoted block on
 * Postgres, no-op for SQLite procedures/functions but native triggers).
 */
import {describe, expect, it} from 'vitest';
import {MySqlDialect} from '../../../BundledPlugins/MySql/MySqlDialect.js';
import {PostgresDialect} from '../../../BundledPlugins/Postgres/PostgresDialect.js';
import {SqliteDialect} from '../../../BundledPlugins/Sqlite/SqliteDialect.js';
import {DialectContext} from '../../../editor_backend/DbGenerator/DbDialect.js';
import {DialectContextBuilder} from '../../../editor_backend/DbGenerator/DialectContextBuilder.js';
import {JsonDataDB, JsonDataDBType, JsonRoutine, JsonRoutineKind} from '../../../DbEditor/JsonData.js';

const ctx = (): DialectContext => DialectContextBuilder.fromModel({
    unid: 'db', name: 'db', type: JsonDataDBType.database,
    entrys: [], tables: [], views: [], enums: []
} as JsonDataDB, '    ', ';', true);

const routine = (kind: string, body: string, name = 'r'): JsonRoutine => ({
    unid: 'u',
    name: name,
    pos: {x: 0, y: 0},
    kind: kind,
    body: body
});

describe('MySqlDialect routines', () => {

    const d = new MySqlDialect();

    it('wraps the body in DELIMITER $$ guards', () => {
        const sql = d.renderCreateRoutine(routine(JsonRoutineKind.procedure, 'CREATE PROCEDURE r() BEGIN SELECT 1; END'), ctx());
        expect(sql).toContain('DELIMITER $$');
        expect(sql).toContain('CREATE PROCEDURE r()');
        expect(sql).toMatch(/END\$\$\nDELIMITER ;$/u);
    });

    it('returns null for an empty body', () => {
        expect(d.renderCreateRoutine(routine(JsonRoutineKind.procedure, ''), ctx())).toBeNull();
        expect(d.renderCreateRoutine(routine(JsonRoutineKind.procedure, '   '), ctx())).toBeNull();
    });

    it('emits the right DROP per kind', () => {
        expect(d.renderDropRoutine(routine(JsonRoutineKind.procedure, '', 'p'), ctx()))
        .toBe('DROP PROCEDURE IF EXISTS `p`');
        expect(d.renderDropRoutine(routine(JsonRoutineKind.function, '', 'f'), ctx()))
        .toBe('DROP FUNCTION IF EXISTS `f`');
        expect(d.renderDropRoutine(routine(JsonRoutineKind.trigger, '', 't'), ctx()))
        .toBe('DROP TRIGGER IF EXISTS `t`');
    });

});

describe('PostgresDialect routines', () => {

    const d = new PostgresDialect();

    it('emits the body verbatim (dollar-quoting is the user\'s responsibility)', () => {
        const body = 'CREATE OR REPLACE FUNCTION r() RETURNS INT LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$';
        expect(d.renderCreateRoutine(routine(JsonRoutineKind.function, body), ctx())).toBe(body);
    });

    it('returns null for empty body', () => {
        expect(d.renderCreateRoutine(routine(JsonRoutineKind.procedure, ''), ctx())).toBeNull();
    });

    it('emits DROP PROCEDURE / FUNCTION; trigger drop is a comment (needs table binding)', () => {
        expect(d.renderDropRoutine(routine(JsonRoutineKind.procedure, '', 'p'), ctx()))
        .toBe('DROP PROCEDURE IF EXISTS "p"');
        expect(d.renderDropRoutine(routine(JsonRoutineKind.function, '', 'f'), ctx()))
        .toBe('DROP FUNCTION IF EXISTS "f"');
        const triggerDrop = d.renderDropRoutine(routine(JsonRoutineKind.trigger, '', 't'), ctx());
        expect(triggerDrop).toContain('-- DROP TRIGGER');
    });

});

describe('SqliteDialect routines', () => {

    const d = new SqliteDialect();

    it('emits trigger body verbatim', () => {
        const body = 'CREATE TRIGGER t AFTER INSERT ON users BEGIN INSERT INTO log VALUES (NEW.id); END';
        expect(d.renderCreateRoutine(routine(JsonRoutineKind.trigger, body), ctx())).toBe(body);
    });

    it('emits comment for procedures / functions (SQLite has no stored routines)', () => {
        const out = d.renderCreateRoutine(routine(JsonRoutineKind.procedure, 'whatever', 'foo'), ctx());
        expect(out).toContain('not supported by SQLite');
        expect(out).toContain('foo');
    });

    it('returns null for empty body regardless of kind', () => {
        expect(d.renderCreateRoutine(routine(JsonRoutineKind.trigger, ''), ctx())).toBeNull();
        expect(d.renderCreateRoutine(routine(JsonRoutineKind.procedure, ''), ctx())).toBeNull();
    });

    it('DROP TRIGGER works; DROP PROCEDURE / FUNCTION returns null', () => {
        expect(d.renderDropRoutine(routine(JsonRoutineKind.trigger, '', 't'), ctx()))
        .toBe('DROP TRIGGER IF EXISTS "t"');
        expect(d.renderDropRoutine(routine(JsonRoutineKind.procedure, '', 'p'), ctx())).toBeNull();
        expect(d.renderDropRoutine(routine(JsonRoutineKind.function, '', 'f'), ctx())).toBeNull();
    });

});