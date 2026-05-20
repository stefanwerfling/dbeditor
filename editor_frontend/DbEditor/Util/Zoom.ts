/**
 * Canvas zoom math. Pure static methods only — DOM/transform/setZoom side
 * effects live in `DbEditor.ts`.
 *
 * Levels are stored as floats; we snap to a fixed step ladder (25 %
 * apart) so successive +/− clicks land on round percentages and never
 * accumulate floating-point drift. Out-of-range inputs clamp instead
 * of erroring — coming from disk, the persisted value might be stale
 * after a min/max change in code.
 */
export class Zoom {

    public static readonly MIN = 0.25;
    public static readonly MAX = 2.5;
    public static readonly DEFAULT = 1;
    private static readonly STEP = 0.25;
    private static readonly EPSILON = 0.001;

    public static clamp(level: number): number {
        if (!Number.isFinite(level)) {return Zoom.DEFAULT;}
        if (level < Zoom.MIN) {return Zoom.MIN;}
        if (level > Zoom.MAX) {return Zoom.MAX;}
        return level;
    }

    /**
     * Snap `level` onto the 0.25-step ladder. Used after a +/− click so the
     * label is always a round percentage. Off-ladder inputs (e.g. from disk
     * or a future wheel-zoom) snap to the nearest step.
     */
    public static snapToStep(level: number): number {
        const snapped = Math.round(level / Zoom.STEP) * Zoom.STEP;
        return Zoom.clamp(snapped);
    }

    /**
     * Step zoom one notch in `direction`. `+1` zooms in, `-1` zooms out. The
     * current level is snapped first so a starting odd value (e.g. 1.07 from
     * a wheel zoom) converges back onto the ladder.
     */
    public static step(current: number, direction: 1 | -1): number {
        const snapped = Zoom.snapToStep(current);
        return Zoom.clamp(snapped + (direction * Zoom.STEP));
    }

    public static format(level: number): string {
        return `${Math.round(Zoom.clamp(level) * 100)}%`;
    }

    public static isAtDefault(level: number): boolean {
        return Math.abs(Zoom.clamp(level) - Zoom.DEFAULT) < Zoom.EPSILON;
    }

    /**
     * Compute the scroll position to keep the world point currently under
     * the cursor under the cursor after the zoom changes from `fromZoom` to
     * `toZoom`. Coordinates:
     *   - `cursorX/Y` are in viewport-relative (scroll-container) pixels
     *   - `currentScrollX/Y` are `#dbgrid`'s scrollLeft/scrollTop
     *
     * Math: a world point under the cursor lives at `(scroll + cursor) /
     * zoom` in unscaled coords; we want that same world point to remain at
     * `cursor` after the zoom change — so the new scroll is
     * `worldPoint * newZoom - cursor`, which simplifies to the form below.
     */
    public static focalScroll(
        fromZoom: number,
        toZoom: number,
        cursorX: number,
        cursorY: number,
        currentScrollX: number,
        currentScrollY: number
    ): { scrollX: number; scrollY: number; } {
        if (fromZoom <= 0) {return {scrollX: currentScrollX, scrollY: currentScrollY};}
        const ratio = toZoom / fromZoom;
        return {
            scrollX: ((currentScrollX + cursorX) * ratio) - cursorX,
            scrollY: ((currentScrollY + cursorY) * ratio) - cursorY
        };
    }

}