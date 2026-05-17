// @vitest-environment happy-dom
/*
 * DOM-rendering tests for the Treeview. Uses the per-file
 * happy-dom env directive so the rest of the test suite stays in
 * the (faster) node environment. localStorage stubbed via happy-dom.
 *
 * Coverage focuses on the day's user-visible additions: always-on
 * five-bucket rendering with empty-state "+ Add X" hints, and the
 * Modell / Live mode bar's connection-count badge.
 */
import {beforeEach, describe, expect, it} from 'vitest';
import {Treeview} from '../../../DbEditor/Treeview/Treeview.js';
import {EditorEvents} from '../../../DbEditor/Base/EditorEvents.js';
import {JsonDataDB, JsonDataDBType, JsonTable, JsonRoutineKind} from '../../../DbEditor/JsonData.js';

const mkTable = (name: string, unid?: string): JsonTable => ({
    unid: unid ?? `t-${name}`,
    name: name,
    pos: {x: 0, y: 0},
    columns: [{unid: `c-${name}-id`, name: 'id', type: 'int', primaryKey: true}],
    indexes: [],
    foreignKeys: []
});

const mkDb = (overrides: Partial<JsonDataDB> = {}): JsonDataDB => ({
    unid: 'db-1',
    name: 'app',
    type: JsonDataDBType.database,
    istoggle: true,
    entrys: [],
    tables: [],
    views: [],
    enums: [],
    ...overrides
});

const wrapProject = (db: JsonDataDB): {unid: string; name: string; data: JsonDataDB;} => ({
    unid: 'p-1',
    name: 'demo',
    data: {
        unid: 'root',
        name: 'root',
        type: JsonDataDBType.root,
        entrys: [db],
        tables: [],
        views: [],
        enums: []
    }
});

let container: HTMLElement;
let view: Treeview;

beforeEach(() => {
    document.body.replaceChildren();
    container = document.createElement('div');
    document.body.append(container);
    view = new Treeview(container);
});

const bucketLabels = (): string[] => Array.from(container.querySelectorAll('.treeview-bucket-label'))
.map(e => e.textContent?.trim() ?? '');

const bucketHints = (): string[] => Array.from(container.querySelectorAll('.treeview-bucket-empty-hint'))
.map(e => e.textContent?.trim() ?? '');

describe('Treeview — bucket rendering', () => {

    it('renders all five buckets unconditionally on a database', () => {
        const db = mkDb({tables: [mkTable('users')]});
        view.render([wrapProject(db)]);
        expect(bucketLabels()).toEqual([
            'EER diagrams (0)',
            'Tables (1)',
            'Views (0)',
            'Enums (0)',
            'Routines (0)'
        ]);
    });

    it('reflects the diagram count when the database carries layers', () => {
        const db = mkDb({
            tables: [mkTable('users')],
            diagrams: [{unid: 'L1', name: 'People', pos: {x: 0, y: 0}, width: 300, height: 200}]
        });
        view.render([wrapProject(db)]);
        expect(bucketLabels()[0]).toBe('EER diagrams (1)');
    });

    it('shows "+ Add X" hints in every empty bucket — including a fresh database', () => {
        view.render([wrapProject(mkDb())]);
        expect(bucketHints()).toEqual([
            '+ Add EER diagram',
            '+ Add table',
            '+ Add view',
            '+ Add enum',
            '+ Add routine'
        ]);
    });

    it('suppresses the hint when the bucket has any items', () => {
        const db = mkDb({tables: [mkTable('users')]});
        view.render([wrapProject(db)]);
        const tablesBucket = Array.from(container.querySelectorAll<HTMLElement>('.treeview-bucket'))
        .find(b => b.querySelector('.treeview-bucket-label')?.textContent?.startsWith('Tables'));
        expect(tablesBucket?.querySelector('.treeview-bucket-empty-hint')).toBeNull();
    });

    it('suppresses hints entirely in live mode (read-only tree)', () => {
        view.setMode('live');
        view.render([wrapProject(mkDb())]);
        expect(bucketHints()).toEqual([]);
    });

});

describe('Treeview — empty-bucket hint click flow', () => {

    /*
     * Each hint opens a name prompt and then dispatches a create-in
     * event with `{containerUnid, name, ...extra}`. The container
     * unid is the parent database (NOT the runtime project UUID) —
     * required for the repo's tree walk to find the parent.
     */
    const stubPrompt = (returns: string | null): void => {
        (window as unknown as {prompt: (msg?: string, def?: string) => string | null;}).prompt = (): string | null => returns;
    };

    const clickHint = (label: string): void => {
        const hint = Array.from(container.querySelectorAll<HTMLElement>('.treeview-bucket-empty-hint'))
        .find(e => e.textContent?.trim() === label);
        if (!hint) {throw new Error(`hint "${label}" not found`);}
        hint.click();
    };

    const captureEvent = <T,>(name: string): T[] => {
        const out: T[] = [];
        window.addEventListener(name, (e) => out.push((e as CustomEvent).detail as T));
        return out;
    };

    it('"+ Add table" prompts then dispatches createTableIn with {containerUnid, name}', () => {
        stubPrompt('orders');
        const events = captureEvent<{containerUnid: string; name: string;}>(EditorEvents.createTableIn);
        view.render([wrapProject(mkDb({unid: 'db-X'}))]);
        clickHint('+ Add table');
        expect(events).toEqual([{containerUnid: 'db-X', name: 'orders'}]);
    });

    it('"+ Add routine" carries the procedure kind in the payload', () => {
        stubPrompt('sp_calc');
        const events = captureEvent<{containerUnid: string; name: string; kind: string;}>(EditorEvents.createRoutineIn);
        view.render([wrapProject(mkDb({unid: 'db-X'}))]);
        clickHint('+ Add routine');
        expect(events).toEqual([{containerUnid: 'db-X', name: 'sp_calc', kind: JsonRoutineKind.procedure}]);
    });

    it('cancelling the prompt skips the dispatch', () => {
        stubPrompt(null);
        const events = captureEvent<unknown>(EditorEvents.createViewIn);
        view.render([wrapProject(mkDb())]);
        clickHint('+ Add view');
        expect(events).toEqual([]);
    });

    it('whitespace-only name skips the dispatch (trim() yields empty)', () => {
        stubPrompt('   ');
        const events = captureEvent<unknown>(EditorEvents.createEnumIn);
        view.render([wrapProject(mkDb())]);
        clickHint('+ Add enum');
        expect(events).toEqual([]);
    });

});

describe('Treeview — Modell / Live mode bar', () => {

    it('renders the live badge with the connection count when > 0', () => {
        view.setConnectableDatabaseUnids(['db-1', 'db-2', 'db-3']);
        view.render([wrapProject(mkDb())]);
        const badge = container.querySelector('.treeview-modebar-badge');
        expect(badge).not.toBeNull();
        expect(badge?.textContent).toBe('3');
        const liveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('.treeview-modebar-btn'))
        .find(b => b.textContent?.startsWith('Live'));
        expect(liveBtn?.title).toBe('3 live DB connections configured');
    });

    it('omits the badge when no connections are configured', () => {
        view.render([wrapProject(mkDb())]);
        expect(container.querySelector('.treeview-modebar-badge')).toBeNull();
        const liveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('.treeview-modebar-btn'))
        .find(b => b.textContent?.startsWith('Live'));
        expect(liveBtn?.title).toBe('No live DB connections — add one in dbeditor.json');
    });

});