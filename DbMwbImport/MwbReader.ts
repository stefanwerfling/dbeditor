/*
 * ESLint's `indent` rule misreads optional-property syntax in our type
 * aliases (`value?: T`, `link?: T`) as ternary chains and flags lines
 * that are correctly at the same indent as their siblings. The file is
 * heavy on this pattern; disable the rule rather than chase ghosts.
 */
/* eslint-disable indent */
import {randomUUID} from 'crypto';
// eslint-disable-next-line import/extensions
import AdmZip from 'adm-zip';
// eslint-disable-next-line import/extensions
import {XMLParser} from 'fast-xml-parser';
import {
    JsonColumn,
    JsonDataDB,
    JsonDataDBType,
    JsonForeignKey,
    JsonForeignKeyColumn,
    JsonIndex,
    JsonIndexColumn,
    JsonIndexType,
    JsonDiagram,
    JsonLayer,
    JsonRoutine,
    JsonRoutineKind,
    JsonTable,
    JsonView
} from '../DbEditor/JsonData.js';

/**
 * MySQL Workbench `.mwb` file → our `JsonDataDB[]` tree.
 *
 * `.mwb` is a ZIP archive whose `document.mwb.xml` member holds the
 * full model in Workbench's GRT serialisation format. Each entity is a
 * `<value type="object" struct-name="...">` block with `<value key="...">`
 * children and `<link>` cross-references to other entities by UUID.
 *
 * Phase A scope: tables, columns, indexes (incl. PK detection), foreign
 * keys. Phase C extends this with canvas figure positions — each
 * `workbench.physical.TableFigure` carries the `left` / `top` of the
 * card on a diagram, and we apply those to `JsonTable.pos` so the
 * imported schema lays out as the user drew it instead of stacking all
 * cards at the default coordinate. Views, routines, triggers, inserts,
 * sequences, user-types, and Workbench EER-layers remain out of scope.
 *
 * Output: one `JsonDataDB` per `db.mysql.Schema` found in any
 * `workbench.physical.Model.catalog`. Unids are minted fresh
 * (`randomUUID()`); the Workbench-side UUIDs are used only as
 * cross-reference keys during parsing and dropped from the result.
 */

type GrtNode = {
    '@_type'?: string;
    '@_struct-name'?: string;
    '@_id'?: string;
    '@_key'?: string;
    '@_content-struct-name'?: string;
    '@_content-type'?: string;
    '#text'?: string | number;
    value?: GrtNode | GrtNode[];
    link?: GrtLink | GrtLink[];
};

type GrtLink = {
    '@_type'?: string;
    '@_struct-name'?: string;
    '@_key'?: string;
    '#text'?: string;
};

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: false,
    parseAttributeValue: false,
    /* `value` and `link` tags can repeat as siblings; always array them. */
    isArray: (name: string): boolean => name === 'value' || name === 'link'
});

const asArray = <T>(x: T | T[] | undefined): T[] => {
    if (x === undefined) {return [];}
    return Array.isArray(x) ? x : [x];
};

const textOf = (n: GrtNode | GrtLink | undefined): string => {
    if (!n) {return '';}
    const t = n['#text'];
    if (t === undefined) {return '';}
    return String(t);
};

/**
 * Read `key="X"` value/link off a struct, optionally with a type filter.
 * Returns the matched node or `undefined`. Works for both nested-object
 * values and link refs.
 */
const child = (struct: GrtNode, key: string): GrtNode | undefined => {
    const values = asArray(struct.value);
    return values.find(v => v['@_key'] === key);
};

const childLink = (struct: GrtNode, key: string): string | undefined => {
    const links = asArray(struct.link);
    const direct = links.find(l => l['@_key'] === key);
    if (direct) {return textOf(direct);}
    /*
     * Some GRT documents wrap a link inside `<value type="object">` too —
     * fall back to scanning the value list for one whose text content is
     * an UUID-shaped string.
     */
    return undefined;
};

const childStr = (struct: GrtNode, key: string): string => textOf(child(struct, key));

/* -- mwb Phase E passthrough -------------------------------------------- */

const xmlEscapeText = (s: string): string =>
    s.replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');

