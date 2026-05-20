import {describe, expect, it} from 'vitest';
import {Rect, Rects} from '../../../editor_frontend/DbEditor/Util/Rect.js';

const r = (left: number, top: number, right: number, bottom: number): Rect => ({
    left: left, top: top, right: right, bottom: bottom
});

describe('Rects.intersect', () => {

    it('true for overlapping rects', () => {
        expect(Rects.intersect(r(0, 0, 10, 10), r(5, 5, 15, 15))).toBe(true);
    });

    it('true for nested rects (b fully inside a)', () => {
        expect(Rects.intersect(r(0, 0, 100, 100), r(20, 20, 30, 30))).toBe(true);
    });

    it('false for disjoint rects', () => {
        expect(Rects.intersect(r(0, 0, 10, 10), r(20, 20, 30, 30))).toBe(false);
    });

    it('false for edge-touching rects (strict overlap)', () => {
        expect(Rects.intersect(r(0, 0, 10, 10), r(10, 0, 20, 10))).toBe(false);
        expect(Rects.intersect(r(0, 0, 10, 10), r(0, 10, 10, 20))).toBe(false);
    });

    it('symmetric', () => {
        const a = r(0, 0, 10, 10);
        const b = r(5, 5, 15, 15);
        expect(Rects.intersect(a, b)).toBe(Rects.intersect(b, a));
    });

    it('zero-area rect on a rect edge does NOT intersect (strict overlap)', () => {
        const point = r(0, 5, 0, 5);
        expect(Rects.intersect(point, r(0, 0, 10, 10))).toBe(false);
    });

    it('zero-area rect strictly inside another rect counts as intersecting', () => {
        const point = r(5, 5, 5, 5);
        expect(Rects.intersect(point, r(0, 0, 10, 10))).toBe(true);
    });

});

describe('Rects.fromCorners', () => {

    it('normalises top-left → bottom-right', () => {
        expect(Rects.fromCorners({x: 10, y: 20}, {x: 50, y: 60}))
        .toEqual({left: 10, top: 20, right: 50, bottom: 60});
    });

    it('normalises bottom-right → top-left (drag going up-left)', () => {
        expect(Rects.fromCorners({x: 50, y: 60}, {x: 10, y: 20}))
        .toEqual({left: 10, top: 20, right: 50, bottom: 60});
    });

    it('handles equal-x or equal-y (vertical / horizontal drag)', () => {
        expect(Rects.fromCorners({x: 30, y: 10}, {x: 30, y: 40}))
        .toEqual({left: 30, top: 10, right: 30, bottom: 40});
    });

});