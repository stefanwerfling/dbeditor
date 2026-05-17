/* eslint-disable indent */
import {randomUUID} from 'crypto';
// eslint-disable-next-line import/extensions
import AdmZip from 'adm-zip';
import {
    JsonColumn,
    JsonDataDB,
    JsonDataDBType,
    JsonForeignKey,
    JsonIndex,
    JsonIndexType,
    JsonDiagram,
    JsonRoutine,
    JsonRoutineKind,
    JsonTable,
    JsonView
} from '../DbEditor/JsonData.js';

/**
 * Build a `.mwb` archive from one or more `JsonDataDB` databases. The
 * inverse of `MwbReader` — given a model, emit a Workbench-compatible
 * GRT XML wrapped in a ZIP, suitable for opening in MySQL Workbench.
 *
 * Lossy by design: only fields we model survive. Workbench-specific
 * extras (sequences, synonyms, structured types, role privileges,
 * canvas layers, EER diagrams beyond auto-layout) are emitted as
 * empty list placeholders so Workbench's loader doesn't reject the
 * file. The user's `output.destinationPath` SQL is also dropped — the
 * `.mwb` file is the model itself.
 *
 * Identifiers are minted fresh on every call: every struct gets a new
 * UUID. Cross-references (FK column → its column, FK → its table,
 * Index column → its column) are stitched up via a per-write map of
 * `JsonColumn.unid` / `JsonTable.unid` → newly-minted GRT UUID.
 *
 * Round-trip target: `parseMwb(writeMwb(parseMwb(buf))) ≅
 * parseMwb(buf)` for the fields we model. Workbench-actual
 * compatibility is best-effort — we mirror real Workbench files'
 * structural skeleton (header attrs, schema-level empty list
 * placeholders, required `oldName` / `defaultValueIsNull` /
 * `precision=-1` defaults on columns) but cannot validate it without
 * an actual Workbench install.
 */