const xmlEscapeAttr = (s: string): string =>
    xmlEscapeText(s).replace(/"/gu, '&quot;');

/**
 * Re-serialise a parsed `<value>` / `<link>` element back to GRT-style
 * XML. Output mirrors what `MwbWriter` produces: 2-space indent,
 * attributes in a stable order, self-closing tag for empty values,
 * `<text>` content escaped (& < >). The serialiser does NOT preserve
 * the original byte layout (whitespace, attribute order) — Workbench's
 * GRT loader doesn't care about either, and our writer would normalise
 * them anyway on subsequent saves.
 *
 * `kind` is `'value'` or `'link'` and matches the element name.
 */
const serializeNode = (node: GrtNode | GrtLink, kind: 'value' | 'link', depth: number, key?: string): string => {
    const pad = '  '.repeat(depth);
    const attrs: string[] = [];
    if (node['@_type']) {attrs.push(`type="${xmlEscapeAttr(node['@_type'])}"`);}
    if ('@_struct-name' in node && node['@_struct-name']) {
        attrs.push(`struct-name="${xmlEscapeAttr(node['@_struct-name'])}"`);
    }
    if ('@_content-type' in node && (node as GrtNode)['@_content-type']) {
        attrs.push(`content-type="${xmlEscapeAttr((node as GrtNode)['@_content-type'] as string)}"`);
    }
    if ('@_content-struct-name' in node && (node as GrtNode)['@_content-struct-name']) {
        attrs.push(`content-struct-name="${xmlEscapeAttr((node as GrtNode)['@_content-struct-name'] as string)}"`);
    }
    if ('@_id' in node && (node as GrtNode)['@_id']) {
        attrs.push(`id="${xmlEscapeAttr((node as GrtNode)['@_id'] as string)}"`);
    }
    if (key !== undefined) {attrs.push(`key="${xmlEscapeAttr(key)}"`);}
    else if (node['@_key']) {attrs.push(`key="${xmlEscapeAttr(node['@_key'])}"`);}

    const opener = `<${kind} ${attrs.join(' ')}`;

    /*
     * Links never have children — only `#text` content. Values can
     * have nested `value`/`link` children. Empty values are
     * self-closed to match how MwbWriter emits them.
     */
    if (kind === 'link') {
        const text = (node as GrtLink)['#text'];
        if (text === undefined || text === '') {return `${pad}${opener}/>\n`;}
        return `${pad}${opener}>${xmlEscapeText(String(text))}</link>\n`;
    }

    const valueNode = node as GrtNode;
    const values = asArray(valueNode.value);
    const links = asArray(valueNode.link);
    const text = valueNode['#text'];

    if (!values.length && !links.length && (text === undefined || text === '')) {
        return `${pad}${opener}/>\n`;
    }

    let body = '';
    if (values.length || links.length) {
        body += '\n';
        for (const v of values) {body += serializeNode(v, 'value', depth + 1);}
        for (const l of links) {body += serializeNode(l, 'link', depth + 1);}
        body += pad;
    } else {
        body = xmlEscapeText(String(text));
    }
    return `${pad}${opener}>${body}</${kind}>\n`;
};

/**
 * Walk `struct`'s value/link children, build a `JsonWbPassthrough` for
 * every key NOT in `consumed`. Returns `undefined` when nothing survives
 * (cleaner on-disk shape: no `wbPassthrough: {}` clutter).
 *
 * Depth is the writer's eventual indent for the entity's open tag — the
 * passthrough children will sit one level deeper.
 */
type WbPassthrough = {values?: {key: string; xml: string;}[]; attrs?: {name: string; value: string;}[];};

const KNOWN_ATTRS = new Set(['@_type', '@_struct-name', '@_id', '@_key', '@_content-type', '@_content-struct-name']);

const capturePassthrough = (
    struct: GrtNode,
    consumed: Set<string>,
    childDepth: number
): WbPassthrough | undefined => {
    const valuesOut: {key: string; xml: string;}[] = [];
    for (const v of asArray(struct.value)) {
        const k = v['@_key'];
        if (!k || consumed.has(k)) {continue;}
        valuesOut.push({key: k, xml: serializeNode(v, 'value', childDepth).trimEnd()});
    }
    for (const l of asArray(struct.link)) {
        const k = l['@_key'];
        if (!k || consumed.has(k)) {continue;}
        valuesOut.push({key: k, xml: serializeNode(l, 'link', childDepth).trimEnd()});
    }
    const attrsOut: {name: string; value: string;}[] = [];
    for (const a of Object.keys(struct)) {
        if (!a.startsWith('@_')) {continue;}
        if (KNOWN_ATTRS.has(a)) {continue;}
        const val = (struct as unknown as Record<string, unknown>)[a];
        if (typeof val !== 'string') {continue;}
        attrsOut.push({name: a.substring(2), value: val});
    }
    if (!valuesOut.length && !attrsOut.length) {return undefined;}
    const out: WbPassthrough = {};
    if (valuesOut.length) {out.values = valuesOut;}
    if (attrsOut.length) {out.attrs = attrsOut;}
    return out;
};
const childInt = (struct: GrtNode, key: string): number => {
    const t = textOf(child(struct, key));
    if (!t) {return 0;}
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
};

/**
 * Like `childInt` but rounds the real-valued result. Workbench stores
 * figure coordinates as `type="real"` with whole-number values in
 * practice, but parsing through Number() preserves any decimals — we
 * round so `JsonPosition` stays integer-clean.
 */
const childIntRound = (struct: GrtNode, key: string): number => {
    const t = textOf(child(struct, key));
    if (!t) {return 0;}
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n) : 0;
};

/**
 * Walk every `<value type="object" struct-name="X">` descendant of `node`
 * matching the given struct name. Used to flatten lists like all tables,
 * all columns, etc. Doesn't recurse into nested objects of a *different*
 * struct (so we don't conflate a table's column list with another struct's).
 */
const findStructs = (node: GrtNode | undefined, structName: string, out: GrtNode[] = []): GrtNode[] => {
    if (!node) {return out;}
    if (node['@_struct-name'] === structName) {out.push(node);}
    for (const v of asArray(node.value)) {findStructs(v, structName, out);}
    return out;
};

/**
 * Scan raw `document.mwb.xml` text for every
 * `<value type="object" struct-name="${structName}" ... id="UUID">...</value>`
 * block and return a map keyed by GRT UUID with the raw byte slice
 * (inclusive of both tags). Used by the Phase E.2 per-object
 * roundtrip passthrough: writer can re-emit these bytes verbatim
 * when the model object hasn't been touched since import.
 *
 * Tag-balanced scan rather than naive regex — `<value type="list">`
 * children nest inside the routine block (e.g. params, owner link)
 * and we need to find the *matching* `</value>` at the same depth.
 * Self-closing `<value ... />` opens are tracked but never push
 * onto the depth stack.
 */
const extractObjectXmlByGrtId = (xml: string, structName: string): Map<string, string> => {
    const out = new Map<string, string>();
    const openRe = new RegExp(`<value\\b[^>]*struct-name="${structName}"[^>]*id="([^"]+)"[^>]*>`, 'gu');
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(xml)) !== null) {
        /* Self-closing root tag — nothing to capture beyond it. */
        if (m[0].endsWith('/>')) {
            out.set(m[1], m[0]);
            continue;
        }
        let depth = 1;
        let i = m.index + m[0].length;
        let end = -1;
        while (i < xml.length && depth > 0) {
            const close = xml.indexOf('</value>', i);
            const open = xml.indexOf('<value', i);
            if (close < 0) {break;}
            if (open >= 0 && open < close) {
                /* Peek past attributes to see if this opener is self-closing. */
                const tagEnd = xml.indexOf('>', open);
                if (tagEnd > 0 && xml[tagEnd - 1] !== '/') {depth++;}
                i = tagEnd + 1;
            } else {
                depth--;
                i = close + '</value>'.length;
                if (depth === 0) {end = i;}
            }
        }
        if (end > 0) {out.set(m[1], xml.substring(m.index, end));}
    }
    return out;
};

/**
 * Map `com.mysql.rdbms.mysql.datatype.<name>` → our logical column type
 * string. Lengths/precisions are handled by the column-level conversion,
 * not by this lookup — here we just normalise the type name.
 */
