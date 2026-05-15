import {JsonColumn, JsonForeignKey, JsonIndex, JsonTableOptions, JsonView} from '../DbEditor/JsonData.js';

/**
 * Normalisers used by the diff engine to decide whether two values are
 * "the same" despite cosmetic differences (case, undefined-vs-false,
 * `int(11)` vs `INT(11)`, etc.). The goal is to keep the changeset focused
 * on differences a human would consider meaningful.
 */

const normalizeFlag = (v: boolean | undefined): boolean => Boolean(v);

const normalizeStr = (v: string | undefined): string => (v ?? '').trim();

const normalizeTypeLength = (col: JsonColumn): { type: string; length: string; } => {
    const t = normalizeStr(col.type).toLowerCase();
    let len = normalizeStr(col.length);
    /*
     * MySQL silently expands `decimal` to `decimal(10,0)` and `varchar`
     * length is always meaningful; we keep whatever the source says.
     */
    if (t === 'boolean' || t === 'bool') {len = '';}
    return {type: t, length: len};
};

const normalizeDefault = (v: string | undefined): string => {
    const s = normalizeStr(v);
    if (!s) {return '';}
    /*
     * MySQL stores function defaults case-sensitively in
     * information_schema (`CURRENT_TIMESTAMP`); MariaDB likes the
     * function-call form with empty parens (`current_timestamp()`).
     * Audit columns often combine both clauses
     * (`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`) which the
     * introspector glues back together from `EXTRA`. Normalise all
     * variants to a single canonical form: lowercase, empty parens
     * stripped (globally — there can be more than one occurrence),
     * collapsed whitespace. String literals stay exact (case + quotes
     * preserved).
     */
    if (/current_timestamp|^now\(/iu.test(s)) {
        return s.toLowerCase()
        .replace(/\(\s*\)/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
    }
    return s;
};

export type ColumnDiff = {
    fields: string[];
};

export const diffColumn = (live: JsonColumn, model: JsonColumn, ignore: Set<string>): ColumnDiff | null => {
    const fields: string[] = [];
    const liveTL = normalizeTypeLength(live);
    const modelTL = normalizeTypeLength(model);
    if (liveTL.type !== modelTL.type) {fields.push('type');}
    if (liveTL.length !== modelTL.length) {fields.push('length');}
    if (normalizeFlag(live.notNull)       !== normalizeFlag(model.notNull))       {fields.push('notNull');}
    if (normalizeFlag(live.primaryKey)    !== normalizeFlag(model.primaryKey))    {fields.push('primaryKey');}
    if (normalizeFlag(live.autoIncrement) !== normalizeFlag(model.autoIncrement)) {fields.push('autoIncrement');}
    if (normalizeFlag(live.unique)        !== normalizeFlag(model.unique))        {fields.push('unique');}
    if (normalizeFlag(live.unsigned)      !== normalizeFlag(model.unsigned))      {fields.push('unsigned');}
    if (normalizeDefault(live.defaultValue) !== normalizeDefault(model.defaultValue)) {fields.push('defaultValue');}
    if (normalizeStr(live.comment) !== normalizeStr(model.comment)) {fields.push('comment');}
    if (!ignore.has('collation') && normalizeStr(live.collation) !== normalizeStr(model.collation)) {fields.push('collation');}
    if (!ignore.has('charset') && normalizeStr(live.charset) !== normalizeStr(model.charset)) {fields.push('charset');}
    return fields.length ? {fields: fields} : null;
};

export const indexesEquivalent = (live: JsonIndex, model: JsonIndex): boolean => {
    if (normalizeStr(live.type).toLowerCase() !== normalizeStr(model.type).toLowerCase()) {return false;}
    if (live.columns.length !== model.columns.length) {return false;}
    /*
     * Order-sensitive: the order of columns in an index changes its semantics,
     * so we don't sort before comparing.
     */
    for (let i = 0; i < live.columns.length; i++) {
        const a = live.columns[i];
        const b = model.columns[i];
        if (normalizeStr(a.order).toUpperCase() !== normalizeStr(b.order).toUpperCase() &&
            !(!a.order && (b.order === 'ASC' || b.order === '')) &&
            !(!b.order && (a.order === 'ASC' || a.order === ''))) {return false;}
        if ((a.length ?? 0) !== (b.length ?? 0)) {return false;}
        /*
         * Column matching across live/model must be by name — the unids on
         * the two sides are not interchangeable. Caller supplies a resolver
         * via `compareIndexesByColumnName` below.
         */
    }
    return true;
};

export const indexColumnNamesEqual = (
    live: JsonIndex, model: JsonIndex,
    liveColName: (unid: string) => string,
    modelColName: (unid: string) => string
): boolean => {
    if (live.columns.length !== model.columns.length) {return false;}
    for (let i = 0; i < live.columns.length; i++) {
        if (liveColName(live.columns[i].columnUnid) !== modelColName(model.columns[i].columnUnid)) {return false;}
    }
    return true;
};

export const fksEquivalent = (
    live: JsonForeignKey, model: JsonForeignKey,
    liveColName: (unid: string) => string, modelColName: (unid: string) => string,
    liveTableName: (unid: string) => string, modelTableName: (unid: string) => string
): boolean => {
    if (liveTableName(live.refTableUnid) !== modelTableName(model.refTableUnid)) {return false;}
    if (normalizeStr(live.onDelete).toUpperCase() !== normalizeStr(model.onDelete).toUpperCase()) {return false;}
    if (normalizeStr(live.onUpdate).toUpperCase() !== normalizeStr(model.onUpdate).toUpperCase()) {return false;}
    if (live.columns.length !== model.columns.length) {return false;}
    for (let i = 0; i < live.columns.length; i++) {
        const a = live.columns[i];
        const b = model.columns[i];
        if (liveColName(a.columnUnid) !== modelColName(b.columnUnid)) {return false;}
        if (liveColName(a.refColumnUnid) !== modelColName(b.refColumnUnid)) {return false;}
    }
    return true;
};

/**
 * Database-level inheritance defaults supplied from `JsonDataDB` —
 * `defaultEngine`, `defaultCharset`, `defaultCollation`. Used by
 * `tableOptionsEquivalent` so a model table without explicit options
 * is treated as inheriting these values, matching live tables that
 * have the same values applied explicitly.
 */
export type TableOptionDefaults = {
    engine?: string;
    charset?: string;
    collation?: string;
};

export const tableOptionsEquivalent = (
    live: JsonTableOptions | undefined,
    model: JsonTableOptions | undefined,
    ignore: Set<string>,
    modelDefaults: TableOptionDefaults = {}
): boolean => {
    const l = live ?? {};
    const m = model ?? {};
    /*
     * For engine / charset / collation, fall back to the model's
     * database-level defaults when the per-table value is unset. This
     * lets a user configure inheritance once at the DB level
     * (Database properties dialog) and have the diff treat every
     * unset-table-options-but-matching-live-value as in-sync. Other
     * fields (tablespace, persistence, comment) don't have inherited
     * defaults — they're per-table only.
     */
    const effectiveModel: Record<string, string> = {
        engine: normalizeStr(m.engine) || normalizeStr(modelDefaults.engine),
        charset: normalizeStr(m.charset) || normalizeStr(modelDefaults.charset),
        collation: normalizeStr(m.collation) || normalizeStr(modelDefaults.collation),
        tablespace: normalizeStr(m.tablespace),
        persistence: normalizeStr(m.persistence),
        comment: normalizeStr(m.comment)
    };
    const fields = ['engine', 'charset', 'collation', 'tablespace', 'persistence', 'comment'] as const;
    for (const f of fields) {
        if (ignore.has(f)) {continue;}
        if (normalizeStr(l[f]).toLowerCase() !== effectiveModel[f].toLowerCase()) {return false;}
    }
    return true;
};

export const viewsEquivalent = (live: JsonView, model: JsonView): boolean => {
    if (normalizeFlag(live.materialized) !== normalizeFlag(model.materialized)) {return false;}
    /*
     * View bodies differ between what MySQL stored and what the user wrote
     * (the server rewrites identifier quoting, adds backticks, etc.). For
     * iter 1 we compare verbatim — false positives are acceptable; the user
     * sees the diff and decides. Iter 7 polish will normalise this.
     */
    return normalizeStr(live.select) === normalizeStr(model.select);
};