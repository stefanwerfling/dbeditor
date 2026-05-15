import {describe, expect, it} from 'vitest';
import {
    ZOOM_DEFAULT,
    ZOOM_MAX,
    ZOOM_MIN,
    clampZoom,
    formatZoom,
    isAtDefault,
    snapToStep,
    stepZoom,
    zoomFocalScroll
} from '../../DbEditor/Util/Zoom.js';

describe('clampZoom', () => {

    it('passes through valid values', () => {
        expect(clampZoom(1)).toBe(1);
        expect(clampZoom(1.5)).toBe(1.5);
        expect(clampZoom(0.5)).toBe(0.5);
    });

    it('clamps below min', () => {
        expect(clampZoom(0.1)).toBe(ZOOM_MIN);
        expect(clampZoom(-5)).toBe(ZOOM_MIN);
        expect(clampZoom(0)).toBe(ZOOM_MIN);
    });

    it('clamps above max', () => {
        expect(clampZoom(10)).toBe(ZOOM_MAX);
        expect(clampZoom(2.9)).toBe(ZOOM_MAX);
    });

    it('non-finite falls back to default', () => {
        expect(clampZoom(NaN)).toBe(ZOOM_DEFAULT);
        expect(clampZoom(Infinity)).toBe(ZOOM_DEFAULT);
        expect(clampZoom(-Infinity)).toBe(ZOOM_DEFAULT);
    });

});

describe('snapToStep', () => {

    it('rounds to the 0.25 ladder', () => {
        expect(snapToStep(1.1)).toBe(1);
        expect(snapToStep(1.12)).toBe(1);
        expect(snapToStep(1.13)).toBe(1.25);
        expect(snapToStep(0.62)).toBe(0.5);
        expect(snapToStep(0.63)).toBe(0.75);
    });

    it('snaps + clamps simultaneously', () => {
        expect(snapToStep(0.01)).toBe(ZOOM_MIN);
        expect(snapToStep(99)).toBe(ZOOM_MAX);
    });

});

describe('stepZoom', () => {

    it('+1 goes up one notch', () => {
        expect(stepZoom(1, 1)).toBe(1.25);
        expect(stepZoom(0.5, 1)).toBe(0.75);
    });

    it('-1 goes down one notch', () => {
        expect(stepZoom(1, -1)).toBe(0.75);
        expect(stepZoom(0.5, -1)).toBe(ZOOM_MIN);
    });

    it('snaps an off-ladder current value back onto the ladder first', () => {
        /* 1.07 snaps to 1.0, then +1 step → 1.25 */
        expect(stepZoom(1.07, 1)).toBe(1.25);
        /* 0.91 snaps to 1.0, then -1 step → 0.75 */
        expect(stepZoom(0.91, -1)).toBe(0.75);
    });

    it('clamps at the boundaries', () => {
        expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
        expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
    });

});

describe('formatZoom', () => {

    it('renders percentage', () => {
        expect(formatZoom(1)).toBe('100%');
        expect(formatZoom(0.5)).toBe('50%');
        expect(formatZoom(1.25)).toBe('125%');
    });

    it('clamps first', () => {
        expect(formatZoom(5)).toBe(`${Math.round(ZOOM_MAX * 100)}%`);
        expect(formatZoom(NaN)).toBe('100%');
    });

});

describe('zoomFocalScroll', () => {

    it('preserves the world point under the cursor when zooming in', () => {
        /*
         * Scroll = 100, cursor at viewport (50, 50). World point under
         * cursor = (100 + 50) / 1 = 150 (unscaled).
         * After zoom to 2x, want that same world point still at cursor 50:
         *   new scroll + 50 = 150 * 2 = 300  →  new scroll = 250.
         */
        const r = zoomFocalScroll(1, 2, 50, 50, 100, 100);
        expect(r.scrollX).toBe(250);
        expect(r.scrollY).toBe(250);
    });

    it('preserves the world point under the cursor when zooming out', () => {
        /*
         * Inverse: scroll = 250, cursor at (50, 50), zoom 2 → 1.
         * World point = (250 + 50) / 2 = 150. After zoom: scroll + 50 = 150 → 100.
         */
        const r = zoomFocalScroll(2, 1, 50, 50, 250, 250);
        expect(r.scrollX).toBe(100);
        expect(r.scrollY).toBe(100);
    });

    it('cursor at origin scales the scroll proportionally', () => {
        /* cursor=(0,0): new scroll = currentScroll * ratio */
        const r = zoomFocalScroll(1, 2, 0, 0, 100, 200);
        expect(r.scrollX).toBe(200);
        expect(r.scrollY).toBe(400);
    });

    it('returns same scroll when zoom unchanged', () => {
        const r = zoomFocalScroll(1.5, 1.5, 30, 30, 80, 80);
        expect(r.scrollX).toBe(80);
        expect(r.scrollY).toBe(80);
    });

    it('guards against fromZoom = 0', () => {
        const r = zoomFocalScroll(0, 1, 50, 50, 100, 100);
        expect(r.scrollX).toBe(100);
        expect(r.scrollY).toBe(100);
    });

});

describe('isAtDefault', () => {

    it('true for exact 1.0', () => {
        expect(isAtDefault(1)).toBe(true);
    });

    it('true for within-epsilon values', () => {
        expect(isAtDefault(1.0001)).toBe(true);
    });

    it('false for other levels', () => {
        expect(isAtDefault(0.5)).toBe(false);
        expect(isAtDefault(1.25)).toBe(false);
    });

});