const mapSimpleType = (datatypeRef: string): string => {
    const m = datatypeRef.match(/datatype\.([a-z_]+)$/iu);
    const raw = m ? m[1].toLowerCase() : datatypeRef.toLowerCase();
    switch (raw) {
        case 'datetime_f':  return 'datetime';
        case 'timestamp_f': return 'timestamp';
        case 'time_f':      return 'time';
        case 'real':        return 'double';
        case 'nchar':       return 'char';
        case 'nvarchar':    return 'varchar';
        default:            return raw;
    }
};

const mapFkAction = (raw: string): string | undefined => {
    const v = (raw || '').toUpperCase().trim();
    if (!v) {return undefined;}
    return v;
};

type ColumnRecord = {
    column: JsonColumn;
    wbId: string;
    tableWbId: string;
};

type TableRecord = {
    table: JsonTable;
    wbId: string;
    /** GRT ids of every column in the same order as table.columns. Used by the Phase E.2 table cache. */
    columnWbIds: string[];
};

const parseColumn = (col: GrtNode, tableWbId: string): ColumnRecord => {
    const wbId = col['@_id'] ?? '';
    const datatypeRef = childLink(col, 'simpleType') ?? '';
    const typeName = mapSimpleType(datatypeRef);
    const lengthRaw = childInt(col, 'length');
    const precision = childInt(col, 'precision');
    const scale = childInt(col, 'scale');
    const isNotNull = childInt(col, 'isNotNull') === 1;
    const autoInc = childInt(col, 'autoIncrement') === 1;
    const defaultIsNull = childInt(col, 'defaultValueIsNull') === 1;
    const defaultValue = defaultIsNull ? '' : childStr(col, 'defaultValue');
    const comment = childStr(col, 'comment');
    const charset = childStr(col, 'characterSetName');
    const collation = childStr(col, 'collationName');
    /*
     * Length encoding: char/varchar/binary/varbinary use `length`; decimal
     * uses precision,scale; integer variants in MySQL have "display width"
     * that's largely cosmetic — we drop it. JSON/text variants don't have
     * a length.
     */
    let length: string | undefined;
    if (typeName === 'decimal' || typeName === 'numeric') {
        if (precision > 0) {
            length = scale > 0 ? `${precision},${scale}` : String(precision);
        }
    } else if (
        typeName === 'char' || typeName === 'varchar' ||
        typeName === 'binary' || typeName === 'varbinary'
    ) {
        if (lengthRaw > 0) {length = String(lengthRaw);}
    }

    /*
     * Workbench's `flags` list holds UNSIGNED, ZEROFILL, BINARY for int
     * variants. We surface UNSIGNED on the column; ZEROFILL is cosmetic
     * and ignored.
     */
    const flagsList = child(col, 'flags');
    const flags = flagsList ? asArray(flagsList.value).map(v => textOf(v).toUpperCase()) : [];
    const unsigned = flags.includes('UNSIGNED');

    const column: JsonColumn = {
        unid: randomUUID(),
        name: childStr(col, 'name'),
        type: typeName
    };
    if (length !== undefined) {column.length = length;}
    if (isNotNull) {column.notNull = true;}
    if (autoInc) {column.autoIncrement = true;}
    if (unsigned) {column.unsigned = true;}
    if (defaultValue) {column.defaultValue = defaultValue;}
    if (comment) {column.comment = comment;}
    if (charset) {column.charset = charset;}
    if (collation) {column.collation = collation;}

    /*
     * Passthrough: capture every `<value key="X">` / `<link key="X">`
     * child whose `X` we don't model. The set below mirrors every
     * `childStr/childInt/childLink/child(col, ...)` lookup above plus
     * the `owner` reverse-pointer (which the writer re-mints from the
     * table id, not from the captured value).
     */
    const consumed = new Set([
        'simpleType', 'length', 'precision', 'scale', 'isNotNull',
        'autoIncrement', 'defaultValueIsNull', 'defaultValue', 'comment',
        'characterSetName', 'collationName', 'flags', 'name', 'oldName',
        'owner'
    ]);
    const pt = capturePassthrough(col, consumed, 3);
    if (pt) {column.wbPassthrough = pt;}

    return {column: column, wbId: wbId, tableWbId: tableWbId};
};

/**
 * Parse `db.mysql.Index` into our JsonIndex *plus* mark its referenced
 * columns as primaryKey/unique when appropriate. PKs aren't separate
 * `primaryKey` fields in Workbench — they live as an index with
 * `isPrimary=1`; we surface them on the column flags so our renderer
 * can emit `PRIMARY KEY (…)` correctly.
 */
const parseIndex = (
    idx: GrtNode,
    columnByWbId: Map<string, ColumnRecord>
): JsonIndex | null => {
    const isPrimary = childInt(idx, 'isPrimary') === 1;
    const unique = childInt(idx, 'unique') === 1;
    const rawType = childStr(idx, 'indexType').toUpperCase();

    const ixColumnsNode = child(idx, 'columns');
    const wbIndexColumns = ixColumnsNode ? asArray(ixColumnsNode.value) : [];

    const indexColumns: JsonIndexColumn[] = [];
    for (const ic of wbIndexColumns) {
        const refWbId = childLink(ic, 'referencedColumn');
        if (!refWbId) {continue;}
        const ref = columnByWbId.get(refWbId);
        if (!ref) {continue;}
        const desc = childInt(ic, 'descend') === 1;
        const colLen = childInt(ic, 'columnLength');
        const out: JsonIndexColumn = {columnUnid: ref.column.unid};
        if (desc) {out.order = 'DESC';}
        if (colLen > 0) {out.length = colLen;}
        indexColumns.push(out);

        if (isPrimary) {ref.column.primaryKey = true;}
        if (unique && wbIndexColumns.length === 1 && !isPrimary) {ref.column.unique = true;}
    }
    if (isPrimary) {
        /*
         * PRIMARY index is surfaced via column.primaryKey flags only;
         * we don't model it as an editor-side JsonIndex entry. 
         */
        return null;
    }
    if (!indexColumns.length) {return null;}

    let type: string;
    if (rawType === 'FULLTEXT') {type = JsonIndexType.fulltext;}
    else if (rawType === 'SPATIAL') {type = JsonIndexType.spatial;}
    else if (unique) {type = JsonIndexType.unique;}
    else {type = JsonIndexType.index;}

    const result: JsonIndex = {
        unid: randomUUID(),
        name: childStr(idx, 'name'),
        type: type,
        columns: indexColumns
    };
    const consumed = new Set([
        'isPrimary', 'unique', 'indexType', 'columns', 'name', 'oldName', 'owner'
    ]);
    const pt = capturePassthrough(idx, consumed, 3);
    if (pt) {result.wbPassthrough = pt;}
    return result;
};

