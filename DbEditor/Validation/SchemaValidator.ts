import {JsonDataDB, JsonEnum, JsonLayer, JsonTable, JsonView} from '../JsonData.js';

export type WarningSeverity = 'error' | 'warning' | 'info';

export type SchemaWarning = {
    severity: WarningSeverity;
    message: string;
    containerUnid?: string;
    tableUnid?: string;
    tableName?: string;
};

const isContainer = (node: JsonDataDB): boolean =>
    node.type === 'database' || node.type === 'folder' || node.type === 'project' || node.type === 'root';

const checkTable = (
    t: JsonTable,
    container: JsonDataDB | null,
    enumsByUnid: Map<string, JsonEnum>,
    layersByUnid: Map<string, JsonLayer>,
    out: SchemaWarning[]
): void => {
    const containerUnid = container?.unid;
    const base = {containerUnid: containerUnid, tableUnid: t.unid, tableName: t.name};

    /*
     * Dangling layerUnid — table references a layer the user deleted.
     * `deleteLayer` deliberately leaves the ref intact so undo can
     * restore the layer; this surfaces it in the warnings panel so
     * the user can clear it (or recreate the layer) when they're done.
     * Multi-membership placements get the same treatment — one warning
     * per dangling reference rather than collapsing to one summary.
     */
    if (t.layerUnid && !layersByUnid.has(t.layerUnid)) {
        out.push({
            severity: 'warning',
            message: `Table "${t.name}" references a deleted layer.`,
            ...base
        });
    }
    for (const p of t.layerPlacements ?? []) {
        if (!layersByUnid.has(p.layerUnid)) {
            out.push({
                severity: 'warning',
                message: `Table "${t.name}" placement references a deleted layer.`,
                ...base
            });
        }
    }

    if (!t.columns.length) {
        out.push({severity: 'info', message: `Table "${t.name}" has no columns yet.`, ...base});
        return;
    }

    /*
     * Duplicate column names within a single table — common after a
     * copy-paste mistake; the SQL emit would fail at CREATE TABLE
     * time with a much less helpful error.
     */
    const seenNames = new Map<string, number>();
    for (const c of t.columns) {
        const key = c.name.toLowerCase();
        seenNames.set(key, (seenNames.get(key) ?? 0) + 1);
    }
    for (const [name, count] of seenNames) {
        if (count > 1) {
            out.push({
                severity: 'error',
                message: `Table "${t.name}" has ${count} columns named "${name}".`,
                ...base
            });
        }
    }

    /*
     * Enum-typed columns must point at a real JsonEnum via enumRef.
     * Either missing entirely or pointing at a deleted enum produces
     * generator failures downstream — surface here instead.
     */
    for (const c of t.columns) {
        if (c.type !== 'enum') {continue;}
        if (!c.enumRef) {
            out.push({
                severity: 'error',
                message: `Column "${t.name}.${c.name}" is type enum but has no enumRef set.`,
                ...base
            });
            continue;
        }
        if (!enumsByUnid.has(c.enumRef)) {
            out.push({
                severity: 'error',
                message: `Column "${t.name}.${c.name}" references a deleted enum.`,
                ...base
            });
        }
    }

    const pkCols = t.columns.filter((c) => c.primaryKey);
    if (!pkCols.length) {
        out.push({severity: 'warning', message: `Table "${t.name}" has no primary key.`, ...base});
    }

    const aiCols = t.columns.filter((c) => c.autoIncrement);
    for (const c of aiCols) {
        if (!c.primaryKey) {
            out.push({
                severity: 'warning',
                message: `Column "${t.name}.${c.name}" is auto-increment but not a primary key.`,
                ...base
            });
        }
    }
    if (aiCols.length > 1) {
        out.push({
            severity: 'error',
            message: `Table "${t.name}" has multiple auto-increment columns (${aiCols.map((c) => c.name).join(', ')}).`,
            ...base
        });
    }

    for (const fk of t.foreignKeys) {
        if (!fk.columns.length) {
            out.push({severity: 'error', message: `Foreign key "${t.name}.${fk.name}" has no columns.`, ...base});
            continue;
        }
        for (const pair of fk.columns) {
            const localCol = t.columns.find((c) => c.unid === pair.columnUnid);
            if (!localCol) {
                out.push({
                    severity: 'error',
                    message: `FK "${t.name}.${fk.name}" references a deleted local column.`,
                    ...base
                });
            }
        }
    }

    for (const ix of t.indexes) {
        if (!ix.columns.length) {
            out.push({severity: 'error', message: `Index "${t.name}.${ix.name}" has no columns.`, ...base});
            continue;
        }
        for (const c of ix.columns) {
            if (!t.columns.find((col) => col.unid === c.columnUnid)) {
                out.push({
                    severity: 'error',
                    message: `Index "${t.name}.${ix.name}" references a deleted column.`,
                    ...base
                });
                break;
            }
        }
    }
};

