import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {SyncTestRunner} from '../../../editor_backend/DbSyncExecutor/SyncTestRunner.js';
import {DumpAdapter, DumpRestoreResult} from '../../../editor_backend/DbSyncExecutor/DumpAdapters/DumpAdapter.js';
import {SyncStatement} from '../../../editor_backend/DbGenerator/Sync/SyncGenerator.js';
import {DbConnection, DbExecResult, DbRow} from '../../../editor_backend/DbConnection/DbConnection.js';
import {DbProjectConnection} from '../../../editor_backend/DbProject/DbProject.js';
import {SchemaChangeKind} from '../../../editor_backend/DbDiff/ChangeTypes.js';

const stmt = (changeId: string, sql: string): SyncStatement => ({
    changeId: changeId,
    kind: SchemaChangeKind.columnAdded,
    sql: sql,
    bucket: 1
});

class FakeConnection implements DbConnection {

    public readonly executed: string[] = [];
    private readonly _failOn: Set<string>;

    public constructor(failOn: string[] = []) {
        this._failOn = new Set(failOn);
    }

    public async query(_sql: string): Promise<DbRow[]> {
        return [];
    }

    public async exec(sql: string): Promise<DbExecResult> {
        this.executed.push(sql);
        if (this._failOn.has(sql)) {
            throw new Error(`exec failed for: ${sql}`);
        }
        return {affectedRows: 0};
    }

    public async close(): Promise<void> {
        /* fake; nothing to do */
    }

}

/**
 * In-memory fake adapter — records every dump/restore call and lets
 * each test program the outcomes. `dump` writes a marker into the
 * file so the orchestrator's size + existence checks see a real
 * file on disk. Factory function (not a class) so this test file
 * stays at one class total (lint limit).
 */
type FakeAdapter = DumpAdapter & {
    dumps: string[];
    restores: string[];
};

const makeFakeAdapter = (dumpResult: DumpRestoreResult, restoreResult: DumpRestoreResult): FakeAdapter => {
    const dumps: string[] = [];
    const restores: string[] = [];
    return {
        dumps: dumps,
        restores: restores,
        dump: async(_cfg: DbProjectConnection, dumpPath: string): Promise<DumpRestoreResult> => {
            dumps.push(dumpPath);
            if (dumpResult.ok) {
                fs.writeFileSync(dumpPath, '-- fake dump\n');
            }
            return dumpResult;
        },
        restore: async(_cfg: DbProjectConnection, dumpPath: string): Promise<DumpRestoreResult> => {
            restores.push(dumpPath);
            return restoreResult;
        }
    };
};

const cfg: DbProjectConnection = {
    databaseUnid: 'db-1',
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: 'pw',
    database: 'appdb',
    schema: 'public',
    ssl: false,
    readOnly: false
};

let tmpDir = '';

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbed-testrun-'));
});

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {fs.rmSync(tmpDir, {recursive: true, force: true});}
});