const xmlEscape = (s: string): string =>
    s.replace(/&/gu, '&amp;')
     .replace(/</gu, '&lt;')
     .replace(/>/gu, '&gt;')
     .replace(/"/gu, '&quot;');

const I = (n: number): string => '  '.repeat(n);

/* GRT scalar emitters --------------------------------------------------- */

const vStr = (key: string, value: string, depth: number): string =>
    `${I(depth)}<value type="string" key="${key}">${xmlEscape(value)}</value>\n`;

const vInt = (key: string, value: number, depth: number): string =>
    `${I(depth)}<value type="int" key="${key}">${value}</value>\n`;

const lStr = (key: string, structName: string, value: string, depth: number): string =>
    `${I(depth)}<link type="object" struct-name="${structName}" key="${key}">${xmlEscape(value)}</link>\n`;

const emptyList = (key: string, contentStructName: string, contentType: string, depth: number): string =>
    `${I(depth)}<value type="list" content-type="${contentType}" content-struct-name="${contentStructName}" key="${key}"/>\n`;

const emptyDict = (key: string, depth: number): string =>
    `${I(depth)}<value type="dict" key="${key}"/>\n`;

/**
 * Emit captured Phase E passthrough children at `depth`. Each captured
 * fragment in `wbPassthrough.values` is a raw XML string serialised by
 * `MwbReader.serializeNode` at the same nesting level — we just append
 * each with a trailing newline. Returns `''` when there's nothing to
 * emit so callers can call unconditionally.
 *
 * `attrs` (unknown attributes on the entity's open tag) are NOT emitted
 * here — the caller splices them into the opening `<value ...>` tag.
 */
const writePassthroughBody = (pt: {values?: {key: string; xml: string;}[];} | undefined): string => {
    if (!pt?.values?.length) {return '';}
    let s = '';
    for (const v of pt.values) {
        s += `${v.xml}\n`;
    }
    return s;
};

/**
 * Format captured Phase E passthrough attrs as a space-prefixed string
 * ready to append to the entity's open tag. `' key="value"'`-style; the
 * leading space is included so caller can interpolate directly.
 */
const writePassthroughAttrs = (pt: {attrs?: {name: string; value: string;}[];} | undefined): string => {
    if (!pt?.attrs?.length) {return '';}
    return pt.attrs.map(a => ` ${a.name}="${xmlEscape(a.value)}"`).join('');
};

/**
 * Look up the matching `com.mysql.rdbms.mysql.datatype.X` ref for a
 * logical column type. Mirrors the reverse mapping from `mapSimpleType`
 * in `MwbReader.ts` — anything we don't have a special case for falls
 * through as the lowercase identity.
 */
const mapToWbDatatype = (type: string): string => {
    const t = (type || 'varchar').toLowerCase();
    return `com.mysql.rdbms.mysql.datatype.${t}`;
};

type IdMaps = {
    tableId: Map<string, string>;
    columnId: Map<string, string>;
    indexId: Map<string, string>;
    fkId: Map<string, string>;
    /** Model diagram unid → minted GRT diagram ID. Populated up-front from collected layers so figure→diagram links can resolve. */
    layerId: Map<string, string>;
    /** Model view unid → minted GRT view ID. Populated up-front so ViewFigure can point at its view. */
    viewId: Map<string, string>;
};

const newIdMaps = (): IdMaps => ({
    tableId: new Map(),
    columnId: new Map(),
    indexId: new Map(),
    fkId: new Map(),
    layerId: new Map(),
    viewId: new Map()
});

/* ------------------------------------------------------------------ */

/**
 * Decompose `JsonColumn.length` back into `(length, precision, scale)`
 * the way Workbench stores them — integer length for char/varchar/binary,
 * `precision[,scale]` for decimal/numeric. Defaults to `-1` so empty
 * fields round-trip to "no value set".
 */
const decodeLength = (col: JsonColumn): {length: number; precision: number; scale: number;} => {
    const t = col.type.toLowerCase();
    if ((t === 'decimal' || t === 'numeric') && col.length) {
        const parts = col.length.split(',').map(s => s.trim());
        const p = Number(parts[0]);
        const s = parts.length > 1 ? Number(parts[1]) : -1;
        return {length: -1, precision: Number.isFinite(p) ? p : -1, scale: Number.isFinite(s) ? s : -1};
    }
    if (col.length) {
        const n = Number(col.length);
        if (Number.isFinite(n)) {return {length: n, precision: -1, scale: -1};}
    }
    return {length: -1, precision: -1, scale: -1};
};

const writeColumn = (col: JsonColumn, ownerId: string, ids: IdMaps, depth: number): string => {
    const id = ids.columnId.get(col.unid) ?? randomUUID();
    ids.columnId.set(col.unid, id);
    const {length, precision, scale} = decodeLength(col);
    const flags: string[] = [];
    if (col.unsigned) {flags.push('UNSIGNED');}
    const ptAttrs = writePassthroughAttrs(col.wbPassthrough);

    let s = `${I(depth)}<value type="object" struct-name="db.mysql.Column" id="${id}"${ptAttrs}>\n`;
    s += vInt('autoIncrement', col.autoIncrement ? 1 : 0, depth + 1);
    s += vStr('characterSetName', col.charset ?? '', depth + 1);
    s += vStr('collationName', col.collation ?? '', depth + 1);
    s += vStr('defaultValue', col.defaultValue ?? '', depth + 1);
    s += vInt('defaultValueIsNull', col.defaultValue ? 0 : 1, depth + 1);
    if (flags.length === 0) {
        s += emptyList('flags', '', 'string', depth + 1);
    } else {
        s += `${I(depth + 1)}<value type="list" content-type="string" key="flags">\n`;
        for (const f of flags) {
            s += `${I(depth + 2)}<value type="string">${xmlEscape(f)}</value>\n`;
        }
        s += `${I(depth + 1)}</value>\n`;
    }
    s += vInt('isNotNull', col.notNull ? 1 : 0, depth + 1);
    s += vInt('length', length, depth + 1);
    s += vInt('precision', precision, depth + 1);
    s += vInt('scale', scale, depth + 1);
    s += lStr('simpleType', 'db.SimpleDatatype', mapToWbDatatype(col.type), depth + 1);
    s += vStr('comment', col.comment ?? '', depth + 1);
    s += vStr('name', col.name, depth + 1);
    s += vStr('oldName', col.name, depth + 1);
    s += lStr('owner', 'GrtObject', ownerId, depth + 1);
    s += writePassthroughBody(col.wbPassthrough);
    s += `${I(depth)}</value>\n`;
    return s;
};

const writeIndexColumn = (refWbColUnid: string, descend: boolean, columnLength: number, ownerId: string, ids: IdMaps, depth: number): string => {
    const refId = ids.columnId.get(refWbColUnid);
    if (!refId) {return '';}
    const id = randomUUID();
    let s = `${I(depth)}<value type="object" struct-name="db.mysql.IndexColumn" id="${id}">\n`;
    s += vInt('columnLength', columnLength, depth + 1);
    s += vInt('descend', descend ? 1 : 0, depth + 1);
    s += lStr('referencedColumn', 'db.Column', refId, depth + 1);
    s += vStr('name', '', depth + 1);
    s += lStr('owner', 'GrtObject', ownerId, depth + 1);
    s += `${I(depth)}</value>\n`;
    return s;
};

/**
 * Emit a synthesised PRIMARY index covering every column flagged
 * `primaryKey: true`. Workbench expects PKs as `db.mysql.Index`
 * with `isPrimary=1`; our model surfaces them as a column flag, so
 * we rebuild the index struct here on the way out.
 */
const writePrimaryIndex = (table: JsonTable, ids: IdMaps, depth: number): string => {
    const pkCols = table.columns.filter(c => c.primaryKey);
    if (pkCols.length === 0) {return '';}
    const id = randomUUID();
    let s = `${I(depth)}<value type="object" struct-name="db.mysql.Index" id="${id}">\n`;
    s += `${I(depth + 1)}<value type="list" content-type="object" content-struct-name="db.mysql.IndexColumn" key="columns">\n`;
    for (const c of pkCols) {
        s += writeIndexColumn(c.unid, false, 0, id, ids, depth + 2);
    }
    s += `${I(depth + 1)}</value>\n`;
    s += vStr('indexType', 'PRIMARY', depth + 1);
    s += vInt('isPrimary', 1, depth + 1);
    s += vInt('unique', 1, depth + 1);
    s += vStr('name', 'PRIMARY', depth + 1);
    s += vStr('oldName', 'PRIMARY', depth + 1);
    s += `${I(depth)}</value>\n`;
    return s;
};

const writeIndex = (idx: JsonIndex, ids: IdMaps, depth: number): string => {
    const id = randomUUID();
    ids.indexId.set(idx.unid, id);
    const t = String(idx.type).toLowerCase();
    let indexType = 'INDEX';
    let unique = 0;
    if (t === JsonIndexType.unique)        {indexType = 'UNIQUE'; unique = 1;}
    else if (t === JsonIndexType.fulltext) {indexType = 'FULLTEXT';}
    else if (t === JsonIndexType.spatial)  {indexType = 'SPATIAL';}

    const ptAttrs = writePassthroughAttrs(idx.wbPassthrough);
    let s = `${I(depth)}<value type="object" struct-name="db.mysql.Index" id="${id}"${ptAttrs}>\n`;
    s += `${I(depth + 1)}<value type="list" content-type="object" content-struct-name="db.mysql.IndexColumn" key="columns">\n`;
    for (const ic of idx.columns) {
        s += writeIndexColumn(ic.columnUnid, ic.order === 'DESC', ic.length ?? 0, id, ids, depth + 2);
    }
    s += `${I(depth + 1)}</value>\n`;
    s += vStr('indexType', indexType, depth + 1);
    s += vInt('isPrimary', 0, depth + 1);
    s += vInt('unique', unique, depth + 1);
    s += vStr('name', idx.name, depth + 1);
    s += vStr('oldName', idx.name, depth + 1);
    if (idx.comment) {s += vStr('comment', idx.comment, depth + 1);}
    s += writePassthroughBody(idx.wbPassthrough);
    s += `${I(depth)}</value>\n`;
    return s;
};

const writeForeignKey = (fk: JsonForeignKey, ownerTableId: string, ids: IdMaps, depth: number): string => {
    const refTableId = ids.tableId.get(fk.refTableUnid);
    if (!refTableId) {return '';}
    const localIds: string[] = [];
    const refIds: string[] = [];
    for (const pair of fk.columns) {
        const lid = ids.columnId.get(pair.columnUnid);
        const rid = ids.columnId.get(pair.refColumnUnid);
        if (!lid || !rid) {return '';}
        localIds.push(lid);
        refIds.push(rid);
    }

    const id = randomUUID();
    ids.fkId.set(fk.unid, id);
    const ptAttrs = writePassthroughAttrs(fk.wbPassthrough);
    let s = `${I(depth)}<value type="object" struct-name="db.mysql.ForeignKey" id="${id}"${ptAttrs}>\n`;
    s += lStr('referencedTable', 'db.mysql.Table', refTableId, depth + 1);
    s += `${I(depth + 1)}<value type="list" content-type="object" content-struct-name="db.Column" key="columns">\n`;
    for (const lid of localIds) {
        s += `${I(depth + 2)}<link type="object">${lid}</link>\n`;
    }
    s += `${I(depth + 1)}</value>\n`;
    s += `${I(depth + 1)}<value type="list" content-type="object" content-struct-name="db.Column" key="referencedColumns">\n`;
    for (const rid of refIds) {
        s += `${I(depth + 2)}<link type="object">${rid}</link>\n`;
    }
    s += `${I(depth + 1)}</value>\n`;
    s += vStr('deleteRule', String(fk.onDelete ?? ''), depth + 1);
    s += vStr('updateRule', String(fk.onUpdate ?? ''), depth + 1);
    s += vStr('comment', fk.comment ?? '', depth + 1);
    s += vStr('name', fk.name, depth + 1);
    s += vStr('oldName', fk.name, depth + 1);
    s += lStr('owner', 'db.Table', ownerTableId, depth + 1);
    s += writePassthroughBody(fk.wbPassthrough);
    s += `${I(depth)}</value>\n`;
    return s;
};

const writeTrigger = (tg: JsonRoutine, ownerTableId: string, depth: number): string => {
    const id = randomUUID();
    let s = `${I(depth)}<value type="object" struct-name="db.mysql.Trigger" id="${id}">\n`;
    s += vStr('sqlDefinition', tg.body, depth + 1);
    s += vStr('comment', tg.description ?? '', depth + 1);
    s += vStr('name', tg.name, depth + 1);
    s += lStr('owner', 'db.Table', ownerTableId, depth + 1);
    s += `${I(depth)}</value>\n`;
    return s;
};

/*
 * Phase E.2 owner-link rewrite. Cached entity XML carries the
 * original Workbench schema id in its owner link; we point it at
 * the current schemaId so the cross-reference resolves in the
 * regenerated document scaffold.
 */
const rewriteOwnerLink = (xml: string, newOwner: string): string =>
    xml.replace(/(<link\b[^>]*\bkey="owner"[^>]*>)[^<]+(<\/link>)/gu, `$1${newOwner}$2`);

/*
 * Phase E.2 root-id extraction. The cached XML opens with
 * `<value type="object" ... id="UUID">` — pull UUID so other
 * entities that cross-ref this one (ViewFigures pointing at a
 * view, FK referencedTable links pointing at a table) emit links
 * that resolve in the regenerated doc.
 */
const extractRootId = (xml: string): string | null => {
    const m = xml.match(/<value\b[^>]*\bid="([^"]+)"/u);
    return m ? m[1] : null;
};

