import {JsonDataDB, JsonEnum, JsonDiagram, JsonTable, JsonView} from '../JsonData.js';

export type WarningSeverity = 'error' | 'warning' | 'info';

export type SchemaWarning = {
    severity: WarningSeverity;
    message: string;
    containerUnid?: string;
    tableUnid?: string;
    tableName?: string;
};

export class SchemaValidator {

    private static _isContainer(node: JsonDataDB): boolean {
        return node.type === 'database' || node.type === 'folder' || node.type === 'project' || node.type === 'root';
    }

    private static _checkTable(
        t: JsonTable,
        container: JsonDataDB | null,
        enumsByUnid: Map<string, JsonEnum>,
        layersByUnid: Map<string, JsonDiagram>,
        out: SchemaWarning[]
    ): void {
        const containerUnid = container?.unid;
        const base = {containerUnid: containerUnid, tableUnid: t.unid, tableName: t.name};

        /*
         * Dangling diagramUnid — table references a diagram the user deleted.
         * `deleteDiagram` deliberately leaves the ref intact so undo can
         * restore the diagram; this surfaces it in the warnings panel so
         * the user can clear it (or recreate the diagram) when they're done.
         * Multi-membership placements get the same treatment — one warning
         * per dangling reference rather than collapsing to one summary.
         */
        if (t.diagramUnid && !layersByUnid.has(t.diagramUnid)) {
            out.push({
                severity: 'warning',
                message: `Table "${t.name}" references a deleted diagram.`,
                ...base
            });
        }
        for (const p of t.diagramPlacements ?? []) {
            if (!layersByUnid.has(p.diagramUnid)) {
                out.push({
                    severity: 'warning',
                    message: `Table "${t.name}" placement references a deleted diagram.`,
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
    }

    private static _checkView(
        v: JsonView,
        container: JsonDataDB | null,
        layersByUnid: Map<string, JsonDiagram>,
        out: SchemaWarning[]
    ): void {
        if (v.diagramUnid && !layersByUnid.has(v.diagramUnid)) {
            out.push({
                severity: 'warning',
                message: `View "${v.name}" references a deleted diagram.`,
                containerUnid: container?.unid
            });
        }
        for (const p of v.diagramPlacements ?? []) {
            if (!layersByUnid.has(p.diagramUnid)) {
                out.push({
                    severity: 'warning',
                    message: `View "${v.name}" placement references a deleted diagram.`,
                    containerUnid: container?.unid
                });
            }
        }
    }

    private static _walk(
        node: JsonDataDB,
        container: JsonDataDB | null,
        enumsByUnid: Map<string, JsonEnum>,
        layersByUnid: Map<string, JsonDiagram>,
        out: SchemaWarning[]
    ): void {
        const myContainer = SchemaValidator._isContainer(node) ? node : container;
        for (const t of node.tables) {
            SchemaValidator._checkTable(t, myContainer, enumsByUnid, layersByUnid, out);
        }
        for (const v of node.views) {
            SchemaValidator._checkView(v, myContainer, layersByUnid, out);
        }
        for (const child of node.entrys as JsonDataDB[]) {
            SchemaValidator._walk(child, myContainer, enumsByUnid, layersByUnid, out);
        }
    }

    /**
     * Pre-pass: collect every enum across the tree so the per-table
     * column check can resolve `enumRef` without re-walking the project.
     */
    private static _collectEnums(node: JsonDataDB, out: Map<string, JsonEnum>): void {
        for (const e of node.enums) {out.set(e.unid, e);}
        for (const child of node.entrys as JsonDataDB[]) {SchemaValidator._collectEnums(child, out);}
    }

    /** Pre-pass: collect every diagram so dangling `diagramUnid` checks resolve in O(1). */
    private static _collectLayers(node: JsonDataDB, out: Map<string, JsonDiagram>): void {
        for (const l of node.diagrams ?? []) {out.set(l.unid, l);}
        for (const child of node.entrys as JsonDataDB[]) {SchemaValidator._collectLayers(child, out);}
    }

    /**
     * Walk every database container and flag any sibling tables that
     * share a name (case-insensitive). Cross-database collisions don't
     * matter — SQL scopes table names per schema. We don't include
     * folders here on purpose: folders are a UI grouping, the SQL
     * generator flattens them.
     */
    private static _checkDuplicateTableNames(node: JsonDataDB, out: SchemaWarning[]): void {
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
        for (const child of node.entrys as JsonDataDB[]) {SchemaValidator._checkDuplicateTableNames(child, out);}
    }

    /**
     * Heuristic schema linter. Walks the project's data tree and flags
     * common modelling mistakes. Pure: no DOM, no API. Run after each
     * reload and re-render the panel from the result.
     */
    public static validate(root: JsonDataDB): SchemaWarning[] {
        const out: SchemaWarning[] = [];
        const enumsByUnid = new Map<string, JsonEnum>();
        const layersByUnid = new Map<string, JsonDiagram>();
        SchemaValidator._collectEnums(root, enumsByUnid);
        SchemaValidator._collectLayers(root, layersByUnid);
        SchemaValidator._walk(root, null, enumsByUnid, layersByUnid, out);
        SchemaValidator._checkDuplicateTableNames(root, out);
        return out;
    }

}