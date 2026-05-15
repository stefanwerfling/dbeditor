import {describe, expect, it} from 'vitest';
import {Rect, rectFromCorners, rectsIntersect} from '../../DbEditor/Util/Rect.js';

const r = (left: number, top: number, right: number, bottom: number): Rect => ({
    left: left, top: top, right: right, bottom: bottom
});

describe('rectsIntersect', () => {

    it('true for overlapping rects', () => {
        expect(rectsIntersect(r(0, 0, 10, 10), r(5, 5, 15, 15))).toBe(true);
    });

    it('true for nested rects (b fully inside a)', () => {
        expect(rectsIntersect(r(0, 0, 100, 100), r(20, 20, 30, 30))).toBe(true);
    });

    it('false for disjoint rects', () => {
        expect(rectsIntersect(r(0, 0, 10, 10), r(20, 20, 30, 30))).toBe(false);
    });

    it('false for edge-touching rects (strict overlap)', () => {
        expect(rectsIntersect(r(0, 0, 10, 10), r(10, 0, 20, 10))).toBe(false);
        expect(rectsIntersect(r(0, 0, 10, 10), r(0, 10, 10, 20))).toBe(false);
    });

    it('symmetric', () => {
        const a = r(0, 0, 10, 10);
        const b = r(5, 5, 15, 15);
        expect(rectsIntersect(a, b)).toBe(rectsIntersect(b, a));
    });

    it('zero-area rect on a rect edge does NOT intersect (strict overlap)', () => {
        const point = r(0, 5, 0, 5);
        expect(rectsIntersect(point, r(0, 0, 10, 10))).toBe(false);
    });

    it('zero-area rect strictly inside another rect counts as intersecting', () => {
        const point = r(5, 5, 5, 5);
        expect(rectsIntersect(point, r(0, 0, 10, 10))).toBe(true);
    });

});

describe('rectFromCorners', () => {

    it('normalises top-left → bottom-right', () => {
        expect(rectFromCorners({x: 10, y: 20}, {x: 50, y: 60}))
        .toEqual({left: 10, top: 20, right: 50, bottom: 60});
    });

    it('normalises bottom-right → top-left (drag going up-left)', () => {
        expect(rectFromCorners({x: 50, y: 60}, {x: 10, y: 20}))
        .toEqual({left: 10, top: 20, right: 50, bottom: 60});
    });

    it('handles equal-x or equal-y (vertical / horizontal drag)', () => {
        expect(rectFromCorners({x: 30, y: 10}, {x: 30, y: 40}))
        .toEqual({left: 30, top: 10, right: 30, bottom: 40});
    });

});