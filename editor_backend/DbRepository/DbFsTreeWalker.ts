import {JsonDataDB, JsonTable, JsonView, JsonEnum, JsonDiagram, JsonLayer, JsonRoutine} from '../../editor_frontend/DbEditor/JsonData.js';

/**
 * Tree-walk helpers. The recursive tree mixes `entrys` (subfolders/databases)
 * with object collections (`tables`, `views`, `enums`), so locating any node
 * by its unid means scanning all branches at every level.
 */
export class DbFsTreeWalker {

    /** Find the parent container of the given child unid (or root). */
    public static findContainer(root: JsonDataDB, unid: string): JsonDataDB | null {
        if (root.unid === unid) {return root;}
        for (const child of root.entrys as JsonDataDB[]) {
            const hit = DbFsTreeWalker.findContainer(child, unid);
            if (hit) {return hit;}
        }
        return null;
    }

    /** Find the parent that *contains* (as direct child) the node with childUnid. */
    public static findParentOf(root: JsonDataDB, childUnid: string): JsonDataDB | null {
        for (const child of root.entrys as JsonDataDB[]) {
            if (child.unid === childUnid) {return root;}
            const deeper = DbFsTreeWalker.findParentOf(child, childUnid);
            if (deeper) {return deeper;}
        }
        return null;
    }

    /** Find a table anywhere in the tree, returning its container as well. */
    public static findTable(root: JsonDataDB, unid: string): { container: JsonDataDB; table: JsonTable; } | null {
        for (const t of root.tables) {
            if (t.unid === unid) {return { container: root, table: t };}
        }
        for (const child of root.entrys as JsonDataDB[]) {
            const hit = DbFsTreeWalker.findTable(child, unid);
            if (hit) {return hit;}
        }
        return null;
    }

    public static findView(root: JsonDataDB, unid: string): { container: JsonDataDB; view: JsonView; } | null {
        for (const v of root.views) {
            if (v.unid === unid) {return { container: root, view: v };}
        }
        for (const child of root.entrys as JsonDataDB[]) {
            const hit = DbFsTreeWalker.findView(child, unid);
            if (hit) {return hit;}
        }
        return null;
    }

    public static findEnum(root: JsonDataDB, unid: string): { container: JsonDataDB; enum: JsonEnum; } | null {
        for (const e of root.enums) {
            if (e.unid === unid) {return { container: root, enum: e };}
        }
        for (const child of root.entrys as JsonDataDB[]) {
            const hit = DbFsTreeWalker.findEnum(child, unid);
            if (hit) {return hit;}
        }
        return null;
    }

    /** Yield every table in the tree (depth-first). */
    public static* allTables(root: JsonDataDB): Generator<{ container: JsonDataDB; table: JsonTable; }> {
        for (const t of root.tables) {yield { container: root, table: t };}
        for (const child of root.entrys as JsonDataDB[]) {
            yield* DbFsTreeWalker.allTables(child);
        }
    }

    public static* allEnums(root: JsonDataDB): Generator<{ container: JsonDataDB; enum: JsonEnum; }> {
        for (const e of root.enums) {yield { container: root, enum: e };}
        for (const child of root.entrys as JsonDataDB[]) {
            yield* DbFsTreeWalker.allEnums(child);
        }
    }

    public static* allViews(root: JsonDataDB): Generator<{ container: JsonDataDB; view: JsonView; }> {
        for (const v of root.views) {yield { container: root, view: v };}
        for (const child of root.entrys as JsonDataDB[]) {
            yield* DbFsTreeWalker.allViews(child);
        }
    }

    public static findDiagram(root: JsonDataDB, unid: string): { container: JsonDataDB; diagram: JsonDiagram; } | null {
        for (const l of root.diagrams ?? []) {
            if (l.unid === unid) {return { container: root, diagram: l };}
        }
        for (const child of root.entrys as JsonDataDB[]) {
            const hit = DbFsTreeWalker.findDiagram(child, unid);
            if (hit) {return hit;}
        }
        return null;
    }

    public static* allDiagrams(root: JsonDataDB): Generator<{ container: JsonDataDB; diagram: JsonDiagram; }> {
        for (const d of root.diagrams ?? []) {yield { container: root, diagram: d };}
        for (const child of root.entrys as JsonDataDB[]) {
            yield* DbFsTreeWalker.allDiagrams(child);
        }
    }

    public static findLayer(root: JsonDataDB, unid: string): { container: JsonDataDB; layer: JsonLayer; } | null {
        for (const l of root.layers ?? []) {
            if (l.unid === unid) {return { container: root, layer: l };}
        }
        for (const child of root.entrys as JsonDataDB[]) {
            const hit = DbFsTreeWalker.findLayer(child, unid);
            if (hit) {return hit;}
        }
        return null;
    }

    public static* allLayers(root: JsonDataDB): Generator<{ container: JsonDataDB; layer: JsonLayer; }> {
        for (const l of root.layers ?? []) {yield { container: root, layer: l };}
        for (const child of root.entrys as JsonDataDB[]) {
            yield* DbFsTreeWalker.allLayers(child);
        }
    }

    public static findRoutine(root: JsonDataDB, unid: string): { container: JsonDataDB; routine: JsonRoutine; } | null {
        for (const r of root.routines ?? []) {
            if (r.unid === unid) {return { container: root, routine: r };}
        }
        for (const child of root.entrys as JsonDataDB[]) {
            const hit = DbFsTreeWalker.findRoutine(child, unid);
            if (hit) {return hit;}
        }
        return null;
    }

    public static* allRoutines(root: JsonDataDB): Generator<{ container: JsonDataDB; routine: JsonRoutine; }> {
        for (const r of root.routines ?? []) {yield { container: root, routine: r };}
        for (const child of root.entrys as JsonDataDB[]) {
            yield* DbFsTreeWalker.allRoutines(child);
        }
    }

}