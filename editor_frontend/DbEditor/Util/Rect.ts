/**
 * Rectangle math used by the rubber-band selection. We deliberately accept
 * the `DOMRect`-shaped tuple (`{left, right, top, bottom}`) rather than
 * `(x, y, w, h)` because the browser's `getBoundingClientRect()` already
 * returns that shape — no conversion needed at the call site.
 *
 * Coordinates are right-handed pixel space (y grows downward) and units
 * are irrelevant: pass two rects in the same coordinate system and the
 * result is correct. Edge-touching rectangles count as *not* intersecting
 * — overlap must be strict so a 0-pixel-wide rubber-band doesn't grab
 * everything it brushes past.
 */
export type Rect = {
    left: number;
    right: number;
    top: number;
    bottom: number;
};

export class Rects {

    public static intersect(a: Rect, b: Rect): boolean {
        return a.left < b.right
            && a.right > b.left
            && a.top < b.bottom
            && a.bottom > b.top;
    }

    /**
     * Build a `Rect` from two arbitrary corner points. Used while a
     * rubber-band drag is in progress — `start` is the mousedown position,
     * `end` is the current mouse position; the resulting rect is the
     * axis-aligned bounding box of the two.
     */
    public static fromCorners(
        start: { x: number; y: number; },
        end: { x: number; y: number; }
    ): Rect {
        return {
            left: Math.min(start.x, end.x),
            right: Math.max(start.x, end.x),
            top: Math.min(start.y, end.y),
            bottom: Math.max(start.y, end.y)
        };
    }

}