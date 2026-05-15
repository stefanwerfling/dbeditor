import {JsonIndex, JsonIndexType, JsonTable} from '../JsonData.js';

const setsEqual = <T>(a: Set<T>, b: Set<T>): boolean => {
    if (a.size !== b.size) {return false;}
    for (const v of a) {
        if (!b.has(v)) {return false;}
    }
    return true;
};

const isUniqueIndex = (ix: JsonIndex): boolean => {
    const t = String(ix.type ?? '').toLowerCase();
    return t === JsonIndexType.unique;
};

/**
 * Decide whether an FK whose source-side columns are `fkColumnUnids`
 * represents a 1:1 relationship — i.e. the column tuple on the source
 * table is guaranteed unique. Used by the canvas renderer to pick the
 * one-bar overlay instead of the crow's-foot.
 *
 * "Guaranteed unique" means one of:
 *   - the FK column set is exactly the table's primary-key column set, or
 *   - a UNIQUE index exists whose column set is exactly the FK column set
 *     (order-insensitive on both sides; UNIQUE-on-a-superset doesn't count
 *     because the FK tuple could still repeat), or
 *   - single-column FK and the lone column carries the legacy column-level
 *     `unique: true` flag (older schemas before the indexes table modelled
 *     UNIQUE constraints; we honour it).
 *
 * Everything else is 1:n. The function is pure and order-insensitive
 * over `fkColumnUnids`.
 */
export const isOneToOneFk = (table: JsonTable, fkColumnUnids: string[]): boolean => {
    if (!fkColumnUnids.length) {return false;}

    const fkSet = new Set(fkColumnUnids);
    if (fkSet.size !== fkColumnUnids.length) {return false;}

    /* Case A — FK columns equal the table's PK columns. */
    const pkUnids = new Set(
        table.columns
        .filter(c => c.primaryKey === true)
        .map(c => c.unid)
    );
    if (pkUnids.size > 0 && setsEqual(pkUnids, fkSet)) {return true;}

    /*
     * Case B — A UNIQUE index covers exactly the FK columns. We compare
     * by column-unid sets, ignoring order (a unique index on (a, b) and
     * a FK on (b, a) refer to the same tuple-uniqueness guarantee).
     */
    for (const ix of table.indexes) {
        if (!isUniqueIndex(ix)) {continue;}
        const ixUnids = new Set(ix.columns.map(ic => ic.columnUnid));
        if (setsEqual(ixUnids, fkSet)) {return true;}
    }

    /*
     * Case C — single-column FK on a column flagged with the legacy
     * column-level UNIQUE bit. Composite FKs do NOT qualify under this
     * case: each individual column being UNIQUE doesn't imply the tuple
     * is unique (and in practice having two independent UNIQUEs across
     * two FK-columns of the same table is rare and confusing).
     */
    if (fkColumnUnids.length === 1) {
        const col = table.columns.find(c => c.unid === fkColumnUnids[0]);
        if (col?.unique === true) {return true;}
    }

    return false;
};