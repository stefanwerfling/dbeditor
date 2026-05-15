/*
 * Tests for the persisted sync-overrides layer:
 * `DbFsRepository.updateSyncSettings()` + `effectiveSync()`.
 *
 * `project.sync` from `dbeditor.json` is the default; values written via
 * `updateSyncSettings()` override per-field. Empty arrays mean "ignore
 * nothing" — distinct from `undefined`, which means "use the default".
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DbFsRepository} from '../../DbRepository/DbFsRepository.js';
import {DbProject} from '../../DbProject/DbProject.js';
import {ConfigDialect, ConfigOutputMode} from '../../Config/Config.js';

let tmpFile = '';

const projectFor = (
    file: string,
    sync: Partial<DbProject['sync']> = {}
): DbProject => ({
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
    sync: {
        ignoreTables: sync.ignoreTables ?? [],
        ignoreColumnAttributes: sync.ignoreColumnAttributes ?? []
    }
});

beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `dbed-sync-settings-${process.pid}-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {fs.unlinkSync(tmpFile);}
});

describe('DbFsRepository.effectiveSync', () => {

    it('returns the project defaults when no override is persisted', () => {
        const repo = new DbFsRepository(projectFor(tmpFile, {
            ignoreTables: ['audit'],
            ignoreColumnAttributes: ['charset']
        }));
        expect(repo.effectiveSync()).toEqual({
            ignoreTables: ['audit'],
            ignoreColumnAttributes: ['charset']
        });
    });

    it('returns empty defaults when project.sync has no entries', () => {
        const repo = new DbFsRepository(projectFor(tmpFile));
        expect(repo.effectiveSync()).toEqual({
            ignoreTables: [],
            ignoreColumnAttributes: []
        });
    });

});

describe('DbFsRepository.updateSyncSettings', () => {

    it('overrides ignoreTables but leaves attrs at their default', () => {
        const repo = new DbFsRepository(projectFor(tmpFile, {
            ignoreColumnAttributes: ['collation']
        }));
        repo.updateSyncSettings({ignoreTables: ['migrations', 'audit']}, null);

        expect(repo.effectiveSync()).toEqual({
            ignoreTables: ['migrations', 'audit'],
            ignoreColumnAttributes: ['collation']
        });
    });

    it('an empty array override means "ignore nothing", overriding the default', () => {
        const repo = new DbFsRepository(projectFor(tmpFile, {
            ignoreTables: ['audit']
        }));
        repo.updateSyncSettings({ignoreTables: []}, null);
        expect(repo.effectiveSync().ignoreTables).toEqual([]);
    });

    it('partial patches merge — only specified fields are overridden', () => {
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateSyncSettings({ignoreTables: ['a', 'b']}, null);
        repo.updateSyncSettings({ignoreColumnAttributes: ['charset']}, null);
        expect(repo.effectiveSync()).toEqual({
            ignoreTables: ['a', 'b'],
            ignoreColumnAttributes: ['charset']
        });
    });

    it('bumps rev and publishes a sync.settings.update event on each call', () => {
        const repo = new DbFsRepository(projectFor(tmpFile));
        const events: string[] = [];
        repo.bus.subscribe(ev => events.push(ev.op));

        const r1 = repo.updateSyncSettings({ignoreTables: ['a']}, null);
        const r2 = repo.updateSyncSettings({ignoreColumnAttributes: ['charset']}, null);

        expect(r2).toBeGreaterThan(r1);
        expect(events.filter(e => e === 'sync.settings.update')).toHaveLength(2);
    });

    it('persists to disk after flush so a fresh repo recovers the override', async() => {
        const repo1 = new DbFsRepository(projectFor(tmpFile, {ignoreTables: ['default']}));
        repo1.updateSyncSettings({ignoreTables: ['from-ui']}, null);
        await repo1.flush();

        /* same dbeditor.json defaults, fresh repo instance reading from disk */
        const repo2 = new DbFsRepository(projectFor(tmpFile, {ignoreTables: ['default']}));
        expect(repo2.effectiveSync().ignoreTables).toEqual(['from-ui']);
    });

});