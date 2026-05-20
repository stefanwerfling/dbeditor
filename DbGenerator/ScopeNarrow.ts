import {JsonData, JsonDataDB, JsonTable} from '../DbEditor/JsonData.js';

/**
 * Scope specifier for `ScopeNarrow.narrow`. At least one of the unids
 * must be provided. Precedence when multiple are set:
 *   tableUnids (non-empty) > tableUnid > databaseUnid
 *
 * Behaviour:
 *   databaseUnid          → keep just that database, all its tables/views/enums
 *   tableUnid             → narrow to the table's database; keep only that table,
 *                           strip its FKs (single-table SQL is self-contained)
 *   tableUnids: [a, b, …] → narrow to the common database; keep just those tables,
 *                           PRESERVE FKs whose target is in the kept set, drop the rest
 *
 * Mixed-database `tableUnids` throws — splitting a multi-DB selection
 * across separate scoped generates is the caller's job.
 */
export type ScopeSelector = {
    databaseUnid?: string;
    tableUnid?: string;
    tableUnids?: string[];
};

export class ScopeNarrow {

    /**
     * Walk `node` and its descendants depth-first; the first node whose
     * unid matches is returned together with the chain of ancestors that
     * led to it (root → … → match). Returns `null` if nothing matches.
     */
    private static _findContainerPath(root: JsonDataDB, unid: string): JsonDataDB[] | null {
        if (root.unid === unid) {return [root];}
        for (const child of root.entrys as JsonDataDB[]) {
            const path = ScopeNarrow._findContainerPath(child, unid);
            if (path) {return [root, ...path];}
        }
        return null;
    }

    /**
     * Find a table by unid anywhere in the tree, returning the chain of
     * containers leading down to (but not including) it.
     */
    private static _findTablePath(root: JsonDataDB, tableUnid: string): { path: JsonDataDB[]; table: JsonTable; } | null {
        for (const t of root.tables) {
            if (t.unid === tableUnid) {return {path: [root], table: t};}
        }
        for (const child of root.entrys as JsonDataDB[]) {
            const inner = ScopeNarrow._findTablePath(child, tableUnid);
            if (inner) {return {path: [root, ...inner.path], table: inner.table};}
        }
        return null;
    }

    /**
     * Build an empty container shell that preserves identity (unid + name
     * + type) but starts with no entrys / tables / views / enums.
     */
    private static _shell(src: JsonDataDB): JsonDataDB {
        return {
            unid: src.unid,
            name: src.name,
            type: src.type,
            istoggle: src.istoggle,
            icon: src.icon,
            entrys: [],
            tables: [],
            views: [],
            enums: []
        };
    }

    /**
     * Reconstruct a chain root → … → leaf using empty shells for every
     * ancestor and copying the leaf's tables/views/enums verbatim (or
     * filtered when `keepTableUnids` is set). FKs between kept tables
     * are preserved; FKs pointing outside the kept set are stripped.
     */
    private static _rebuildFromPath(
        data: JsonData,
        chain: JsonDataDB[],
        opts: { keepTableUnids?: Set<string>; }
    ): JsonData {
        /*
         * Build bottom-up: start from the leaf (deepest container in
         * the chain) and wrap each ancestor around it as an empty
         * shell with a single child entry.
         */
        const leafSrc = chain[chain.length - 1];
        const leaf = ScopeNarrow._shell(leafSrc);
        if (opts.keepTableUnids) {
            const kept = opts.keepTableUnids;
            leaf.tables = leafSrc.tables
            .filter(t => kept.has(t.unid))
            .map(t => ({
                ...t,
                foreignKeys: t.foreignKeys.filter(fk => kept.has(fk.refTableUnid))
            }));
            leaf.enums = leafSrc.enums;
            leaf.views = [];
        } else {
            leaf.tables = leafSrc.tables;
            leaf.views = leafSrc.views;
            leaf.enums = leafSrc.enums;
        }

        let current: JsonDataDB = leaf;
        for (let i = chain.length - 2; i >= 0; i--) {
            const ancestor = ScopeNarrow._shell(chain[i]);
            ancestor.entrys = [current];
            current = ancestor;
        }
        return {...data, fs: current};
    }

    /**
     * Return a new `JsonData` whose `fs` contains only the requested scope.
     * See `ScopeSelector` docstring for the behaviour matrix.
     */
    public static narrow(data: JsonData, scope: ScopeSelector): JsonData {
        const ids = scope.tableUnids && scope.tableUnids.length > 0 ? scope.tableUnids : null;
        if (!scope.databaseUnid && !scope.tableUnid && !ids) {
            throw new Error('ScopeNarrow.narrow: at least one of databaseUnid / tableUnid / tableUnids is required');
        }

        if (ids) {
            /*
             * Multi-table: locate each unid, assert all live in the same
             * leaf container, then rebuild that container's path with
             * only the requested tables. Mixed-database selection isn't
             * supported — it'd mean rebuilding two separate trees, which
             * the caller can do explicitly by calling narrow() per group.
             */
            const paths = ids.map(u => {
                const hit = ScopeNarrow._findTablePath(data.fs, u);
                if (!hit) {throw new Error(`ScopeNarrow.narrow: table unid ${u} not found`);}
                return {unid: u, hit: hit};
            });
            const firstLeafUnid = paths[0].hit.path[paths[0].hit.path.length - 1].unid;
            for (const p of paths) {
                const leafUnid = p.hit.path[p.hit.path.length - 1].unid;
                if (leafUnid !== firstLeafUnid) {
                    throw new Error('ScopeNarrow.narrow: tableUnids must all live in the same database');
                }
            }
            const keep = new Set(ids);
            return ScopeNarrow._rebuildFromPath(data, paths[0].hit.path, {keepTableUnids: keep});
        }

        if (scope.tableUnid) {
            const hit = ScopeNarrow._findTablePath(data.fs, scope.tableUnid);
            if (!hit) {throw new Error(`ScopeNarrow.narrow: table unid ${scope.tableUnid} not found`);}
            return ScopeNarrow._rebuildFromPath(data, hit.path, {keepTableUnids: new Set([hit.table.unid])});
        }

        const path = ScopeNarrow._findContainerPath(data.fs, scope.databaseUnid!);
        if (!path) {throw new Error(`ScopeNarrow.narrow: database unid ${scope.databaseUnid} not found`);}
        return ScopeNarrow._rebuildFromPath(data, path, {});
    }

}