const checkView = (
    v: JsonView,
    container: JsonDataDB | null,
    layersByUnid: Map<string, JsonLayer>,
    out: SchemaWarning[]
): void => {
    if (v.layerUnid && !layersByUnid.has(v.layerUnid)) {
        out.push({
            severity: 'warning',
            message: `View "${v.name}" references a deleted layer.`,
            containerUnid: container?.unid
        });
    }
    for (const p of v.layerPlacements ?? []) {
        if (!layersByUnid.has(p.layerUnid)) {
            out.push({
                severity: 'warning',
                message: `View "${v.name}" placement references a deleted layer.`,
                containerUnid: container?.unid
            });
        }
    }
};

const walk = (
    node: JsonDataDB,
    container: JsonDataDB | null,
    enumsByUnid: Map<string, JsonEnum>,
    layersByUnid: Map<string, JsonLayer>,
    out: SchemaWarning[]
): void => {
    const myContainer = isContainer(node) ? node : container;
    for (const t of node.tables) {
        checkTable(t, myContainer, enumsByUnid, layersByUnid, out);
    }
    for (const v of node.views) {
        checkView(v, myContainer, layersByUnid, out);
    }
    for (const child of node.entrys as JsonDataDB[]) {
        walk(child, myContainer, enumsByUnid, layersByUnid, out);
    }
};

/**
 * Pre-pass: collect every enum across the tree so the per-table
 * column check can resolve `enumRef` without re-walking the project.
 */
const collectEnums = (node: JsonDataDB, out: Map<string, JsonEnum>): void => {
    for (const e of node.enums) {out.set(e.unid, e);}
    for (const child of node.entrys as JsonDataDB[]) {collectEnums(child, out);}
};

/** Pre-pass: collect every layer so dangling `layerUnid` checks resolve in O(1). */
const collectLayers = (node: JsonDataDB, out: Map<string, JsonLayer>): void => {
    for (const l of node.layers ?? []) {out.set(l.unid, l);}
    for (const child of node.entrys as JsonDataDB[]) {collectLayers(child, out);}
};

/**
 * Walk every database container and flag any sibling tables that
 * share a name (case-insensitive). Cross-database collisions don't
 * matter — SQL scopes table names per schema. We don't include
 * folders here on purpose: folders are a UI grouping, the SQL
 * generator flattens them.
 */
const checkDuplicateTableNames = (node: JsonDataDB, out: SchemaWarning[]): void => {
    if (node.type === 'database') {
        const collectTables = (n: JsonDataDB, acc: JsonTable[]): void => {
            for (const t of n.tables) {acc.push(t);}
            for (const child of n.entrys as JsonDataDB[]) {collectTables(child, acc);}
        };
        const all: JsonTable[] = [];
        collectTables(node, all);
        const counts = new Map<string, JsonTable[]>();
        for (const t of all) {
            const key = t.name.toLowerCase();
            const list = counts.get(key) ?? [];
            list.push(t);
            counts.set(key, list);
        }
        for (const [name, tables] of counts) {
            if (tables.length > 1) {
                for (const t of tables) {
                    out.push({
                        severity: 'warning',
                        message: `Database "${node.name}" has ${tables.length} tables named "${name}".`,
                        containerUnid: node.unid,
                        tableUnid: t.unid,
                        tableName: t.name
                    });
                }
            }
        }
    }
    for (const child of node.entrys as JsonDataDB[]) {checkDuplicateTableNames(child, out);}
};

/**
 * Heuristic schema linter. Walks the project's data tree and flags
 * common modelling mistakes. Pure: no DOM, no API. Run after each
 * reload and re-render the panel from the result.
 */
export const validateSchema = (root: JsonDataDB): SchemaWarning[] => {
    const out: SchemaWarning[] = [];
    const enumsByUnid = new Map<string, JsonEnum>();
    const layersByUnid = new Map<string, JsonLayer>();
    collectEnums(root, enumsByUnid);
    collectLayers(root, layersByUnid);
    walk(root, null, enumsByUnid, layersByUnid, out);
    checkDuplicateTableNames(root, out);
    return out;
};