const parseForeignKey = (
    fk: GrtNode,
    columnByWbId: Map<string, ColumnRecord>,
    tableByWbId: Map<string, TableRecord>
): JsonForeignKey | null => {
    const refTableWbId = childLink(fk, 'referencedTable');
    if (!refTableWbId) {return null;}
    const refTable = tableByWbId.get(refTableWbId);
    if (!refTable) {return null;}

    const localColumnsNode = child(fk, 'columns');
    const refColumnsNode = child(fk, 'referencedColumns');
    const localLinks = localColumnsNode ? asArray(localColumnsNode.link) : [];
    const refLinks = refColumnsNode ? asArray(refColumnsNode.link) : [];
    if (!localLinks.length || localLinks.length !== refLinks.length) {return null;}

    const cols: JsonForeignKeyColumn[] = [];
    for (let i = 0; i < localLinks.length; i++) {
        const localWb = textOf(localLinks[i]);
        const refWb = textOf(refLinks[i]);
        const local = columnByWbId.get(localWb);
        const ref = columnByWbId.get(refWb);
        if (!local || !ref) {return null;}
        cols.push({columnUnid: local.column.unid, refColumnUnid: ref.column.unid});
    }

    const result: JsonForeignKey = {
        unid: randomUUID(),
        name: childStr(fk, 'name'),
        refTableUnid: refTable.table.unid,
        columns: cols
    };
    const del = mapFkAction(childStr(fk, 'deleteRule'));
    const upd = mapFkAction(childStr(fk, 'updateRule'));
    if (del) {result.onDelete = del;}
    if (upd) {result.onUpdate = upd;}
    const consumed = new Set([
        'referencedTable', 'columns', 'referencedColumns',
        'deleteRule', 'updateRule', 'name', 'oldName', 'owner'
    ]);
    const pt = capturePassthrough(fk, consumed, 3);
    if (pt) {result.wbPassthrough = pt;}
    return result;
};

/**
 * Strip the `CREATE [OR REPLACE] [ALGORITHM=...] [DEFINER=...]
 * [SQL SECURITY ...] VIEW [IF NOT EXISTS] [`schema`.]`name`[(cols)] AS`
 * prefix off a Workbench `sqlDefinition`. Workbench sometimes stores
 * the full statement, sometimes only the SELECT body — our JsonView
 * model is "SELECT body only", so we normalise.
 *
 * The match is intentionally greedy up to the first `AS` keyword on
 * a word boundary: Workbench-emitted prefixes don't legally contain
 * `AS` as a bare word, and the view body proper starts immediately
 * after.
 */
const stripViewPrefix = (sql: string): string => {
    const m = sql.match(/^\s*CREATE\b[\s\S]*?\bVIEW\b[\s\S]*?\bAS\s+/iu);
    if (!m) {return sql.trim();}
    return sql.substring(m[0].length).trim();
};

const parseView = (
    v: GrtNode,
    viewPositions: Map<string, {x: number; y: number;}>
): JsonView => {
    const sql = childStr(v, 'sqlDefinition');
    const comment = childStr(v, 'comment');
    const wbId = v['@_id'] ?? '';
    const pos = viewPositions.get(wbId) ?? {x: 80, y: 80};
    const result: JsonView = {
        unid: randomUUID(),
        name: childStr(v, 'name'),
        pos: pos,
        select: stripViewPrefix(sql)
    };
    if (comment) {result.description = comment;}
    const consumed = new Set(['sqlDefinition', 'comment', 'name', 'oldName', 'owner']);
    const pt = capturePassthrough(v, consumed, 3);
    if (pt) {result.wbPassthrough = pt;}
    return result;
};

/**
 * Workbench's `routineType` is a free-form string in the GRT — values
 * observed: "procedure", "function". We normalise to JsonRoutineKind;
 * anything unrecognised falls back to procedure (the most common case
 * and a no-op for emit semantics on every dialect we target).
 */
const mapRoutineKind = (raw: string): string => {
    const v = raw.toLowerCase().trim();
    if (v === 'function') {return JsonRoutineKind.function;}
    if (v === 'trigger')  {return JsonRoutineKind.trigger;}
    return JsonRoutineKind.procedure;
};

const parseRoutine = (r: GrtNode): JsonRoutine => {
    const comment = childStr(r, 'comment');
    const result: JsonRoutine = {
        unid: randomUUID(),
        name: childStr(r, 'name'),
        pos: {x: 80, y: 80},
        kind: mapRoutineKind(childStr(r, 'routineType')),
        body: childStr(r, 'sqlDefinition')
    };
    if (comment) {result.description = comment;}
    const consumed = new Set(['sqlDefinition', 'comment', 'name', 'oldName', 'owner', 'routineType']);
    const pt = capturePassthrough(r, consumed, 3);
    if (pt) {result.wbPassthrough = pt;}
    return result;
};

const parseTrigger = (t: GrtNode): JsonRoutine => {
    const comment = childStr(t, 'comment');
    const result: JsonRoutine = {
        unid: randomUUID(),
        name: childStr(t, 'name'),
        pos: {x: 80, y: 80},
        kind: JsonRoutineKind.trigger,
        body: childStr(t, 'sqlDefinition')
    };
    if (comment) {result.description = comment;}
    const consumed = new Set(['sqlDefinition', 'comment', 'name', 'oldName', 'owner']);
    const pt = capturePassthrough(t, consumed, 3);
    if (pt) {result.wbPassthrough = pt;}
    return result;
};