const writeTable = (
    table: JsonTable,
    schemaId: string,
    ids: IdMaps,
    depth: number,
    cachedXml: string | undefined
): string => {
    if (cachedXml) {
        const patched = rewriteOwnerLink(cachedXml, schemaId);
        return patched.endsWith('\n') ? patched : `${patched}\n`;
    }
    const id = ids.tableId.get(table.unid) ?? randomUUID();
    ids.tableId.set(table.unid, id);

    const ptAttrs = writePassthroughAttrs(table.wbPassthrough);
    let s = `${I(depth)}<value type="object" struct-name="db.mysql.Table" id="${id}"${ptAttrs}>\n`;
    s += `${I(depth + 1)}<value type="list" content-type="object" content-struct-name="db.mysql.Column" key="columns">\n`;
    for (const c of table.columns) {
        s += writeColumn(c, id, ids, depth + 2);
    }
    s += `${I(depth + 1)}</value>\n`;

    s += `${I(depth + 1)}<value type="list" content-type="object" content-struct-name="db.mysql.Index" key="indices">\n`;
    s += writePrimaryIndex(table, ids, depth + 2);
    for (const ix of table.indexes) {
        s += writeIndex(ix, ids, depth + 2);
    }
    s += `${I(depth + 1)}</value>\n`;

    s += `${I(depth + 1)}<value type="list" content-type="object" content-struct-name="db.mysql.ForeignKey" key="foreignKeys">\n`;
    for (const fk of table.foreignKeys) {
        s += writeForeignKey(fk, id, ids, depth + 2);
    }
    s += `${I(depth + 1)}</value>\n`;

    /*
     * Triggers from the routines list are nested inside their owning
     * table. We emit an empty triggers list placeholder; the real
     * nesting happens at the schema level (see writeSchema) where we
     * fan triggers back into their tables.
     */
    s += emptyList('triggers', 'db.mysql.Trigger', 'object', depth + 1);

    s += vStr('tableEngine', table.options?.engine ?? '', depth + 1);
    s += vStr('defaultCharacterSetName', table.options?.charset ?? '', depth + 1);
    s += vStr('defaultCollationName', table.options?.collation ?? '', depth + 1);
    s += vStr('comment', table.options?.comment ?? '', depth + 1);
    s += vStr('name', table.name, depth + 1);
    s += vStr('oldName', table.name, depth + 1);
    s += lStr('owner', 'GrtObject', schemaId, depth + 1);
    s += writePassthroughBody(table.wbPassthrough);
    s += `${I(depth)}</value>\n`;
    return s;
};

