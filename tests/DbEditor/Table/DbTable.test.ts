// @vitest-environment happy-dom
/*
 * DOM tests for the table-card ⋯ menu. Covers the conditional
 * "Remove from <diagram>" entry that's only present when the canvas
 * is scoped to a single EER diagram, and the corresponding event
 * dispatched on click.
 *
 * jsPlumb is mocked as an empty object — the menu render path
 * doesn't touch it; we never call attach()/destroy().
 */
import {beforeEach, describe, expect, it} from 'vitest';
import type {BrowserJsPlumbInstance} from '@jsplumb/browser-ui';
import {DbTable} from '../../../DbEditor/Table/DbTable.js';
import {EditorEvents} from '../../../DbEditor/Base/EditorEvents.js';
import {JsonTable} from '../../../DbEditor/JsonData.js';

const mkTable = (over: Partial<JsonTable> = {}): JsonTable => ({
    unid: 't-users',
    name: 'users',
    pos: {x: 0, y: 0},
    columns: [{unid: 'c1', name: 'id', type: 'int', primaryKey: true}],
    indexes: [],
    foreignKeys: [],
    ...over
});

const jspStub = {} as BrowserJsPlumbInstance;

const openMenuAndReadItems = (card: HTMLElement): string[] => {
    const more = card.querySelector<HTMLButtonElement>('.db-table-header-action');
    if (!more) {throw new Error('more button missing');}
    more.click();
    return Array.from(document.querySelectorAll('.context-menu-item-label'))
    .map(e => e.textContent?.trim() ?? '');
};

beforeEach(() => {
    document.body.replaceChildren();
});

describe('DbTable — ⋯ menu items', () => {

    it('unscoped: no "Remove from" entry', () => {
        const tbl = new DbTable(mkTable(), jspStub, []);
        document.body.append(tbl.element);
        expect(openMenuAndReadItems(tbl.element)).toEqual([
            'Rename table',
            'Table options…',
            'Assign to EER diagram…',
            'Duplicate',
            'Delete table'
        ]);
    });

    it('scoped: adds a "Remove from <diagram>" entry with the diagram name in quotes', () => {
        const tbl = new DbTable(mkTable(), jspStub, [], {unid: 'L1', name: 'Authoring'});
        document.body.append(tbl.element);
        expect(openMenuAndReadItems(tbl.element)).toEqual([
            'Rename table',
            'Table options…',
            'Assign to EER diagram…',
            'Remove from "Authoring"',
            'Duplicate',
            'Delete table'
        ]);
    });

    it('clicking "Remove from …" dispatches removeTableFromDiagram with the right payload', async() => {
        const tbl = new DbTable(mkTable({unid: 't-target'}), jspStub, [], {unid: 'diagram-x', name: 'Auth'});
        document.body.append(tbl.element);
        const events: {tableUnid: string; diagramUnid: string;}[] = [];
        const listener = (e: Event): void => {
            events.push((e as CustomEvent).detail as {tableUnid: string; diagramUnid: string;});
        };
        window.addEventListener(EditorEvents.removeTableFromDiagram, listener);
        try {
            openMenuAndReadItems(tbl.element);
            const removeBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu-item'))
            .find(b => b.textContent?.includes('Remove from'));
            removeBtn?.click();
            expect(events).toEqual([{tableUnid: 't-target', diagramUnid: 'diagram-x'}]);
        } finally {
            window.removeEventListener(EditorEvents.removeTableFromDiagram, listener);
        }
    });

});