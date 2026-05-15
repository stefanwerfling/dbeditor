import {JsonColumn, JsonDataDB, JsonEnum, JsonTable} from '../DbEditor/JsonData.js';
import {DbFsTreeWalker} from '../DbRepository/DbFsTreeWalker.js';
import {DialectContext} from './DbDialect.js';

/**
 * Builds a `DialectContext` from a model tree. The context exposes
 * cross-table lookups (FK targets, enum types referenced by columns) by
 * `unid`. Both the file/migration codegen and the sync codegen share this
 * helper so context shape never diverges between them.
 */
export const buildDialectContextFromModel = (
    modelRoot: JsonDataDB,
    indent: string,
    terminator: string,
    comments: boolean
): DialectContext => {
    const tablesByUnid = new Map<string, JsonTable>();
    const enumsByUnid = new Map<string, JsonEnum>();
    for (const {table} of DbFsTreeWalker.allTables(modelRoot)) {tablesByUnid.set(table.unid, table);}
    for (const {enum: e} of DbFsTreeWalker.allEnums(modelRoot)) {enumsByUnid.set(e.unid, e);}

    const columnsByTable = new Map<string, Map<string, JsonColumn>>();
    for (const {table} of DbFsTreeWalker.allTables(modelRoot)) {
        const m = new Map<string, JsonColumn>();
        for (const c of table.columns) {m.set(c.unid, c);}
        columnsByTable.set(table.unid, m);
    }

    return {
        indent: indent,
        terminator: terminator,
        comments: comments,
        findTable: (unid): JsonTable | undefined => tablesByUnid.get(unid),
        findEnum: (unid): JsonEnum | undefined => enumsByUnid.get(unid),
        findColumn: (tableUnid, columnUnid): JsonColumn | undefined => columnsByTable.get(tableUnid)?.get(columnUnid)
    };
};