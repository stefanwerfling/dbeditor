import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
    appendEntry,
    historyPathFor,
    loadHistory,
    summariseChanges
} from '../../DbSyncExecutor/SyncHistoryRepo.js';
import {SchemaChangeKind} from '../../DbDiff/ChangeTypes.js';

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
        expect(historyPathFor('/proj/schemas/db.json')).toBe('/proj/schemas/sync-history.json');
        expect(historyPathFor('/abs/foo/bar.json')).toBe('/abs/foo/sync-history.json');
    });

});

describe('loadHistory', () => {

    it('returns empty list when file does not exist', () => {
        expect(loadHistory(histPath)).toEqual([]);
    });

    it('returns empty list when file is unparseable JSON', () => {
        fs.writeFileSync(histPath, '{not valid json');
        expect(loadHistory(histPath)).toEqual([]);
    });

    it('returns empty list when entries field is missing', () => {
        fs.writeFileSync(histPath, JSON.stringify({version: 1}));
        expect(loadHistory(histPath)).toEqual([]);
    });

});

describe('appendEntry', () => {

    it('writes the file and prepends new entries newest-first', () => {
        const first = appendEntry(histPath, baseEntry({databaseName: 'first'}));
        const second = appendEntry(histPath, baseEntry({databaseName: 'second'}));
        const list = loadHistory(histPath);
        expect(list).toHaveLength(2);
        expect(list[0].databaseName).toBe('second');
        expect(list[1].databaseName).toBe('first');
        expect(first.id).not.toBe(second.id);
    });

    it('fills in id and ts automatically', () => {
        const entry = appendEntry(histPath, baseEntry());
        expect(typeof entry.id).toBe('string');
        expect(entry.id.length).toBeGreaterThan(0);
        expect(typeof entry.ts).toBe('string');
        expect(() => new Date(entry.ts).toISOString()).not.toThrow();
    });

    it('creates the parent directory if missing', () => {
        const deep = path.join(tmpDir, 'a', 'b', 'sync-history.json');
        appendEntry(deep, baseEntry());
        expect(fs.existsSync(deep)).toBe(true);
        expect(loadHistory(deep)).toHaveLength(1);
    });

    it('preserves history across multiple processes / instances (file-based)', () => {
        for (let i = 0; i < 5; i++) {
            appendEntry(histPath, baseEntry({databaseName: `db-${i}`}));
        }
        const list = loadHistory(histPath);
        expect(list).toHaveLength(5);
        expect(list.map(e => e.databaseName)).toEqual(['db-4', 'db-3', 'db-2', 'db-1', 'db-0']);
    });

    it('persists critical + restoreError fields on test-run entries', () => {
        appendEntry(histPath, baseEntry({
            mode: 'test-run',
            success: false,
            critical: true,
            restoreOk: false,
            restoreError: 'mysql exit 1',
            dumpPath: '/tmp/dump.sql',
            dumpKept: true
        }));
        const list = loadHistory(histPath);
        expect(list[0].critical).toBe(true);
        expect(list[0].restoreOk).toBe(false);
        expect(list[0].restoreError).toBe('mysql exit 1');
        expect(list[0].dumpKept).toBe(true);
    });

});

describe('summariseChanges', () => {

    it('counts by kind', () => {
        expect(summariseChanges([
            {kind: SchemaChangeKind.tableAdded},
            {kind: SchemaChangeKind.tableAdded},
            {kind: SchemaChangeKind.columnDropped}
        ])).toEqual({tableAdded: 2, columnDropped: 1});
    });

    it('handles empty input', () => {
        expect(summariseChanges([])).toEqual({});
    });

});