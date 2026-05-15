/*
 * Tests for `DbFsRepository.updateDatabaseDefaults()` — the DB-level
 * engine / charset / collation inheritance defaults that every table
 * picks up when its own options are unset. Empty-string clears a
 * field; undefined keeps it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DbFsRepository} from '../../DbRepository/DbFsRepository.js';
import {DbProject} from '../../DbProject/DbProject.js';
import {ConfigDialect, ConfigOutputMode} from '../../Config/Config.js';
import {RepoInvalidError, RepoNotFoundError} from '../../DbRepository/DbRepositoryErrors.js';
import {JsonDataDB, JsonDataDBType} from '../../DbEditor/JsonData.js';

let tmpFile = '';

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

beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `dbed-db-defaults-${process.pid}-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {fs.unlinkSync(tmpFile);}
});

const firstDb = (repo: DbFsRepository): JsonDataDB =>
    repo.data.fs.entrys[0] as JsonDataDB;

describe('DbFsRepository.updateDatabaseDefaults', () => {

    it('sets engine / charset / collation on a fresh database', () => {
        const repo = new DbFsRepository(projectFor(tmpFile));
        const dbUnid = firstDb(repo).unid;
        repo.updateDatabaseDefaults(dbUnid, {
            defaultEngine: 'InnoDB',
            defaultCharset: 'utf8mb4',
            defaultCollation: 'utf8mb4_unicode_ci'
        }, null);
        const db = firstDb(repo);
        expect(db.defaultEngine).toBe('InnoDB');
        expect(db.defaultCharset).toBe('utf8mb4');
        expect(db.defaultCollation).toBe('utf8mb4_unicode_ci');
    });

    it('keeps untouched fields when patch is partial', () => {
        const repo = new DbFsRepository(projectFor(tmpFile));
        const dbUnid = firstDb(repo).unid;
        repo.updateDatabaseDefaults(dbUnid, {
            defaultCharset: 'utf8mb4',
            defaultCollation: 'utf8mb4_unicode_ci'
        }, null);
        repo.updateDatabaseDefaults(dbUnid, {defaultEngine: 'InnoDB'}, null);
        const db = firstDb(repo);
        expect(db.defaultEngine).toBe('InnoDB');
        expect(db.defaultCharset).toBe('utf8mb4');
        expect(db.defaultCollation).toBe('utf8mb4_unicode_ci');
    });

    it('clears a default when patch value is empty string', () => {
        const repo = new DbFsRepository(projectFor(tmpFile));
        const dbUnid = firstDb(repo).unid;
        repo.updateDatabaseDefaults(dbUnid, {defaultCharset: 'utf8mb4'}, null);
        expect(firstDb(repo).defaultCharset).toBe('utf8mb4');
        repo.updateDatabaseDefaults(dbUnid, {defaultCharset: ''}, null);
        expect(firstDb(repo).defaultCharset).toBeUndefined();
    });

    it('throws RepoNotFoundError for unknown unid', () => {
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(() => repo.updateDatabaseDefaults('does-not-exist', {defaultEngine: 'InnoDB'}, null))
        .toThrow(RepoNotFoundError);
    });

    it('throws RepoInvalidError when target is not a database container', () => {
        const repo = new DbFsRepository(projectFor(tmpFile));
        const created = repo.createContainer(firstDb(repo).unid, 'subfolder', JsonDataDBType.folder, null);
        expect(() => repo.updateDatabaseDefaults(created.entry.unid, {defaultEngine: 'InnoDB'}, null))
        .toThrow(RepoInvalidError);
    });

    it('is undoable as a single step', () => {
        const repo = new DbFsRepository(projectFor(tmpFile));
        const dbUnid = firstDb(repo).unid;
        repo.updateDatabaseDefaults(dbUnid, {defaultEngine: 'InnoDB'}, null);
        expect(firstDb(repo).defaultEngine).toBe('InnoDB');
        repo.undo(null);
        expect(firstDb(repo).defaultEngine).toBeUndefined();
    });

});