const writeView = (
    v: JsonView,
    schemaId: string,
    ids: IdMaps,
    depth: number,
    cachedXml: string | undefined
): string => {
    if (cachedXml) {
        const patched = rewriteOwnerLink(cachedXml, schemaId);
        return patched.endsWith('\n') ? patched : `${patched}\n`;
    }
    const id = ids.viewId.get(v.unid) ?? randomUUID();
    ids.viewId.set(v.unid, id);
    const ptAttrs = writePassthroughAttrs(v.wbPassthrough);
    let s = `${I(depth)}<value type="object" struct-name="db.mysql.View" id="${id}"${ptAttrs}>\n`;
    s += vStr('sqlDefinition', v.select, depth + 1);
    s += vStr('comment', v.description ?? '', depth + 1);
    s += vStr('name', v.name, depth + 1);
    s += vStr('oldName', v.name, depth + 1);
    s += lStr('owner', 'GrtObject', schemaId, depth + 1);
    s += writePassthroughBody(v.wbPassthrough);
    s += `${I(depth)}</value>\n`;
    return s;
};

const writeRoutine = (
    r: JsonRoutine,
    schemaId: string,
    depth: number,
    cachedXml: string | undefined
): string => {
    if (cachedXml) {
        /*
         * Phase E.2 fast path. The routine hasn't been touched since
         * import — re-emit the raw source bytes, only patching the
         * owner link so it points at this document's schemaId. The
         * outer indent stays as-captured (Workbench's loader doesn't
         * care; our own re-parser is whitespace-insensitive). Add a
         * trailing newline if the captured slice didn't end with one
         * so list separation stays consistent with regenerated
         * siblings.
         */
        const patched = rewriteOwnerLink(cachedXml, schemaId);
        return patched.endsWith('\n') ? patched : `${patched}\n`;
    }
    const id = randomUUID();
    const kind = String(r.kind).toLowerCase();
    const wbType = kind === JsonRoutineKind.function ? 'function' : 'procedure';
    const ptAttrs = writePassthroughAttrs(r.wbPassthrough);
    let s = `${I(depth)}<value type="object" struct-name="db.mysql.Routine" id="${id}"${ptAttrs}>\n`;
    s += vStr('routineType', wbType, depth + 1);
    s += vStr('sqlDefinition', r.body, depth + 1);
    s += vStr('comment', r.description ?? '', depth + 1);
    s += vStr('name', r.name, depth + 1);
    s += vStr('oldName', r.name, depth + 1);
    s += lStr('owner', 'GrtObject', schemaId, depth + 1);
    s += writePassthroughBody(r.wbPassthrough);
    s += `${I(depth)}</value>\n`;
    return s;
};

