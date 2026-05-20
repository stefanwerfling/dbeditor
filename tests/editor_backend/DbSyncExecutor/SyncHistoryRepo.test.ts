import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {SyncHistoryRepo} from '../../../editor_backend/DbSyncExecutor/SyncHistoryRepo.js';
import {SchemaChangeKind} from '../../../editor_backend/DbDiff/ChangeTypes.js';

let tmpDir = '';
let histPath = '';

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbed-hist-'));
    histPath = path.join(tmpDir, 'sync-history.json');
});

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {fs.rmSync(tmpDir, {recursive: true, force: true});}
});

const baseEntry = (overrides: Record<string, unknown> = {}): any => ({
    mode: 'apply',
    dialect: 'mysql',
    databaseUnid: 'db-1',
    databaseName: 'demo',
    selectedChangeIds: ['c1'],
    changeSetSummary: {tableAdded: 1},
    statementResults: [{changeId: 'c1', sql: 'CREATE TABLE x', ok: true, durationMs: 1}],
    success: true,
    durationMs: 5,
    ...overrides
});

describe('historyPathFor', () => {

    it('places sync-history.json next to the schema file', () => {
        expect(SyncHistoryRepo.pathFor('/proj/schemas/db.json')).toBe('/proj/schemas/sync-history.json');
        expect(SyncHistoryRepo.pathFor('/abs/foo/bar.json')).toBe('/abs/foo/sync-history.json');
    });

});

describe('loadHistory', () => {

    it('returns empty list when file does not exist', () => {
        expect(SyncHistoryRepo.load(histPath)).toEqual([]);
    });

    it('returns empty list when file is unparseable JSON', () => {
        fs.writeFileSync(histPath, '{not valid json');
        expect(SyncHistoryRepo.load(histPath)).toEqual([]);
    });

    it('returns empty list when entries field is missing', () => {
        fs.writeFileSync(histPath, JSON.stringify({version: 1}));
        expect(SyncHistoryRepo.load(histPath)).toEqual([]);
    });

});

describe('appendEntry', () => {

    it('writes the file and prepends new entries newest-first', () => {
        const first = SyncHistoryRepo.append(histPath, baseEntry({databaseName: 'first'}));
        const second = SyncHistoryRepo.append(histPath, baseEntry({databaseName: 'second'}));
        const list = SyncHistoryRepo.load(histPath);
        expect(list).toHaveLength(2);
        expect(list[0].databaseName).toBe('second');
        expect(list[1].databaseName).toBe('first');
        expect(first.id).not.toBe(second.id);
    });

    it('fills in id and ts automatically', () => {
        const entry = SyncHistoryRepo.append(histPath, baseEntry());
        expect(typeof entry.id).toBe('string');
        expect(entry.id.length).toBeGreaterThan(0);
        expect(typeof entry.ts).toBe('string');
        expect(() => new Date(entry.ts).toISOString()).not.toThrow();
    });

    it('creates the parent directory if missing', () => {
        const deep = path.join(tmpDir, 'a', 'b', 'sync-history.json');
        SyncHistoryRepo.append(deep, baseEntry());
        expect(fs.existsSync(deep)).toBe(true);
        expect(SyncHistoryRepo.load(deep)).toHaveLength(1);
    });

    it('preserves history across multiple processes / instances (file-based)', () => {
        for (let i = 0; i < 5; i++) {
            SyncHistoryRepo.append(histPath, baseEntry({databaseName: `db-${i}`}));
        }
        const list = SyncHistoryRepo.load(histPath);
        expect(list).toHaveLength(5);
        expect(list.map(e => e.databaseName)).toEqual(['db-4', 'db-3', 'db-2', 'db-1', 'db-0']);
    });

    it('persists critical + restoreError fields on test-run entries', () => {
        SyncHistoryRepo.append(histPath, baseEntry({
            mode: 'test-run',
            success: false,
            critical: true,
            restoreOk: false,
            restoreError: 'mysql exit 1',
            dumpPath: '/tmp/dump.sql',
            dumpKept: true
        }));
        const list = SyncHistoryRepo.load(histPath);
        expect(list[0].critical).toBe(true);
        expect(list[0].restoreOk).toBe(false);
        expect(list[0].restoreError).toBe('mysql exit 1');
        expect(list[0].dumpKept).toBe(true);
    });

});

describe('summariseChanges', () => {

    it('counts by kind', () => {
        expect(SyncHistoryRepo.summarise([
            {kind: SchemaChangeKind.tableAdded},
            {kind: SchemaChangeKind.tableAdded},
            {kind: SchemaChangeKind.columnDropped}
        ])).toEqual({tableAdded: 2, columnDropped: 1});
    });

    it('handles empty input', () => {
        expect(SyncHistoryRepo.summarise([])).toEqual({});
    });

});