const parseTable = (
    tbl: GrtNode,
    columnByWbId: Map<string, ColumnRecord>,
    figurePos: Map<string, {x: number; y: number;}>,
    tableToLayer: Map<string, string>,
    tablePlacements: Map<string, {diagramUnid: string; pos: {x: number; y: number;};}[]>
): TableRecord => {
    const wbId = tbl['@_id'] ?? '';
    const name = childStr(tbl, 'name');
    const comment = childStr(tbl, 'comment');
    const engine = childStr(tbl, 'tableEngine');
    const charset = childStr(tbl, 'defaultCharacterSetName');
    const collation = childStr(tbl, 'defaultCollationName');

    const columnsNode = child(tbl, 'columns');
    const wbColumns = columnsNode ? asArray(columnsNode.value) : [];
    const columns: JsonColumn[] = [];
    const columnWbIds: string[] = [];
    for (const c of wbColumns) {
        const rec = parseColumn(c, wbId);
        columns.push(rec.column);
        columnWbIds.push(rec.wbId);
        columnByWbId.set(rec.wbId, rec);
    }

    const options: JsonTable['options'] = {};
    if (engine) {options.engine = engine;}
    if (charset) {options.charset = charset;}
    if (collation) {options.collation = collation;}
    if (comment) {options.comment = comment;}

    const pos = figurePos.get(wbId) ?? {x: 80, y: 80};
    const diagramUnid = tableToLayer.get(wbId);

    const table: JsonTable = {
        unid: randomUUID(),
        name: name,
        pos: pos,
        columns: columns,
        indexes: [],
        foreignKeys: [],
        options: Object.keys(options).length ? options : undefined
    };
    if (diagramUnid) {table.diagramUnid = diagramUnid;}
    const placements = tablePlacements.get(wbId);
    if (placements && placements.length > 0) {table.diagramPlacements = placements;}
    /*
     * Indexes / foreignKeys / triggers are populated in a second pass
     * by the caller after parseColumn fills columnByWbId — those keys
     * are also consumed but flow through different code paths, so we
     * mark them consumed here too so capturePassthrough doesn't
     * double-store them.
     */
    /*
     * Consumed-keys: only the elements the writer regenerates on its
     * own paths. Workbench's key names are GRT-conventional —
     * `indices` (not `indexes`), `foreignKeys`, `triggers`. Anything
     * NOT listed here is captured into passthrough; getting this list
     * wrong means duplicate emission on round-trip (we'd emit the
     * modelled version + the passthrough version side-by-side).
     */
    const consumed = new Set([
        'columns', 'indices', 'foreignKeys', 'triggers',
        'name', 'oldName', 'comment',
        'tableEngine', 'defaultCharacterSetName', 'defaultCollationName',
        'owner'
    ]);
    const pt = capturePassthrough(tbl, consumed, 3);
    if (pt) {table.wbPassthrough = pt;}
    return {table: table, wbId: wbId, columnWbIds: columnWbIds};
};

/**
 * Output of `buildFigureData`: per-table effective canvas position
 * (after diagram tiling), per-table backing-diagram reference (direct),
 * and the layers themselves (either authored from the .mwb or
 * synthesised one-per-diagram when none authored). Views get the same
 * tiling treatment via a parallel `viewPositions` map.
 */
type FigureData = {
    /** `wbTableId → {x, y}` effective canvas coords for the *primary* (first-seen) diagram. */
    positions: Map<string, {x: number; y: number;}>;
    /** `wbViewId → {x, y}` effective canvas coords. */
    viewPositions: Map<string, {x: number; y: number;}>;
    /** `wbTableId → JsonDiagram.unid` — primary diagram membership. */
    tableToLayer: Map<string, string>;
    /**
     * Secondary placements: every additional diagram a table appears
     * in (beyond its primary). Mirrors `JsonTable.diagramPlacements`
     * shape so `parseTable` can drop the value straight onto the
     * model.
     */
    tablePlacements: Map<string, {diagramUnid: string; pos: {x: number; y: number;};}[]>;
    /** One JsonDiagram per Workbench `workbench.physical.Diagram`. */
    diagrams: JsonDiagram[];
    /**
     * One JsonLayer per authored `workbench.physical.Layer`
     * (excluding the implicit per-diagram `rootLayer`). Each
     * carries `diagramUnid` linking it to its parent diagram +
     * pos/size/color from the Workbench source.
     */
    layers: JsonLayer[];
};

type FigureEntry = {fig: GrtNode; kind: 'table' | 'view';};

/**
 * Phase E.2 per-table cache payload. The writer needs both the raw
 * outer XML AND the GRT ids of the table + its columns (in order)
 * so cross-references from FKs in other tables resolve.
 */
export type MwbTableCacheEntry = {
    xml: string;
    grtId: string;
    columnGrtIds: string[];
};

/**
 * Walk every `workbench.physical.TableFigure` and produce both the
 * effective `(x, y)` for each Workbench table UUID AND a synthesised
 * `JsonDiagram` per Workbench diagram (so the user sees the same
 * grouping after import).
 *
 * **Diagram tiling**: Workbench EER diagrams each have their own
 * coordinate origin, so tables from different diagrams overlap if
 * you flatten them onto a single canvas. We tile diagrams left-to-
 * right — the first diagram keeps its raw coords (so a single-
 * diagram round-trip preserves exact positions), each subsequent
 * diagram is shifted past the running max-right of all previous
 * diagrams plus a `GAP`. When a table appears on multiple diagrams,
 * the first figure becomes its primary `pos` + `diagramUnid`; each
 * additional figure becomes a `diagramPlacements` entry so the table
 * keeps its per-diagram position in every diagram it lives in.
 *
 * **Diagrams / Layers**: each Workbench `workbench.physical.Diagram`
 * becomes one `JsonDiagram` (logical EER tab, named after the
 * Workbench diagram). User-authored `workbench.physical.Layer`
 * structs — i.e. those whose `@_key` is NOT `rootLayer` (the
 * implicit per-diagram root container) — become `JsonLayer`s
 * attached to that diagram with their original pos/size/color
 * preserved. Tables/views always belong to the parent Workbench
 * diagram regardless of which authored Layer their figure links to;
 * layer membership in our model is implicit (by bbox overlap).
 */

