import {JsonDataDB, JsonDataDBType} from '../JsonData.js';

/**
 * One indexed entry for the global search palette. Tables and columns
 * share the same entry shape — `kind` discriminates. For a table:
 * `qualifiedName = "<database>.<table>"`. For a column:
 * `qualifiedName = "<database>.<table>.<column>"` and `columnUnid` is
 * set so the controller can highlight the row inside the card.
 */
export type SearchEntry = {
    kind: 'table' | 'column' | 'layer';
    /** Set for `kind: 'table'|'column'`; the table the entry belongs to. */
    tableUnid?: string;
    /** Set for `kind: 'layer'`; the layer's own unid. */
    layerUnid?: string;
    containerUnid: string;
    name: string;
    qualifiedName: string;
    columnUnid?: string;
};

const walk = (
    node: JsonDataDB,
    currentDbUnid: string | null,
    currentDbName: string | null,
    out: SearchEntry[]
): void => {
    const nextDbUnid = node.type === JsonDataDBType.database ? node.unid : currentDbUnid;
    const nextDbName = node.type === JsonDataDBType.database ? node.name : currentDbName;
    for (const t of node.tables) {
        const containerUnid = nextDbUnid ?? node.unid;
        const tableQualified = nextDbName ? `${nextDbName}.${t.name}` : t.name;
        out.push({
            kind: 'table',
            tableUnid: t.unid,
            containerUnid: containerUnid,
            name: t.name,
            qualifiedName: tableQualified
        });
        for (const c of t.columns) {
            out.push({
                kind: 'column',
                tableUnid: t.unid,
                containerUnid: containerUnid,
                columnUnid: c.unid,
                name: c.name,
                qualifiedName: `${tableQualified}.${c.name}`
            });
        }
    }
    /*
     * Layers live alongside tables; index them so users can Ctrl+P
     * to jump to a specific layer regardless of canvas overlap.
     */
    for (const l of node.layers ?? []) {
        const containerUnid = nextDbUnid ?? node.unid;
        out.push({
            kind: 'layer',
            layerUnid: l.unid,
            containerUnid: containerUnid,
            name: l.name,
            qualifiedName: nextDbName ? `${nextDbName}.${l.name}` : l.name
        });
    }
    for (const child of node.entrys as JsonDataDB[]) {
        walk(child, nextDbUnid, nextDbName, out);
    }
};

/**
 * Walk the project tree and produce a flat list of search entries —
 * one per table plus one per column. Tables come before their columns
 * (insertion order matches walk order). `containerUnid` is the nearest
 * *database* ancestor (not folder) so callers can switch the active
 * container before focusing the target.
 */
export const buildSearchIndex = (root: JsonDataDB): SearchEntry[] => {
    const out: SearchEntry[] = [];
    walk(root, null, null, out);
    return out;
};

/**
 * Backward-compat: filter the full index to table-only entries. Kept so
 * existing call sites that only want tables don't need to filter manually.
 */
export const buildTableIndex = (root: JsonDataDB): SearchEntry[] =>
    buildSearchIndex(root).filter(e => e.kind === 'table');

const isSubsequence = (needle: string, haystack: string): boolean => {
    let i = 0;
    for (let j = 0; j < haystack.length && i < needle.length; j++) {
        if (haystack[j] === needle[i]) {i++;}
    }
    return i === needle.length;
};

/**
 * Score how well an entry matches `query`. Case-insensitive. Tiers:
 *   100 — exact match on `name`
 *    90 — exact match on `qualifiedName`
 *    80 — `name` starts with query (prefix)
 *    70 — `qualifiedName` starts with query
 *    50 — `name` contains query (substring)
 *    40 — `qualifiedName` contains query
 *    20 — fuzzy subsequence (chars appear in order, not contiguous)
 *     0 — no match
 *
 * The non-flat ladder gives the palette stable ordering: a table whose
 * name prefixes the query always sorts above one where only the
 * qualified form does.
 */
export const scoreMatch = (entry: SearchEntry, query: string): number => {
    if (!query) {return 0;}
    const q = query.toLowerCase();
    const n = entry.name.toLowerCase();
    const qn = entry.qualifiedName.toLowerCase();
    if (n === q) {return 100;}
    if (qn === q) {return 90;}
    if (n.startsWith(q)) {return 80;}
    if (qn.startsWith(q)) {return 70;}
    if (n.includes(q)) {return 50;}
    if (qn.includes(q)) {return 40;}
    if (isSubsequence(q, n) || isSubsequence(q, qn)) {return 20;}
    return 0;
};

/**
 * Sort + filter pass: keep entries with score > 0, sort by score (desc)
 * then by name (asc) for stable ordering when scores tie, return at most
 * `limit` rows.
 */
export const topMatches = (
    index: SearchEntry[],
    query: string,
    limit = 50
): { entry: SearchEntry; score: number; }[] => {
    if (!query) {
        /* Empty query shows the first `limit` tables in their natural order — useful as a browsable list. */
        return index.slice(0, limit).map(e => ({entry: e, score: 0}));
    }
    const scored: { entry: SearchEntry; score: number; }[] = [];
    for (const e of index) {
        const s = scoreMatch(e, query);
        if (s > 0) {scored.push({entry: e, score: s});}
    }
    scored.sort((a, b) => {
        if (a.score !== b.score) {return b.score - a.score;}
        return a.entry.qualifiedName.localeCompare(b.entry.qualifiedName);
    });
    return scored.slice(0, limit);
};