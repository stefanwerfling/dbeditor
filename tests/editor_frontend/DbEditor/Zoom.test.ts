import {describe, expect, it} from 'vitest';
import {Zoom} from '../../../editor_frontend/DbEditor/Util/Zoom.js';

describe('Zoom.clamp', () => {

    it('passes through valid values', () => {
        expect(Zoom.clamp(1)).toBe(1);
        expect(Zoom.clamp(1.5)).toBe(1.5);
        expect(Zoom.clamp(0.5)).toBe(0.5);
    });

    it('clamps below min', () => {
        expect(Zoom.clamp(0.1)).toBe(Zoom.MIN);
        expect(Zoom.clamp(-5)).toBe(Zoom.MIN);
        expect(Zoom.clamp(0)).toBe(Zoom.MIN);
    });

    it('clamps above max', () => {
        expect(Zoom.clamp(10)).toBe(Zoom.MAX);
        expect(Zoom.clamp(2.9)).toBe(Zoom.MAX);
    });

    it('non-finite falls back to default', () => {
        expect(Zoom.clamp(NaN)).toBe(Zoom.DEFAULT);
        expect(Zoom.clamp(Infinity)).toBe(Zoom.DEFAULT);
        expect(Zoom.clamp(-Infinity)).toBe(Zoom.DEFAULT);
    });

});

describe('Zoom.snapToStep', () => {

    it('rounds to the 0.25 ladder', () => {
        expect(Zoom.snapToStep(1.1)).toBe(1);
        expect(Zoom.snapToStep(1.12)).toBe(1);
        expect(Zoom.snapToStep(1.13)).toBe(1.25);
        expect(Zoom.snapToStep(0.62)).toBe(0.5);
        expect(Zoom.snapToStep(0.63)).toBe(0.75);
    });

    it('snaps + clamps simultaneously', () => {
        expect(Zoom.snapToStep(0.01)).toBe(Zoom.MIN);
        expect(Zoom.snapToStep(99)).toBe(Zoom.MAX);
    });

});

describe('Zoom.step', () => {

    it('+1 goes up one notch', () => {
        expect(Zoom.step(1, 1)).toBe(1.25);
        expect(Zoom.step(0.5, 1)).toBe(0.75);
    });

    it('-1 goes down one notch', () => {
        expect(Zoom.step(1, -1)).toBe(0.75);
        expect(Zoom.step(0.5, -1)).toBe(Zoom.MIN);
    });

    it('snaps an off-ladder current value back onto the ladder first', () => {
        /* 1.07 snaps to 1.0, then +1 step → 1.25 */
        expect(Zoom.step(1.07, 1)).toBe(1.25);
        /* 0.91 snaps to 1.0, then -1 step → 0.75 */
        expect(Zoom.step(0.91, -1)).toBe(0.75);
    });

    it('clamps at the boundaries', () => {
        expect(Zoom.step(Zoom.MAX, 1)).toBe(Zoom.MAX);
        expect(Zoom.step(Zoom.MIN, -1)).toBe(Zoom.MIN);
    });

});

describe('Zoom.format', () => {

    it('renders percentage', () => {
        expect(Zoom.format(1)).toBe('100%');
        expect(Zoom.format(0.5)).toBe('50%');
        expect(Zoom.format(1.25)).toBe('125%');
    });

    it('clamps first', () => {
        expect(Zoom.format(5)).toBe(`${Math.round(Zoom.MAX * 100)}%`);
        expect(Zoom.format(NaN)).toBe('100%');
    });

});

describe('Zoom.focalScroll', () => {

    it('preserves the world point under the cursor when zooming in', () => {
        /*
         * Scroll = 100, cursor at viewport (50, 50). World point under
         * cursor = (100 + 50) / 1 = 150 (unscaled).
         * After zoom to 2x, want that same world point still at cursor 50:
         *   new scroll + 50 = 150 * 2 = 300  →  new scroll = 250.
         */
        const r = Zoom.focalScroll(1, 2, 50, 50, 100, 100);
        expect(r.scrollX).toBe(250);
        expect(r.scrollY).toBe(250);
    });

    it('preserves the world point under the cursor when zooming out', () => {
        /*
         * Inverse: scroll = 250, cursor at (50, 50), zoom 2 → 1.
         * World point = (250 + 50) / 2 = 150. After zoom: scroll + 50 = 150 → 100.
         */
        const r = Zoom.focalScroll(2, 1, 50, 50, 250, 250);
        expect(r.scrollX).toBe(100);
        expect(r.scrollY).toBe(100);
    });

    it('cursor at origin scales the scroll proportionally', () => {
        /* cursor=(0,0): new scroll = currentScroll * ratio */
        const r = Zoom.focalScroll(1, 2, 0, 0, 100, 200);
        expect(r.scrollX).toBe(200);
        expect(r.scrollY).toBe(400);
    });

    it('returns same scroll when zoom unchanged', () => {
        const r = Zoom.focalScroll(1.5, 1.5, 30, 30, 80, 80);
        expect(r.scrollX).toBe(80);
        expect(r.scrollY).toBe(80);
    });

    it('guards against fromZoom = 0', () => {
        const r = Zoom.focalScroll(0, 1, 50, 50, 100, 100);
        expect(r.scrollX).toBe(100);
        expect(r.scrollY).toBe(100);
    });

});

describe('Zoom.isAtDefault', () => {

    it('true for exact 1.0', () => {
        expect(Zoom.isAtDefault(1)).toBe(true);
    });

    it('true for within-epsilon values', () => {
        expect(Zoom.isAtDefault(1.0001)).toBe(true);
    });

    it('false for other levels', () => {
        expect(Zoom.isAtDefault(0.5)).toBe(false);
        expect(Zoom.isAtDefault(1.25)).toBe(false);
    });

});