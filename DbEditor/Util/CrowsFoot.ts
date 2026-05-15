/**
 * SVG endpoint markers for ER-style FK lines.
 *
 * The connector ends at coordinate (0, 0) of each SVG. The shape is drawn
 * relative to that origin so it sits at the line's tip. `prongsToward`
 * for the crow's foot and `barOn` for the one-bar describe which side of
 * the SVG origin the prongs / bar extend, which is always **toward the
 * table the marker belongs to**:
 *
 *   - line goes left → right, source on left (many): at the source-end
 *     the SVG sits on the source's right edge; the source table is on the
 *     left of that point, so the prongs fan to the **left**.
 *   - mirror case: source on right, line goes right → left; prongs fan
 *     **right** (into the source on the right).
 *
 * The one-bar is symmetric (a vertical line crossing the connector) but
 * we still expose `barOn` to slightly offset the bar toward the table for
 * a tighter look.
 */
const NS = 'http://www.w3.org/2000/svg';
const DEFAULT_STROKE = 'var(--c-fk, #3e9c8a)';

const svgRoot = (): SVGSVGElement => {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', '24');
    s.setAttribute('height', '20');
    s.setAttribute('viewBox', '-12 -10 24 20');
    s.style.overflow = 'visible';
    s.style.pointerEvents = 'none';
    return s;
};

/**
 * Three-pronged "many" marker. Apex at (0,0); prongs end at (±10, ±7) /
 * (±10, 0). Direction picks the sign of x.
 */
export const crowsFoot = (prongsToward: 'left' | 'right', stroke = DEFAULT_STROKE): SVGSVGElement => {
    const s = svgRoot();
    const sign = prongsToward === 'right' ? +1 : -1;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d',
        `M 0 0 L ${10 * sign} -7 ` +
        `M 0 0 L ${10 * sign}  0 ` +
        `M 0 0 L ${10 * sign}  7`);
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('fill', 'none');
    s.append(path);
    return s;
};

/**
 * Single perpendicular bar across the line for the "one" side. `barOn`
 * is the side of the table — bar sits a few pixels into the line on that
 * side so it visually hugs the table edge.
 */
export const oneBar = (barOn: 'left' | 'right', stroke = DEFAULT_STROKE): SVGSVGElement => {
    const s = svgRoot();
    const sign = barOn === 'right' ? +1 : -1;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', `${4 * sign}`);
    line.setAttribute('x2', `${4 * sign}`);
    line.setAttribute('y1', '-6');
    line.setAttribute('y2', '6');
    line.setAttribute('stroke', stroke);
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-linecap', 'round');
    s.append(line);
    return s;
};