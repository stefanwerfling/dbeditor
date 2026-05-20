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
 * Each method returns a fresh `SVGSVGElement` configured to inherit
 * its color via `currentColor`. Callers control size + color via the
 * containing element's `font-size` / `color` (similar to how Heroicons
 * or Phosphor work).
 *
 * Icons are 1em square by default. To scale, set the parent's
 * font-size or override width/height via class.
 *
 * Plugins that need custom icons subclass `Icons` and call
 * `Icons.makeSvg(viewBox, body)` to build entries matching the
 * size/color convention.
 */
export class Icons {

    private static readonly SVG_NS = 'http://www.w3.org/2000/svg';

    protected static makeSvg(viewBox: string, body: string): SVGSVGElement {
        const svg = document.createElementNS(Icons.SVG_NS, 'svg');
        svg.setAttribute('xmlns', Icons.SVG_NS);
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
    }

    /** Three horizontal dots — replaces `⋯` (U+22EF). */
    public static ellipsis(): SVGSVGElement {
        return Icons.makeSvg(
            '0 0 16 16',
            '<circle cx="3" cy="8" r="1.4" fill="currentColor"/>'
            + '<circle cx="8" cy="8" r="1.4" fill="currentColor"/>'
            + '<circle cx="13" cy="8" r="1.4" fill="currentColor"/>'
        );
    }

    /** Down-pointing triangle — replaces `▾`. */
    public static chevronDown(): SVGSVGElement {
        return Icons.makeSvg(
            '0 0 16 16',
            '<path d="M3 6l5 5 5-5z" fill="currentColor"/>'
        );
    }

    /** Right-pointing triangle — replaces `▸`. */
    public static chevronRight(): SVGSVGElement {
        return Icons.makeSvg(
            '0 0 16 16',
            '<path d="M6 3l5 5-5 5z" fill="currentColor"/>'
        );
    }

    /** Rectangle outline — replaces `▭` (used as the "diagram" icon). */
    public static rect(): SVGSVGElement {
        return Icons.makeSvg(
            '0 0 16 16',
            '<rect x="2" y="4" width="12" height="8" stroke="currentColor" stroke-width="1.5" fill="none" rx="1"/>'
        );
    }

    /** Filled diamond — replaces `◆` (used for unique-index marker). */
    public static diamondFilled(): SVGSVGElement {
        return Icons.makeSvg(
            '0 0 16 16',
            '<path d="M8 2l6 6-6 6-6-6z" fill="currentColor"/>'
        );
    }

    /** Hollow diamond — replaces `◇` and `⬨` (non-unique index, enum icon). */
    public static diamondHollow(): SVGSVGElement {
        return Icons.makeSvg(
            '0 0 16 16',
            '<path d="M8 2l6 6-6 6-6-6z" fill="none" stroke="currentColor" stroke-width="1.5"/>'
        );
    }

    /** Warning triangle — replaces `⚠` (U+26A0, Misc-Symbols block; high risk). */
    public static warning(): SVGSVGElement {
        return Icons.makeSvg(
            '0 0 16 16',
            '<path d="M8 2l6.5 11.5h-13z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'
            + '<rect x="7.3" y="6" width="1.4" height="4" fill="currentColor"/>'
            + '<rect x="7.3" y="11" width="1.4" height="1.4" fill="currentColor"/>'
        );
    }

    /** Checkmark — replaces `✓`. Used for connection-test "OK" state. */
    public static check(): SVGSVGElement {
        return Icons.makeSvg(
            '0 0 16 16',
            '<path d="M3 8.5l3.5 3.5L13 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
        );
    }

    /** Cross — replaces `✗`. Used for connection-test "Fail" state. */
    public static cross(): SVGSVGElement {
        return Icons.makeSvg(
            '0 0 16 16',
            '<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
        );
    }

    /** Small middle dot — replaces `·` for "leaf" placeholder icon in the treeview. */
    public static dot(): SVGSVGElement {
        return Icons.makeSvg(
            '0 0 16 16',
            '<circle cx="8" cy="8" r="1.6" fill="currentColor"/>'
        );
    }

    /** Stacked cylinder (database) — replaces `🛢` (U+1F6E2, SMP block). */
    public static database(): SVGSVGElement {
        return Icons.makeSvg(
            '0 0 16 16',
            '<ellipse cx="8" cy="3.5" rx="5" ry="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>'
            + '<path d="M3 3.5v9c0 .83 2.24 1.5 5 1.5s5-.67 5-1.5v-9" fill="none" stroke="currentColor" stroke-width="1.4"/>'
            + '<path d="M3 7c0 .83 2.24 1.5 5 1.5s5-.67 5-1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>'
            + '<path d="M3 10.5c0 .83 2.24 1.5 5 1.5s5-.67 5-1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>'
        );
    }

    /** Manila folder — replaces `📁` (U+1F4C1, SMP block). */
    public static folder(): SVGSVGElement {
        return Icons.makeSvg(
            '0 0 16 16',
            '<path d="M1.5 4.5a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" '
            + 'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'
        );
    }

    /** Table grid (3 rows × 2 cols) — replaces `⬜` (U+2B1C, Geometric Shapes Extended). */
    public static table(): SVGSVGElement {
        return Icons.makeSvg(
            '0 0 16 16',
            '<rect x="2" y="3" width="12" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/>'
            + '<path d="M2 6.3h12M2 9.7h12M8 3v10" stroke="currentColor" stroke-width="1" fill="none"/>'
        );
    }

    /** Eye outline + pupil (view) — replaces `👁` (U+1F441, SMP block). */
    public static eye(): SVGSVGElement {
        return Icons.makeSvg(
            '0 0 16 16',
            '<path d="M1 8c1.8-3 4.3-4.5 7-4.5S13.2 5 15 8c-1.8 3-4.3 4.5-7 4.5S2.8 11 1 8z" '
            + 'fill="none" stroke="currentColor" stroke-width="1.3"/>'
            + '<circle cx="8" cy="8" r="1.8" fill="currentColor"/>'
        );
    }

    /** File cabinet (project) — replaces `🗄` (U+1F5C4, SMP block). */
    public static project(): SVGSVGElement {
        return Icons.makeSvg(
            '0 0 16 16',
            '<rect x="2" y="2" width="12" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/>'
            + '<path d="M2 6h12M2 10h12" stroke="currentColor" stroke-width="1.2" fill="none"/>'
            + '<circle cx="8" cy="4" r="0.55" fill="currentColor"/>'
            + '<circle cx="8" cy="8" r="0.55" fill="currentColor"/>'
            + '<circle cx="8" cy="12" r="0.55" fill="currentColor"/>'
        );
    }

}