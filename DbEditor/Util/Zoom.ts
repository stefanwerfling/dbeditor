/**
 * Canvas zoom math. Pure functions only — DOM/transform/setZoom side
 * effects live in `DbEditor.ts`.
 *
 * Levels are stored as floats; we snap to a fixed step ladder (25 %
 * apart) so successive +/− clicks land on round percentages and never
 * accumulate floating-point drift. Out-of-range inputs clamp instead
 * of erroring — coming from disk, the persisted value might be stale
 * after a min/max change in code.
 */

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2.5;
export const ZOOM_DEFAULT = 1;
const ZOOM_STEP = 0.25;
const EPSILON = 0.001;

export const clampZoom = (level: number): number => {
    if (!Number.isFinite(level)) {return ZOOM_DEFAULT;}
    if (level < ZOOM_MIN) {return ZOOM_MIN;}
    if (level > ZOOM_MAX) {return ZOOM_MAX;}
    return level;
};

/**
 * Snap `level` onto the 0.25-step ladder. Used after a +/− click so the
 * label is always a round percentage. Off-ladder inputs (e.g. from disk
 * or a future wheel-zoom) snap to the nearest step.
 */
export const snapToStep = (level: number): number => {
    const snapped = Math.round(level / ZOOM_STEP) * ZOOM_STEP;
    return clampZoom(snapped);
};

/**
 * Step zoom one notch in `direction`. `+1` zooms in, `-1` zooms out. The
 * current level is snapped first so a starting odd value (e.g. 1.07 from
 * a wheel zoom) converges back onto the ladder.
 */
export const stepZoom = (current: number, direction: 1 | -1): number => {
    const snapped = snapToStep(current);
    return clampZoom(snapped + (direction * ZOOM_STEP));
};

export const formatZoom = (level: number): string => {
    return `${Math.round(clampZoom(level) * 100)}%`;
};

export const isAtDefault = (level: number): boolean => {
    return Math.abs(clampZoom(level) - ZOOM_DEFAULT) < EPSILON;
};

/**
 * Compute the scroll position to keep the world point currently under the
 * cursor under the cursor after the zoom changes from `fromZoom` to
 * `toZoom`. Coordinates:
 *   - `cursorX/Y` are in viewport-relative (scroll-container) pixels
 *   - `currentScrollX/Y` are `#dbgrid`'s scrollLeft/scrollTop
 *
 * Math: a world point under the cursor lives at `(scroll + cursor) /
 * zoom` in unscaled coords; we want that same world point to remain at
 * `cursor` after the zoom change — so the new scroll is
 * `worldPoint * newZoom - cursor`, which simplifies to the form below.
 */
export const zoomFocalScroll = (
    fromZoom: number,
    toZoom: number,
    cursorX: number,
    cursorY: number,
    currentScrollX: number,
    currentScrollY: number
): { scrollX: number; scrollY: number; } => {
    if (fromZoom <= 0) {return {scrollX: currentScrollX, scrollY: currentScrollY};}
    const ratio = toZoom / fromZoom;
    return {
        scrollX: ((currentScrollX + cursorX) * ratio) - cursorX,
        scrollY: ((currentScrollY + cursorY) * ratio) - cursorY
    };
};