describe('SyncTestRunner.run', () => {

    it('happy path: dump → all statements ok → restore → purge', async() => {
        const conn = new FakeConnection();
        const adapter = makeFakeAdapter({ok: true, durationMs: 1}, {ok: true, durationMs: 2});
        const dumpPath = path.join(tmpDir, 'subdir', 'dump.sql');
        const result = await SyncTestRunner.run(adapter, cfg, conn, [
            stmt('c1', 'ALTER TABLE a ADD x INT'),
            stmt('c2', 'ALTER TABLE a ADD y INT')
        ], dumpPath);

        expect(result.success).toBe(true);
        expect(result.critical).toBe(false);
        expect(result.statementResults).toHaveLength(2);
        expect(result.statementResults.every(r => r.ok)).toBe(true);
        expect(result.restoreOk).toBe(true);
        expect(result.dumpKept).toBe(false);
        expect(fs.existsSync(dumpPath)).toBe(false);
        expect(adapter.dumps).toEqual([dumpPath]);
        expect(adapter.restores).toEqual([dumpPath]);
    });

    it('keeps the dump on success when purgeOnSuccess=false', async() => {
        const conn = new FakeConnection();
        const adapter = makeFakeAdapter({ok: true, durationMs: 1}, {ok: true, durationMs: 2});
        const dumpPath = path.join(tmpDir, 'keepme.sql');
        const result = await SyncTestRunner.run(adapter, cfg, conn, [
            stmt('c1', 'ALTER TABLE a ADD x INT')
        ], dumpPath, {purgeOnSuccess: false});

        expect(result.success).toBe(true);
        expect(result.dumpKept).toBe(true);
        expect(fs.existsSync(dumpPath)).toBe(true);
    });

    it('apply fails cleanly → restore ok → keeps dump + failedAtIndex set', async() => {
        const conn = new FakeConnection(['ALTER TABLE a ADD y INT']);
        const adapter = makeFakeAdapter({ok: true, durationMs: 1}, {ok: true, durationMs: 2});
        const dumpPath = path.join(tmpDir, 'partial.sql');
        const result = await SyncTestRunner.run(adapter, cfg, conn, [
            stmt('c1', 'ALTER TABLE a ADD x INT'),
            stmt('c2', 'ALTER TABLE a ADD y INT'),
            stmt('c3', 'CREATE INDEX idx ON a (x)')
        ], dumpPath);

        expect(result.success).toBe(false);
        expect(result.critical).toBe(false);
        expect(result.statementResults).toHaveLength(2);
        expect(result.statementResults[0].ok).toBe(true);
        expect(result.statementResults[1].ok).toBe(false);
        expect(result.failedAtIndex).toBe(1);
        expect(result.restoreOk).toBe(true);
        expect(result.dumpKept).toBe(true);
        expect(fs.existsSync(dumpPath)).toBe(true);
    });

    it('restore fails → critical=true → dump always kept + restoreError surfaced', async() => {
        const conn = new FakeConnection();
        const adapter = makeFakeAdapter(
            {ok: true, durationMs: 1},
            {ok: false, durationMs: 2, error: 'mysql exit 1', stderr: 'ERROR: connection lost'}
        );
        const dumpPath = path.join(tmpDir, 'criticaldump.sql');
        const result = await SyncTestRunner.run(adapter, cfg, conn, [
            stmt('c1', 'ALTER TABLE a ADD x INT')
        ], dumpPath);

        expect(result.success).toBe(false);
        expect(result.critical).toBe(true);
        expect(result.restoreOk).toBe(false);
        expect(result.restoreError).toBe('mysql exit 1');
        expect(result.restoreStderr).toBe('ERROR: connection lost');
        expect(result.dumpKept).toBe(true);
        expect(fs.existsSync(dumpPath)).toBe(true);
    });

    it('dump fails → no statements run, no restore attempted', async() => {
        const conn = new FakeConnection();
        const adapter = makeFakeAdapter(
            {ok: false, durationMs: 1, error: 'mysqldump exit 2', stderr: 'access denied'},
            {ok: true, durationMs: 2}
        );
        const dumpPath = path.join(tmpDir, 'never.sql');
        const result = await SyncTestRunner.run(adapter, cfg, conn, [
            stmt('c1', 'ALTER TABLE a ADD x INT')
        ], dumpPath);

        expect(result.success).toBe(false);
        expect(result.critical).toBe(false);
        expect(result.error).toContain('dump failed');
        expect(result.error).toContain('mysqldump exit 2');
        expect(conn.executed).toHaveLength(0);
        expect(adapter.restores).toHaveLength(0);
    });

    it('creates the dump parent directory if missing', async() => {
        const conn = new FakeConnection();
        const adapter = makeFakeAdapter({ok: true, durationMs: 1}, {ok: true, durationMs: 2});
        const dumpPath = path.join(tmpDir, 'a', 'b', 'c', 'deep.sql');
        const result = await SyncTestRunner.run(adapter, cfg, conn, [
            stmt('c1', 'ALTER TABLE a ADD x INT')
        ], dumpPath);

        expect(result.success).toBe(true);
        expect(fs.existsSync(path.dirname(dumpPath))).toBe(true);
    });

});