const buildFigureData = (root: GrtNode): FigureData => {
    const tableFigures = findStructs(root, 'workbench.physical.TableFigure');
    const viewFigures = findStructs(root, 'workbench.physical.ViewFigure');

    /*
     * Index Workbench diagrams by ID so we can recover their `name`
     * for the synthesised layers + walk their authored child layers.
     * `findStructs` walks document order, so insertion order is
     * stable.
     */
    const diagrams = findStructs(root, 'workbench.physical.Diagram');
    const diagramById = new Map<string, GrtNode>();
    const diagramName = new Map<string, string>();
    for (const d of diagrams) {
        const id = d['@_id'];
        if (id) {
            diagramById.set(id, d);
            diagramName.set(id, childStr(d, 'name'));
        }
    }

    /*
     * Group figures (tables AND views) by `owner` link (the diagram
     * UUID). One unified map so the per-diagram bbox and the xShift
     * tiling apply consistently to both kinds — a view and a table on
     * the same diagram share the coordinate system. Map insertion
     * order matches document order of the *first* figure for each
     * diagram, which is stable across runs. Tables are inserted before
     * views so a diagram with only views still groups under its own
     * owner key.
     */
    const byDiagram = new Map<string, FigureEntry[]>();
    for (const fig of tableFigures) {
        const owner = childLink(fig, 'owner') ?? 'unknown';
        const list = byDiagram.get(owner) ?? [];
        list.push({fig: fig, kind: 'table'});
        byDiagram.set(owner, list);
    }
    for (const fig of viewFigures) {
        const owner = childLink(fig, 'owner') ?? 'unknown';
        const list = byDiagram.get(owner) ?? [];
        list.push({fig: fig, kind: 'view'});
        byDiagram.set(owner, list);
    }

    const GAP = 80;
    const FALLBACK_WIDTH = 200;
    const positions = new Map<string, {x: number; y: number;}>();
    const viewPositions = new Map<string, {x: number; y: number;}>();
    const tableToLayer = new Map<string, string>();
    const tablePlacements = new Map<string, {diagramUnid: string; pos: {x: number; y: number;};}[]>();
    const outDiagrams: JsonDiagram[] = [];
    const outLayers: JsonLayer[] = [];
    let isFirst = true;
    let runningRight = 0;
    let diagramIndex = 0;

    for (const [diagramId, figs] of byDiagram) {
        let dMinLeft = Infinity;
        let dMaxRight = -Infinity;
        for (const entry of figs) {
            const left = childIntRound(entry.fig, 'left');
            const width = childIntRound(entry.fig, 'width') || FALLBACK_WIDTH;
            if (left < dMinLeft) {dMinLeft = left;}
            if (left + width > dMaxRight) {dMaxRight = left + width;}
        }
        if (!Number.isFinite(dMinLeft)) {continue;}

        const xShift = isFirst ? 0 : runningRight + GAP - dMinLeft;

        /*
         * One JsonDiagram per Workbench diagram. Named from the
         * Workbench `name` value, falling back to a positional
         * label when the import was unnamed.
         */
        const diagramUnid = randomUUID();
        const namedFromMwb = diagramName.get(diagramId);
        const diagramTabName = namedFromMwb && namedFromMwb.length > 0
            ? namedFromMwb
            : `EER Diagram ${diagramIndex + 1}`;
        outDiagrams.push({
            unid: diagramUnid,
            name: diagramTabName
        });

        /*
         * Authored layers (non-rootLayer) → JsonLayer, with their
         * parent diagramUnid set to the just-created JsonDiagram.
         * pos/size/color carry over so the user sees the same
         * decoration after import. `rootLayer` is skipped (it's
         * the implicit per-diagram container, not user-visible).
         */
        const diagramNode = diagramById.get(diagramId);
        if (diagramNode) {
            const allLayers = findStructs(diagramNode, 'workbench.physical.Layer');
            for (const l of allLayers) {
                if (l['@_key'] === 'rootLayer') {continue;}
                outLayers.push({
                    unid: randomUUID(),
                    name: childStr(l, 'name') || `Layer ${outLayers.length + 1}`,
                    diagramUnid: diagramUnid,
                    pos: {
                        x: childIntRound(l, 'left') + xShift,
                        y: childIntRound(l, 'top')
                    },
                    width: childIntRound(l, 'width') || 400,
                    height: childIntRound(l, 'height') || 300,
                    color: childStr(l, 'color') || undefined
                });
            }
        }

        /*
         * Per-figure: record the canvas position and the diagram
         * link. Tables always belong to the parent Workbench
         * diagram → outDiagrams[diagramIndex]. Views currently have
         * no diagram membership rendered explicitly (JsonView has
         * `diagramUnid` but we just position them).
         *
         * Multi-membership: when a tableWbId has already been seen
         * in a prior diagram, the second figure becomes a
         * `diagramPlacements` entry instead of being dropped.
         */
        for (const entry of figs) {
            if (entry.kind === 'table') {
                const tableWbId = childLink(entry.fig, 'table');
                if (!tableWbId) {continue;}
                const figPos = {
                    x: childIntRound(entry.fig, 'left') + xShift,
                    y: childIntRound(entry.fig, 'top')
                };
                if (!positions.has(tableWbId)) {
                    positions.set(tableWbId, figPos);
                    tableToLayer.set(tableWbId, diagramUnid);
                } else if (diagramUnid !== tableToLayer.get(tableWbId)) {
                    const list = tablePlacements.get(tableWbId) ?? [];
                    if (!list.some(p => p.diagramUnid === diagramUnid)) {
                        list.push({diagramUnid: diagramUnid, pos: figPos});
                        tablePlacements.set(tableWbId, list);
                    }
                }
            } else {
                const viewWbId = childLink(entry.fig, 'view');
                if (!viewWbId || viewPositions.has(viewWbId)) {continue;}
                viewPositions.set(viewWbId, {
                    x: childIntRound(entry.fig, 'left') + xShift,
                    y: childIntRound(entry.fig, 'top')
                });
            }
        }

        runningRight = isFirst ? dMaxRight : runningRight + GAP + (dMaxRight - dMinLeft);
        isFirst = false;
        diagramIndex++;
    }
    return {
        positions: positions,
        viewPositions: viewPositions,
        tableToLayer: tableToLayer,
        tablePlacements: tablePlacements,
        diagrams: outDiagrams,
        layers: outLayers
    };
};

