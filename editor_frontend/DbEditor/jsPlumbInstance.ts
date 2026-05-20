import {newInstance, BrowserJsPlumbInstance} from '@jsplumb/browser-ui';

/**
 * Lazy singleton jsPlumb instance bound to `#dbgrid`. We keep a single
 * shared instance because connections (foreign keys) are global to the
 * canvas, not per-table.
 *
 * Source/target selectors are registered once on creation so any column
 * row rendered later (after a re-render) is automatically draggable
 * into a new connection — selectors are matched dynamically by CSS
 * class.
 */
export class JsPlumbHost {

    private static _instance: BrowserJsPlumbInstance | null = null;

    /**
     * Compute a `[side, yRatio, dx, 0]` anchor on the table card that
     * contains `rowEl`. The y position is the centre of the row relative
     * to the card. `side` defaults to `right`; the persisted FK render
     * pass flips it later based on the actual relative position of the
     * two cards, so the draft looking slightly off mid-drag is
     * acceptable. Returns `null` when the row's enclosing `.db-table`
     * can't be located.
     */
    private static _anchorForRow(rowEl: Element, side: 'left' | 'right' = 'right'): [number, number, number, number] | null {
        const row = rowEl as HTMLElement;
        const card = row.closest('.db-table') as HTMLElement | null;
        if (!card) {return null;}
        /*
         * If the matched element is the grip-span, walk up one level to
         * the `.db-table-column` row whose rect is the right one to
         * measure.
         */
        const positioningRow = row.classList.contains('db-table-column-grip')
            ? (row.closest('.db-table-column') as HTMLElement | null) ?? row
            : row;
        /*
         * Use viewport rects rather than offsetTop/offsetHeight: the
         * `.db-table-columns` wrapper is `position: relative` (to host
         * the drag-reorder drop indicator), which makes IT the row's
         * `offsetParent` — so `offsetTop` would measure inside the
         * wrapper, not from the card top. The viewport-rect delta
         * gives the actual row-center-within-the-card.
         */
        const cardRect = card.getBoundingClientRect();
        const rowRect = positioningRow.getBoundingClientRect();
        const cardH = cardRect.height || 1;
        const rowCenter = (rowRect.top - cardRect.top) + (rowRect.height / 2);
        const yRatio = Math.max(0, Math.min(1, rowCenter / cardH));
        const x = side === 'right' ? 1 : 0;
        const dx = side === 'right' ? 1 : -1;
        return [x, yRatio, dx, 0];
    }

    public static getInstance(): BrowserJsPlumbInstance {
        if (JsPlumbHost._instance) {
            return JsPlumbHost._instance;
        }
        /*
         * Container is the *inner* zoom wrapper. CSS `transform: scale(z)` on
         * this element visually scales every card + connection together, and
         * `BrowserJsPlumbInstance.setZoom(z)` keeps drag math + anchor coords
         * accurate in the unscaled coordinate system.
         */
        const container = (document.getElementById('dbgrid-zoom') ?? document.getElementById('dbgrid')) as HTMLElement;
        /*
         * Flowchart connector (orthogonal right-angle routing) instead of
         * Bezier. Reason: with bezier curves the line "curves into" the
         * destination card from above, visually appearing to enter the
         * header area regardless of which column row is the actual
         * anchor target. Orthogonal lines come straight out of the
         * column row horizontally, bend once or twice at 90°, and land
         * straight back on the destination column row — so the user
         * can trace exactly which column connects to which, like
         * dbdiagram.io / Workbench's relational notation.
         *
         * `stub: 24` is the horizontal segment length before the first
         * bend; keeps short connections from collapsing into the cards.
         * `cornerRadius: 4` softens the corners just enough to avoid
         * a sharp-edged technical look without losing the "I see the
         * right-angle" affordance.
         */
        const instance = newInstance({
            container: container,
            connector: {type: 'Flowchart', options: {stub: 24, cornerRadius: 4, alwaysRespectStubs: true}},
            paintStyle: {strokeWidth: 1.5, stroke: '#3e9c8a'} as Record<string, unknown>,
            endpoint: 'Blank',
            anchors: ['Right', 'Left'],
            hoverPaintStyle: {strokeWidth: 2.5, stroke: '#3e9c8a'} as Record<string, unknown>
        });

        /*
         * jsPlumb's `extract` option reads attributes from the matched
         * element (the grip on source, the column row on target) and
         * writes them to `endpoint.parameters` via `mergeParameters` —
         * that's the documented path to surface DOM data on the
         * connection event.
         */
        const EXTRACT = {
            'data-column-unid': 'columnUnid',
            'data-table-unid': 'tableUnid'
        };

        /*
         * Source: row-anchored draft line. The grip's row centre becomes
         * the anchor's y; side defaults to right (the grip lives on the
         * right edge of the card). Falling back to `Continuous` keeps
         * the old behaviour if measurement ever fails.
         */
        instance.addSourceSelector('.db-table-column-grip', {
            anchor: 'Continuous',
            anchorPositionFinder: (el: Element): [number, number, number, number] | null =>
                JsPlumbHost._anchorForRow(el, 'right'),
            endpoint: {type: 'Dot', options: {radius: 3}} as Record<string, unknown>,
            edgeType: 'fk-draft',
            extract: EXTRACT
        } as Record<string, unknown>);

        /* Target: column-row drop. Anchor on the matched row's centre, left side. */
        instance.addTargetSelector('.db-table-column', {
            anchor: 'Continuous',
            anchorPositionFinder: (el: Element): [number, number, number, number] | null =>
                JsPlumbHost._anchorForRow(el, 'left'),
            endpoint: 'Blank',
            edgeType: 'fk-draft',
            extract: EXTRACT
        } as Record<string, unknown>);

        /*
         * Target: drop on the card itself (NOT a specific column row).
         * Used by the auto-column flow — when the user drops a FK draft
         * onto a table card without aiming at a row, we create the
         * matching column server-side and then create the FK. The
         * selector deliberately matches the card header so we don't
         * hijack drops inside the column-list area (where the row-level
         * selector takes precedence).
         *
         * The header carries `data-table-unid` via the parent `.db-table`
         * — we extract it through the closest-ancestor lookup in
         * `extract`. Falling back to `Continuous` anchor for the visual.
         */
        instance.addTargetSelector('.db-table-header', {
            anchor: 'Continuous',
            anchorPositionFinder: (el: Element): [number, number, number, number] | null =>
                JsPlumbHost._anchorForRow(el, 'left'),
            endpoint: 'Blank',
            edgeType: 'fk-draft',
            extract: {
                /*
                 * The header doesn't itself have `data-table-unid` (that's
                 * on the parent `.db-table` card), but jsPlumb's `extract`
                 * reads direct attributes only. We surface the table unid
                 * via the connection event by reading the closest ancestor
                 * in `_bindJsPlumb` instead — see the fallback there.
                 */
                'data-table-unid': 'tableUnid'
            }
        } as Record<string, unknown>);

        JsPlumbHost._instance = instance;
        return instance;
    }

    public static reset(): void {
        if (JsPlumbHost._instance) {
            JsPlumbHost._instance.destroy();
            JsPlumbHost._instance = null;
        }
    }

}