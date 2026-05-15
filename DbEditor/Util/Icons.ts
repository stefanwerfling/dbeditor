/**
 * Inline-SVG icon factory.
 *
 * Why not unicode glyphs: blocks like Misc-Symbols (U+26xx) — which
 * includes `⛶` and `⚠` — and even Geometric-Shapes-Extended (U+2B28)
 * aren't covered by every system's default font stack. On Linux
 * without `Symbola` / `Noto Sans Symbols` installed they render as
 * tofu boxes. SVG is font-independent: the icon renders identically
 * everywhere a modern browser does.
 *
 * Each factory returns a fresh `SVGSVGElement` configured to inherit
 * its color via `currentColor`. Callers control size + color via the
 * containing element's `font-size` / `color` (similar to how Heroicons
 * or Phosphor work).
 *
 * Icons are 1em square by default. To scale, set the parent's
 * font-size or override width/height via class.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const makeSvg = (viewBox: string, body: string): SVGSVGElement => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('xmlns', SVG_NS);
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('width', '1em');
    svg.setAttribute('height', '1em');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('icon');
    /*
     * innerHTML carries the body — viewBox-coordinated <path>/<circle>
     * markup defined per factory below. SVG parsing inside innerHTML
     * inherits the SVG namespace from the parent svg element so we
     * don't have to createElementNS per child node.
     */
    svg.innerHTML = body;
    return svg;
};

/** Three horizontal dots — replaces `⋯` (U+22EF). */
export const iconEllipsis = (): SVGSVGElement => makeSvg(
    '0 0 16 16',
    '<circle cx="3" cy="8" r="1.4" fill="currentColor"/>'
    + '<circle cx="8" cy="8" r="1.4" fill="currentColor"/>'
    + '<circle cx="13" cy="8" r="1.4" fill="currentColor"/>'
);

/** Down-pointing triangle — replaces `▾`. */
export const iconChevronDown = (): SVGSVGElement => makeSvg(
    '0 0 16 16',
    '<path d="M3 6l5 5 5-5z" fill="currentColor"/>'
);

/** Right-pointing triangle — replaces `▸`. */
export const iconChevronRight = (): SVGSVGElement => makeSvg(
    '0 0 16 16',
    '<path d="M6 3l5 5-5 5z" fill="currentColor"/>'
);

/** Rectangle outline — replaces `▭` (used as the "layer" icon). */
export const iconRect = (): SVGSVGElement => makeSvg(
    '0 0 16 16',
    '<rect x="2" y="4" width="12" height="8" stroke="currentColor" stroke-width="1.5" fill="none" rx="1"/>'
);

/** Filled diamond — replaces `◆` (used for unique-index marker). */
export const iconDiamondFilled = (): SVGSVGElement => makeSvg(
    '0 0 16 16',
    '<path d="M8 2l6 6-6 6-6-6z" fill="currentColor"/>'
);

/** Hollow diamond — replaces `◇` and `⬨` (non-unique index, enum icon). */
export const iconDiamondHollow = (): SVGSVGElement => makeSvg(
    '0 0 16 16',
    '<path d="M8 2l6 6-6 6-6-6z" fill="none" stroke="currentColor" stroke-width="1.5"/>'
);

/** Warning triangle — replaces `⚠` (U+26A0, Misc-Symbols block; high risk). */
export const iconWarning = (): SVGSVGElement => makeSvg(
    '0 0 16 16',
    '<path d="M8 2l6.5 11.5h-13z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'
    + '<rect x="7.3" y="6" width="1.4" height="4" fill="currentColor"/>'
    + '<rect x="7.3" y="11" width="1.4" height="1.4" fill="currentColor"/>'
);

/** Checkmark — replaces `✓`. Used for connection-test "OK" state. */
export const iconCheck = (): SVGSVGElement => makeSvg(
    '0 0 16 16',
    '<path d="M3 8.5l3.5 3.5L13 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
);

/** Cross — replaces `✗`. Used for connection-test "Fail" state. */
export const iconCross = (): SVGSVGElement => makeSvg(
    '0 0 16 16',
    '<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
);

/** Small middle dot — replaces `·` for "leaf" placeholder icon in the treeview. */
export const iconDot = (): SVGSVGElement => makeSvg(
    '0 0 16 16',
    '<circle cx="8" cy="8" r="1.6" fill="currentColor"/>'
);