export type MwbImportResult = {
    schemaCount: number;
    tableCount: number;
    columnCount: number;
    indexCount: number;
    foreignKeyCount: number;
    /** Tables that received a non-default canvas position from a TableFigure. */
    positionedTableCount: number;
    /** Views that received a non-default canvas position from a ViewFigure. */
    positionedViewCount: number;
    /** Tables that ended up belonging to more than one EER diagram (extra figures became diagramPlacements). */
    multiDiagramTableCount: number;
    viewCount: number;
    /** Stored procedures + functions (schema-level routines). Triggers are counted separately. */
    routineCount: number;
    /** Triggers (table-nested in Workbench, but stored alongside routines in our model). */
    triggerCount: number;
    /** JsonDiagrams created — one per Workbench diagram (or per authored Layer when present). */
    layerCount: number;
    databases: JsonDataDB[];
    /**
     * Phase E.2 per-object roundtrip cache. Map of JsonRoutine.unid →
     * raw outer-XML bytes of the source `db.mysql.Routine` struct.
     * Caller feeds this into the repo; the writer re-emits these
     * bytes (with owner-link rewriting) when the routine hasn't
     * been touched since import.
     */
    routineOriginalXml: Map<string, string>;
    /** Same as `routineOriginalXml` but for `db.mysql.View` blocks. */
    viewOriginalXml: Map<string, string>;
    /**
     * Phase E.2 per-table cache. Map of JsonTable.unid → cache
     * entry holding the raw outer XML + GRT id + per-column GRT
     * ids (column-order matching `table.columns`). Writer pre-
     * populates `ids.tableId` and `ids.columnId` from these so
     * FK cross-refs in both cached and regenerated tables resolve
     * consistently.
     */
    tableOriginalXml: Map<string, MwbTableCacheEntry>;
};

/**
 * Top-level entry point. Takes the raw bytes of a `.mwb` file (ZIP),
 * unpacks `document.mwb.xml`, parses it, and returns a partial editor
 * model (one `JsonDataDB` per Workbench schema, with all its tables/
 * columns/indexes/FKs filled in).
 *
 * Stats are returned alongside for the import confirm dialog.
 */
