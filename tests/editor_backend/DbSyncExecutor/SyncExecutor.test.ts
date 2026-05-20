import {describe, expect, it} from 'vitest';
import {SyncExecutor} from '../../../editor_backend/DbSyncExecutor/SyncExecutor.js';
import {SyncStatement} from '../../../editor_backend/DbGenerator/Sync/SyncGenerator.js';
import {DbConnection, DbExecResult, DbRow} from '../../../editor_backend/DbConnection/DbConnection.js';
import {SchemaChangeKind} from '../../../editor_backend/DbDiff/ChangeTypes.js';

const stmt = (changeId: string, sql: string, bucket = 1): SyncStatement => ({
    changeId: changeId,
    kind: SchemaChangeKind.columnAdded,
    sql: sql,
    bucket: bucket
});

/**
 * In-memory fake connection. Records every exec() call and lets each test
 * pre-program failures by SQL substring.
 */
class FakeConnection implements DbConnection {

    public readonly executed: string[] = [];
    private readonly _failOn: Map<string, string>;

    public constructor(failOn: Record<string, string> = {}) {
        this._failOn = new Map(Object.entries(failOn));
    }

    public async query(_sql: string): Promise<DbRow[]> {
        return [];
    }

    public async exec(sql: string): Promise<DbExecResult> {
        this.executed.push(sql);
        for (const [needle, msg] of this._failOn.entries()) {
            if (sql.includes(needle)) {
                throw new Error(msg);
            }
        }
        return {affectedRows: 0};
    }

    public async close(): Promise<void> {
        /* fake; nothing to do */
    }

}

describe('SyncExecutor.run', () => {

    it('executes statements in input order', async() => {
        const conn = new FakeConnection();
        const results = await SyncExecutor.run(conn, [
            stmt('c1', 'ALTER TABLE a ADD COLUMN x INT'),
            stmt('c2', 'ALTER TABLE a ADD COLUMN y INT'),
            stmt('c3', 'CREATE INDEX idx ON a (x)')
        ]);
        expect(conn.executed).toEqual([
            'ALTER TABLE a ADD COLUMN x INT',
            'ALTER TABLE a ADD COLUMN y INT',
            'CREATE INDEX idx ON a (x)'
        ]);
        expect(results.map(r => r.changeId)).toEqual(['c1', 'c2', 'c3']);
        expect(results.every(r => r.ok)).toBe(true);
    });

    it('records duration per statement', async() => {
        const conn = new FakeConnection();
        const results = await SyncExecutor.run(conn, [stmt('c1', 'SELECT 1')]);
        expect(results).toHaveLength(1);
        expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('aborts at first failure and does NOT execute subsequent statements', async() => {
        const conn = new FakeConnection({BOOM: 'syntax error near BOOM'});
        const results = await SyncExecutor.run(conn, [
            stmt('c1', 'SELECT 1'),
            stmt('c2', 'BOOM bad'),
            stmt('c3', 'SELECT 3')
        ]);
        expect(conn.executed).toEqual(['SELECT 1', 'BOOM bad']);
        expect(results).toHaveLength(2);
        expect(results[0].ok).toBe(true);
        expect(results[1].ok).toBe(false);
        expect(results[1].error).toContain('syntax error');
    });

    it('returns empty results for empty statement list', async() => {
        const conn = new FakeConnection();
        const results = await SyncExecutor.run(conn, []);
        expect(results).toEqual([]);
        expect(conn.executed).toEqual([]);
    });

    it('wraps the batch in BEGIN/ROLLBACK when dryRun is true', async() => {
        const conn = new FakeConnection();
        const results = await SyncExecutor.run(conn, [
            stmt('c1', 'ALTER TABLE a ADD COLUMN x INT')
        ], {dryRun: true});
        expect(conn.executed).toEqual([
            'BEGIN',
            'ALTER TABLE a ADD COLUMN x INT',
            'ROLLBACK'
        ]);
        expect(results.map(r => r.changeId)).toEqual(['c1']);
        expect(results[0].ok).toBe(true);
    });

    it('still rolls back when a dry-run statement fails', async() => {
        const conn = new FakeConnection({BOOM: 'oops'});
        const results = await SyncExecutor.run(conn, [
            stmt('c1', 'SELECT 1'),
            stmt('c2', 'BOOM')
        ], {dryRun: true});
        expect(conn.executed).toEqual(['BEGIN', 'SELECT 1', 'BOOM', 'ROLLBACK']);
        expect(results.find(r => r.changeId === 'c2')?.ok).toBe(false);
    });

    it('surfaces a BEGIN failure as a synthetic __begin__ result and skips the batch', async() => {
        const conn = new FakeConnection({BEGIN: 'cannot start transaction'});
        const results = await SyncExecutor.run(conn, [stmt('c1', 'SELECT 1')], {dryRun: true});
        expect(conn.executed).toEqual(['BEGIN']);
        expect(results).toHaveLength(1);
        expect(results[0].changeId).toBe('__begin__');
        expect(results[0].ok).toBe(false);
        expect(results[0].error).toContain('cannot start');
    });

    it('does NOT emit BEGIN/ROLLBACK when dryRun is false (default)', async() => {
        const conn = new FakeConnection();
        await SyncExecutor.run(conn, [stmt('c1', 'SELECT 1')]);
        expect(conn.executed).toEqual(['SELECT 1']);
    });

});