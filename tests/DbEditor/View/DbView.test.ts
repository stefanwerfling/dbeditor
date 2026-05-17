// @vitest-environment happy-dom
/*
 * DOM tests for the view-card ⋯ menu. Mirrors DbTable's coverage:
 * conditional Remove-from-diagram entry, payload of the dispatched
 * event. jsPlumb stubbed since the menu render doesn't touch it.
 */
import {beforeEach, describe, expect, it} from 'vitest';
import type {BrowserJsPlumbInstance} from '@jsplumb/browser-ui';
import {DbView} from '../../../DbEditor/View/DbView.js';
import {EditorEvents} from '../../../DbEditor/Base/EditorEvents.js';
import {JsonView} from '../../../DbEditor/JsonData.js';

const mkView = (over: Partial<JsonView> = {}): JsonView => ({
    unid: 'v-active',
    name: 'active_users',
    pos: {x: 0, y: 0},
    select: 'SELECT * FROM users WHERE active = 1',
    ...over
});

const jspStub = {} as BrowserJsPlumbInstance;

const openMenuAndReadItems = (card: HTMLElement): string[] => {
    const more = card.querySelector<HTMLButtonElement>('.db-view-header-action');
    if (!more) {throw new Error('more button missing');}
    more.click();
    return Array.from(document.querySelectorAll('.context-menu-item-label'))
    .map(e => e.textContent?.trim() ?? '');
};

beforeEach(() => {
    document.body.replaceChildren();
});

describe('DbView — ⋯ menu items', () => {

    it('unscoped: no "Remove from" entry', () => {
        const view = new DbView(mkView(), jspStub);
        document.body.append(view.element);
        expect(openMenuAndReadItems(view.element)).toEqual([
            'Edit body…',
            'Assign to EER diagram…',
            'Delete view'
        ]);
    });

    it('scoped: inserts "Remove from <diagram>" between Assign and Delete', () => {
        const view = new DbView(mkView(), jspStub, {unid: 'L1', name: 'Authoring'});
        document.body.append(view.element);
        expect(openMenuAndReadItems(view.element)).toEqual([
            'Edit body…',
            'Assign to EER diagram…',
            'Remove from "Authoring"',
            'Delete view'
        ]);
    });

    it('clicking Remove dispatches removeViewFromDiagram with the right payload', () => {
        const view = new DbView(mkView({unid: 'v-target'}), jspStub, {unid: 'diagram-x', name: 'Auth'});
        document.body.append(view.element);
        const events: {viewUnid: string; diagramUnid: string;}[] = [];
        const listener = (e: Event): void => {
            events.push((e as CustomEvent).detail as {viewUnid: string; diagramUnid: string;});
        };
        window.addEventListener(EditorEvents.removeViewFromDiagram, listener);
        try {
            openMenuAndReadItems(view.element);
            const removeBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu-item'))
            .find(b => b.textContent?.includes('Remove from'));
            removeBtn?.click();
            expect(events).toEqual([{viewUnid: 'v-target', diagramUnid: 'diagram-x'}]);
        } finally {
            window.removeEventListener(EditorEvents.removeViewFromDiagram, listener);
        }
    });

    it('clicking Assign dispatches pickDiagramForView with the view unid', () => {
        const view = new DbView(mkView({unid: 'v-pick'}), jspStub);
        document.body.append(view.element);
        const events: {viewUnid: string;}[] = [];
        const listener = (e: Event): void => {
            events.push((e as CustomEvent).detail as {viewUnid: string;});
        };
        window.addEventListener(EditorEvents.pickDiagramForView, listener);
        try {
            openMenuAndReadItems(view.element);
            const assignBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu-item'))
            .find(b => b.textContent?.includes('Assign'));
            assignBtn?.click();
            expect(events).toEqual([{viewUnid: 'v-pick'}]);
        } finally {
            window.removeEventListener(EditorEvents.pickDiagramForView, listener);
        }
    });

});