export const parseMwb = (buffer: Buffer): MwbImportResult => {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry('document.mwb.xml');
    if (!entry) {throw new Error('mwb archive is missing document.mwb.xml');}
    const xml = entry.getData().toString('utf-8');
    const parsed = parser.parse(xml) as { data?: GrtNode; };

    const root = parsed.data;
    if (!root) {throw new Error('mwb XML has no <data> root');}

    /*
     * The catalog lives at:
     *   data > value(workbench.Document) > value(workbench.physical.Model)
     *        > value(db.mysql.Catalog) > value(db.mysql.Schema)[]
     * Rather than hand-walking that path (which has nested anonymous
     * lists), flatten via `findStructs`. The shape is unique enough
     * that this is unambiguous in practice.
     */
    const grtRoot = root as unknown as GrtNode;
    const schemas = findStructs(grtRoot, 'db.mysql.Schema');
    const figureData = buildFigureData(grtRoot);
    const figurePos = figureData.positions;
    const viewFigurePos = figureData.viewPositions;
    const tableToLayer = figureData.tableToLayer;
    const tablePlacementsMap = figureData.tablePlacements;
    /*
     * Phase E.2 per-object cache: capture the raw bytes of every
     * `db.mysql.Routine` and `db.mysql.View` block once from the
     * source XML. Keyed by the GRT id; later mapped to our model
     * `.unid` as the entity is parsed. Triggers (nested in tables)
     * and Tables (FK cross-ref id consistency) are still out of
     * scope.
     */
    const routineXmlByWbId = extractObjectXmlByGrtId(xml, 'db.mysql.Routine');
    const routineOriginalXml = new Map<string, string>();
    const viewXmlByWbId = extractObjectXmlByGrtId(xml, 'db.mysql.View');
    const viewOriginalXml = new Map<string, string>();
    /*
     * Tables also need their column GRT ids preserved so FKs in
     * OTHER tables (whether cached or regenerated) resolve. Value
     * carries grtId + column order so the writer can pre-populate
     * ids.tableId and ids.columnId before any output.
     */
    const tableXmlByWbId = extractObjectXmlByGrtId(xml, 'db.mysql.Table');
    const tableOriginalXml = new Map<string, MwbTableCacheEntry>();

    const databases: JsonDataDB[] = [];
    let tableCount = 0;
    let columnCount = 0;
    let indexCount = 0;
    let fkCount = 0;
    let positionedTableCount = 0;
    let positionedViewCount = 0;
    let multiDiagramTableCount = 0;
    let viewCount = 0;
    let routineCount = 0;
    let triggerCount = 0;

    for (const schema of schemas) {
        const schemaName = childStr(schema, 'name') || 'imported';
        const tablesNode = child(schema, 'tables');
        const wbTables = tablesNode ? asArray(tablesNode.value) : [];

        const tableByWbId = new Map<string, TableRecord>();
        const columnByWbId = new Map<string, ColumnRecord>();

        /*
         * First pass: tables + columns. Need all columns parsed before
         * FKs/indexes resolve their cross-refs. 
         */
        const records: TableRecord[] = [];
        for (const t of wbTables) {
            const rec = parseTable(t, columnByWbId, figurePos, tableToLayer, tablePlacementsMap);
            tableByWbId.set(rec.wbId, rec);
            records.push(rec);
            columnCount += rec.table.columns.length;
            if (figurePos.has(rec.wbId)) {positionedTableCount++;}
            if (rec.table.diagramPlacements && rec.table.diagramPlacements.length > 0) {multiDiagramTableCount++;}
            const rawT = tableXmlByWbId.get(rec.wbId);
            if (rawT) {
                tableOriginalXml.set(rec.table.unid, {
                    xml: rawT,
                    grtId: rec.wbId,
                    columnGrtIds: rec.columnWbIds
                });
            }
        }
        tableCount += records.length;

        /*
         * Second pass: indexes (also marks column.primaryKey/unique),
         * FKs, and triggers. Triggers are nested *inside* tables in
         * Workbench but we model them at the schema level as routines
         * with `kind: 'trigger'`; they get appended to the schema's
         * routines[] list below.
         */
        const triggersForSchema: JsonRoutine[] = [];
        for (const rec of records) {
            const wbTable = wbTables.find(x => x['@_id'] === rec.wbId);
            if (!wbTable) {continue;}
            const indexesNode = child(wbTable, 'indices');
            const wbIndexes = indexesNode ? asArray(indexesNode.value) : [];
            for (const ix of wbIndexes) {
                const parsed2 = parseIndex(ix, columnByWbId);
                if (parsed2) {rec.table.indexes.push(parsed2); indexCount++;}
            }
            const fksNode = child(wbTable, 'foreignKeys');
            const wbFks = fksNode ? asArray(fksNode.value) : [];
            for (const fk of wbFks) {
                const parsed2 = parseForeignKey(fk, columnByWbId, tableByWbId);
                if (parsed2) {rec.table.foreignKeys.push(parsed2); fkCount++;}
            }
            const triggersNode = child(wbTable, 'triggers');
            const wbTriggers = triggersNode ? asArray(triggersNode.value) : [];
            for (const tg of wbTriggers) {
                triggersForSchema.push(parseTrigger(tg));
                triggerCount++;
            }
        }

        const viewsNode = child(schema, 'views');
        const wbViews = viewsNode ? asArray(viewsNode.value) : [];
        const views: JsonView[] = [];
        for (const v of wbViews) {
            const parsedView = parseView(v, viewFigurePos);
            views.push(parsedView);
            viewCount++;
            const wbViewId = v['@_id'] ?? '';
            if (viewFigurePos.has(wbViewId)) {positionedViewCount++;}
            const rawV = viewXmlByWbId.get(wbViewId);
            if (rawV) {viewOriginalXml.set(parsedView.unid, rawV);}
        }

        const routinesNode = child(schema, 'routines');
        const wbRoutines = routinesNode ? asArray(routinesNode.value) : [];
        const routines: JsonRoutine[] = [];
        for (const r of wbRoutines) {
            const routine = parseRoutine(r);
            routines.push(routine);
            routineCount++;
            const wbId = r['@_id'] ?? '';
            const raw = routineXmlByWbId.get(wbId);
            if (raw) {routineOriginalXml.set(routine.unid, raw);}
        }

        /*
         * Triggers come last so the treeview shows them grouped at the
         * end of the routines list (after procedures + functions).
         */
        for (const tg of triggersForSchema) {routines.push(tg);}

        /*
         * Attach all diagrams + layers to the first schema. Workbench
         * diagrams aren't scoped per-schema, but realistic models
         * exported by Workbench so far always carry a single schema;
         * if a future multi-schema model needs per-schema scoping
         * we'd partition them by which schema's tables they cover.
         */
        const dbDiagrams = databases.length === 0 ? figureData.diagrams : [];
        const dbLayers = databases.length === 0 ? figureData.layers : [];

        const dbNode: JsonDataDB = {
            unid: randomUUID(),
            name: schemaName,
            type: JsonDataDBType.database,
            istoggle: true,
            entrys: [],
            tables: records.map(r => r.table),
            views: views,
            enums: [],
            routines: routines
        };
        if (dbDiagrams.length > 0) {dbNode.diagrams = dbDiagrams;}
        if (dbLayers.length > 0) {dbNode.layers = dbLayers;}
        /*
         * Surface Workbench's schema-level inheritance defaults on the
         * `JsonDataDB`. Workbench stores `defaultCharacterSetName` and
         * `defaultCollationName` per schema; we used to drop them and
         * let the user's per-table overrides carry the burden. With
         * the editor's new database-level defaults, we propagate them
         * so the diff against a live MariaDB doesn't fire on every
         * inherited per-table collation.
         */
        const defaultCharset = childStr(schema, 'defaultCharacterSetName');
        const defaultCollation = childStr(schema, 'defaultCollationName');
        if (defaultCharset) {dbNode.defaultCharset = defaultCharset;}
        if (defaultCollation) {dbNode.defaultCollation = defaultCollation;}
        /*
         * Schema-level passthrough. The writer emits each of the
         * following on its own path — keep these out of passthrough
         * so we don't double-emit:
         *   - `tables`, `views`, `routines` (modelled children)
         *   - `routineGroups`, `sequences`, `structuredTypes`,
         *     `synonyms` (always-empty placeholders the writer
         *     re-emits per Workbench convention)
         *   - `name`, `oldName`, `owner` (writer regenerates)
         *   - `defaultCharacterSetName`, `defaultCollationName`
         *     (lifted to JsonDataDB.defaultCharset/Collation above)
         * Everything else (events, temp_sql, vendor extension fields)
         * captured for round-trip preservation.
         */
        const consumedSchemaKeys = new Set([
            'tables', 'views', 'routines', 'name', 'oldName', 'owner',
            'comment', 'routineGroups', 'sequences', 'structuredTypes', 'synonyms',
            'defaultCharacterSetName', 'defaultCollationName'
        ]);
        const schemaPt = capturePassthrough(schema, consumedSchemaKeys, 4);
        if (schemaPt) {dbNode.wbPassthrough = schemaPt;}
        databases.push(dbNode);
    }

    return {
        schemaCount: databases.length,
        tableCount: tableCount,
        columnCount: columnCount,
        indexCount: indexCount,
        foreignKeyCount: fkCount,
        positionedTableCount: positionedTableCount,
        positionedViewCount: positionedViewCount,
        multiDiagramTableCount: multiDiagramTableCount,
        viewCount: viewCount,
        routineCount: routineCount,
        triggerCount: triggerCount,
        layerCount: figureData.diagrams.length,
        databases: databases,
        routineOriginalXml: routineOriginalXml,
        viewOriginalXml: viewOriginalXml,
        tableOriginalXml: tableOriginalXml
    };
};

/**
 * Convenience: wrap `parseMwb` output into a root-level `JsonDataDB`
 * suitable for `replaceFs`. Imported databases become direct children
 * of the synthetic root node.
 */
export const parseMwbAsFsRoot = (buffer: Buffer): { fs: JsonDataDB; stats: MwbImportResult; } => {
    const stats = parseMwb(buffer);
    const fs: JsonDataDB = {
        unid: 'root',
        name: 'root',
        type: JsonDataDBType.root,
        entrys: stats.databases,
        tables: [],
        views: [],
        enums: [],
        routines: []
    };
    return {fs: fs, stats: stats};
};