type WriteMwbOptions = {
    /**
     * Phase E.2 per-object roundtrip caches. Map of model unid →
     * raw outer-XML bytes of the matching source struct. When
     * provided, the writer re-emits these bytes (with the owner
     * link patched to the current schemaId) instead of
     * regenerating. Missing entries fall back to regeneration.
     * For views, the writer also pre-populates ids.viewId from the
     * cached XML's `id="…"` attribute so ViewFigures keep pointing
     * at the actual cached struct rather than a fresh randomUUID().
     * Tables additionally carry their column GRT ids in order so
     * the writer can pre-populate ids.tableId AND ids.columnId for
     * cached tables — FKs in OTHER tables (cached or regenerated)
     * resolve consistently against the same id namespace.
     */
    routineXmlByUnid?: Map<string, string>;
    viewXmlByUnid?: Map<string, string>;
    tableCacheByUnid?: Map<string, {xml: string; grtId: string; columnGrtIds: string[];}>;
};

const writeSchema = (db: JsonDataDB, ids: IdMaps, depth: number, opts: WriteMwbOptions): string => {
    const schemaId = randomUUID();

    /*
     * Triggers in our model live at the schema level (kind=trigger);
     * Workbench wants them nested inside their owning table. The
     * `body` text starts with `CREATE TRIGGER name ... ON tableName
     * ...` — we parse the table name out heuristically. Triggers
     * whose body doesn't match get dropped (writer is lossy by
     * design).
     */
    const allRoutines = db.routines ?? [];
    const procFuncRoutines = allRoutines.filter(r => String(r.kind).toLowerCase() !== JsonRoutineKind.trigger);
    const triggerRoutines = allRoutines.filter(r => String(r.kind).toLowerCase() === JsonRoutineKind.trigger);
    const triggersByTableName = new Map<string, JsonRoutine[]>();
    for (const tg of triggerRoutines) {
        const m = tg.body.match(/\bON\s+(?:`([^`]+)`|([A-Za-z0-9_]+))/iu);
        const tname = m ? m[1] ?? m[2] : '';
        if (!tname) {continue;}
        const list = triggersByTableName.get(tname) ?? [];
        list.push(tg);
        triggersByTableName.set(tname, list);
    }

    const ptAttrs = writePassthroughAttrs(db.wbPassthrough);
    let s = `${I(depth)}<value type="object" struct-name="db.mysql.Schema" id="${schemaId}"${ptAttrs}>\n`;
    s += emptyList('routineGroups', 'db.mysql.RoutineGroup', 'object', depth + 1);
    s += emptyList('sequences',    'db.mysql.Sequence',     'object', depth + 1);
    s += emptyList('structuredTypes', 'db.mysql.StructuredDatatype', 'object', depth + 1);
    s += emptyList('synonyms',     'db.mysql.Synonym',      'object', depth + 1);

    s += `${I(depth + 1)}<value type="list" content-type="object" content-struct-name="db.mysql.Table" key="tables">\n`;
    /*
     * Table emit needs to know its triggers so we can swap the empty
     * placeholder. Two-pass: first emit the table to capture id +
     * column ids, then post-process to splice triggers in. Simpler
     * here: build per-table, then if the table has triggers, replace
     * the empty `triggers` list line with a populated one.
     */
    const flatTables = db.tables ?? [];
    for (const tbl of flatTables) {
        const cached = opts.tableCacheByUnid?.get(tbl.unid);
        const block = writeTable(tbl, schemaId, ids, depth + 2, cached?.xml);
        /*
         * Cached tables carry their original nested triggers in the
         * raw bytes — skip the trigger injection or we'd duplicate.
         * Any new trigger added after import invalidates the table
         * cache (routine.* family in _commit), so falling into the
         * regenerate path naturally picks it up via the placeholder
         * swap.
         */
        const triggers = cached ? [] : triggersByTableName.get(tbl.name) ?? [];
        if (triggers.length === 0) {
            s += block;
        } else {
            const ownerTableId = ids.tableId.get(tbl.unid)!;
            let inner = '';
            for (const tg of triggers) {
                inner += writeTrigger(tg, ownerTableId, depth + 3);
            }
            const placeholder = `${I(depth + 2 + 1)}<value type="list" content-type="object" content-struct-name="db.mysql.Trigger" key="triggers"/>\n`;
            const opened = `${I(depth + 2 + 1)}<value type="list" content-type="object" content-struct-name="db.mysql.Trigger" key="triggers">\n${inner}${I(depth + 2 + 1)}</value>\n`;
            s += block.replace(placeholder, opened);
        }
    }
    s += `${I(depth + 1)}</value>\n`;

    s += `${I(depth + 1)}<value type="list" content-type="object" content-struct-name="db.mysql.View" key="views">\n`;
    for (const v of db.views ?? []) {
        s += writeView(v, schemaId, ids, depth + 2, opts.viewXmlByUnid?.get(v.unid));
    }
    s += `${I(depth + 1)}</value>\n`;

    s += `${I(depth + 1)}<value type="list" content-type="object" content-struct-name="db.mysql.Routine" key="routines">\n`;
    for (const r of procFuncRoutines) {
        s += writeRoutine(r, schemaId, depth + 2, opts.routineXmlByUnid?.get(r.unid));
    }
    s += `${I(depth + 1)}</value>\n`;

    s += vStr('name', db.name, depth + 1);
    s += vStr('oldName', db.name, depth + 1);
    /*
     * Schema-level inheritance defaults round-tripped from / back to
     * the Workbench shape. Always emit (with empty string when the
     * model didn't carry them) so a Workbench reading our export gets
     * the same struct skeleton as the original.
     */
    s += vStr('defaultCharacterSetName', db.defaultCharset ?? '', depth + 1);
    s += vStr('defaultCollationName', db.defaultCollation ?? '', depth + 1);
    s += lStr('owner', 'GrtObject', 'catalog', depth + 1);
    s += writePassthroughBody(db.wbPassthrough);
    s += `${I(depth)}</value>\n`;
    return s;
};

/**
 * Walk a `JsonDataDB` tree (root → folders → ...) and return every
 * database node found. Folders are skipped — the GRT format flattens
 * everything into the catalog's schemata list.
 */
const collectDatabases = (node: JsonDataDB): JsonDataDB[] => {
    const out: JsonDataDB[] = [];
    if (node.type === JsonDataDBType.database) {out.push(node);}
    for (const child of node.entrys ?? []) {
        const c = child as JsonDataDB;
        if (!c || typeof c !== 'object') {continue;}
        out.push(...collectDatabases(c));
    }
    return out;
};

/**
 * Top-level entry: take a list of databases (or a single root tree)
 * and produce the bytes of a `.mwb` archive. Caller writes them to
 * disk or streams them to the browser.
 */
/**
 * Walk every positioned table AND view across all databases and emit
 * one figure per entity (TableFigure / ViewFigure). We bundle them into
 * a single `model.Diagram` named "EER Diagram" — the user can split
 * into multiple diagrams from inside Workbench afterwards. An entity is
 * "positioned" if its `pos` differs from the (80, 80) default fallback
 * the importer uses; entities without an authored position are skipped
 * so Workbench's auto-layout can place them.
 */
const writeDiagramFigures = (
    databases: JsonDataDB[],
    ids: IdMaps,
    diagramId: string,
    depth: number
): string => {
    const positionedTables: JsonTable[] = [];
    const positionedViews: JsonView[] = [];
    for (const db of databases) {
        for (const tbl of db.tables ?? []) {
            if (tbl.pos.x === 80 && tbl.pos.y === 80) {continue;}
            positionedTables.push(tbl);
        }
        for (const v of db.views ?? []) {
            if (v.pos.x === 80 && v.pos.y === 80) {continue;}
            positionedViews.push(v);
        }
    }
    if (positionedTables.length === 0 && positionedViews.length === 0) {return '';}

    let s = `${I(depth)}<value type="list" content-type="object" content-struct-name="model.Figure" key="figures">\n`;
    for (const tbl of positionedTables) {
        const tableId = ids.tableId.get(tbl.unid);
        if (!tableId) {continue;}
        const figId = randomUUID();
        s += `${I(depth + 1)}<value type="object" struct-name="workbench.physical.TableFigure" id="${figId}">\n`;
        s += vInt('expanded', 1, depth + 2);
        s += vInt('visible', 1, depth + 2);
        s += vInt('locked', 0, depth + 2);
        s += `${I(depth + 2)}<value type="real" key="left">${tbl.pos.x}</value>\n`;
        s += `${I(depth + 2)}<value type="real" key="top">${tbl.pos.y}</value>\n`;
        s += lStr('table', 'db.Table', tableId, depth + 2);
        if (tbl.diagramUnid) {
            const layerGrtId = ids.layerId.get(tbl.diagramUnid);
            if (layerGrtId) {s += lStr('layer', 'model.Layer', layerGrtId, depth + 2);}
        }
        s += lStr('owner', 'model.Diagram', diagramId, depth + 2);
        s += vStr('name', tbl.name, depth + 2);
        s += `${I(depth + 1)}</value>\n`;
    }
    for (const v of positionedViews) {
        const viewId = ids.viewId.get(v.unid);
        if (!viewId) {continue;}
        const figId = randomUUID();
        s += `${I(depth + 1)}<value type="object" struct-name="workbench.physical.ViewFigure" id="${figId}">\n`;
        s += vInt('expanded', 1, depth + 2);
        s += vInt('visible', 1, depth + 2);
        s += vInt('locked', 0, depth + 2);
        s += `${I(depth + 2)}<value type="real" key="left">${v.pos.x}</value>\n`;
        s += `${I(depth + 2)}<value type="real" key="top">${v.pos.y}</value>\n`;
        s += lStr('view', 'db.View', viewId, depth + 2);
        s += lStr('owner', 'model.Diagram', diagramId, depth + 2);
        s += vStr('name', v.name, depth + 2);
        s += `${I(depth + 1)}</value>\n`;
    }
    s += `${I(depth)}</value>\n`;
    return s;
};

/**
 * Emit one `workbench.physical.Layer` per JsonDiagram inside the
 * diagram's `layers` list. We deliberately do NOT key these as
 * `rootLayer` — Workbench autocreates the rootLayer per diagram;
 * what we want here are user-visible child layers. Each diagram has
 * its bounds (top/left/width/height), name, color, and an `owner`
 * link back to the diagram.
 */
const writeLayersForDiagram = (
    diagrams: JsonDiagram[],
    ids: IdMaps,
    diagramId: string,
    depth: number
): string => {
    if (diagrams.length === 0) {return '';}
    let s = `${I(depth)}<value type="list" content-type="object" content-struct-name="workbench.physical.Layer" key="layers">\n`;
    for (const diagram of diagrams) {
        const layerGrtId = ids.layerId.get(diagram.unid);
        if (!layerGrtId) {continue;}
        s += `${I(depth + 1)}<value type="object" struct-name="workbench.physical.Layer" id="${layerGrtId}">\n`;
        s += `${I(depth + 2)}<value type="real" key="left">${diagram.pos.x}</value>\n`;
        s += `${I(depth + 2)}<value type="real" key="top">${diagram.pos.y}</value>\n`;
        s += `${I(depth + 2)}<value type="real" key="width">${diagram.width}</value>\n`;
        s += `${I(depth + 2)}<value type="real" key="height">${diagram.height}</value>\n`;
        s += vStr('color', diagram.color ?? '', depth + 2);
        s += vStr('description', diagram.description ?? '', depth + 2);
        s += vStr('name', diagram.name, depth + 2);
        s += lStr('owner', 'model.Diagram', diagramId, depth + 2);
        s += `${I(depth + 1)}</value>\n`;
    }
    s += `${I(depth)}</value>\n`;
    return s;
};

/** Walk every database (recursing through folders) and collect all layers. */
const collectLayers = (databases: JsonDataDB[]): JsonDiagram[] => {
    const out: JsonDiagram[] = [];
    const walk = (n: JsonDataDB): void => {
        if (n.diagrams) {out.push(...n.diagrams);}
        for (const child of n.entrys as JsonDataDB[]) {walk(child);}
    };
    for (const db of databases) {walk(db);}
    return out;
};

export const writeMwb = (input: JsonDataDB[] | JsonDataDB, opts: WriteMwbOptions = {}): Buffer => {
    const databases = Array.isArray(input) ? input : collectDatabases(input);
    const documentId = randomUUID();
    const physicalModelId = randomUUID();
    const logicalModelId = randomUUID();
    const catalogId = 'catalog';

    /*
     * One IdMaps for the whole document. Schemas use it for FK
     * cross-refs; the diagram writer uses the same `tableId` entries
     * to point each TableFigure at its underlying table. Cross-schema
     * unid collisions can't happen — every model unid is globally
     * unique (`crypto.randomUUID()`).
     */
    const ids = newIdMaps();
    for (const db of databases) {
        for (const tbl of db.tables ?? []) {
            /*
             * Cached table? Seed ids from the cache so FKs in other
             * tables (cached or regenerated) resolve to the same
             * GRT ids the cached XML's own FK refs use. Column
             * order in the cache matches `tbl.columns` (Reader
             * captured them together).
             */
            const cached = opts.tableCacheByUnid?.get(tbl.unid);
            if (cached) {
                ids.tableId.set(tbl.unid, cached.grtId);
                for (let i = 0; i < tbl.columns.length && i < cached.columnGrtIds.length; i++) {
                    ids.columnId.set(tbl.columns[i].unid, cached.columnGrtIds[i]);
                }
            } else {
                ids.tableId.set(tbl.unid, randomUUID());
                for (const col of tbl.columns) {
                    ids.columnId.set(col.unid, randomUUID());
                }
            }
        }
        for (const v of db.views ?? []) {
            /*
             * Cached view? Lift the original GRT id out of the
             * cached XML so ViewFigures' `view` links still resolve
             * after re-emit. Without this, ids.viewId would mint a
             * new randomUUID() and the figure would dangle.
             */
            const cached = opts.viewXmlByUnid?.get(v.unid);
            const id = (cached && extractRootId(cached)) ?? randomUUID();
            ids.viewId.set(v.unid, id);
        }
    }
    /* Layers are minted before figures so figure→diagram links resolve. */
    const allLayers = collectLayers(databases);
    for (const diagram of allLayers) {
        ids.layerId.set(diagram.unid, randomUUID());
    }
    const diagramId = randomUUID();

    let xml = '<?xml version="1.0"?>\n';
    xml += '<data grt_format="2.0" document_type="MySQL Workbench Model" version="1.4.4">\n';
    xml += `${I(1)}<value type="object" struct-name="workbench.Document" id="${documentId}">\n`;

    /* Empty logical model placeholder. */
    xml += `${I(2)}<value type="object" struct-name="workbench.logical.Model" id="${logicalModelId}" key="logicalModel">\n`;
    xml += emptyList('diagrams', 'workbench.logical.Diagram', 'object', 3);
    xml += emptyDict('customData', 3);
    xml += emptyList('markers', 'model.Marker', 'object', 3);
    xml += emptyDict('options', 3);
    xml += vStr('name', 'logical', 3);
    xml += `${I(2)}</value>\n`;

    /* Physical model (the real payload). */
    xml += `${I(2)}<value type="list" content-type="object" content-struct-name="workbench.physical.Model" key="physicalModels">\n`;
    xml += `${I(3)}<value type="object" struct-name="workbench.physical.Model" id="${physicalModelId}">\n`;
    xml += `${I(4)}<value type="object" struct-name="db.mysql.Catalog" id="${catalogId}" key="catalog">\n`;
    xml += `${I(5)}<value type="list" content-type="object" content-struct-name="db.mysql.Schema" key="schemata">\n`;
    for (const db of databases) {
        xml += writeSchema(db, ids, 6, opts);
    }
    xml += `${I(5)}</value>\n`;
    xml += vStr('name', 'catalog', 5);
    xml += `${I(4)}</value>\n`;

    /* Diagrams list — a single canvas with one TableFigure per positioned table. */
    const figuresXml = writeDiagramFigures(databases, ids, diagramId, 5);
    if (figuresXml === '' && allLayers.length === 0) {
        xml += emptyList('diagrams', 'workbench.physical.Diagram', 'object', 4);
    } else {
        const layersXml = writeLayersForDiagram(allLayers, ids, diagramId, 5);
        xml += `${I(4)}<value type="list" content-type="object" content-struct-name="workbench.physical.Diagram" key="diagrams">\n`;
        xml += `${I(5)}<value type="object" struct-name="workbench.physical.Diagram" id="${diagramId}">\n`;
        xml += figuresXml;
        xml += emptyList('connections', 'model.Connection', 'object', 6);
        if (layersXml === '') {
            xml += emptyList('layers', 'workbench.physical.Layer', 'object', 6);
        } else {
            xml += layersXml;
        }
        xml += vStr('name', 'EER Diagram', 6);
        xml += `${I(5)}</value>\n`;
        xml += `${I(4)}</value>\n`;
    }

    xml += vStr('name', 'physical', 4);
    xml += `${I(3)}</value>\n`;
    xml += `${I(2)}</value>\n`;

    xml += vStr('name', 'document', 2);
    xml += `${I(1)}</value>\n`;
    xml += '</data>\n';

    const zip = new AdmZip();
    zip.addFile('document.mwb.xml', Buffer.from(xml, 'utf-8'));
    return zip.toBuffer();
};