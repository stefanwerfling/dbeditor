import {
    JsonColumn,
    JsonDataDB,
    JsonDataDBType,
    JsonEnum,
    JsonForeignKey,
    JsonRoutine,
    JsonTable,
    JsonView
} from '../../editor_schemas/JsonData.js';

/**
 * One Markdown document, ready to write to disk or paste somewhere.
 * Mirrors `GeneratedFile` from the SQL generator deliberately so the
 * preview/API path can be shared.
 */
export type GeneratedDoc = {path: string; content: string;};

/**
 * Lookup table built once per generate call so per-table sections can
 * resolve cross-table FK references in O(1). Tables are keyed by their
 * `unid` since FKs reference unids, not names.
 */
type TableIndex = Map<string, {db: JsonDataDB; table: JsonTable;}>;

export class MarkdownDocGenerator {

    private static _escapeMd(s: string | undefined): string {
        if (!s) {return '';}
        /*
         * Escape the small set of Markdown specials that would otherwise
         * break a table cell. `|` would split a cell; newlines would end
         * the row. Backticks aren't a problem inside cells. We deliberately
         * do NOT escape `*` / `_` / `#` — user-supplied table comments
         * and column descriptions often contain those and over-escaping
         * makes the docs look ugly.
         */
        return s.replace(/\|/gu, '\\|').replace(/\n/gu, ' ').replace(/\r/gu, '');
    }

    private static _anchor(s: string): string {
        /*
         * GitHub-flavoured Markdown anchor: lowercase, spaces and dots
         * become hyphens, drop everything else. Two distinct headers
         * that map to the same slug aren't disambiguated — the user
         * probably has a duplicate-table-name validator warning anyway.
         */
        return s.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
    }

    private static _collectTables(db: JsonDataDB, out: JsonTable[]): void {
        for (const t of db.tables ?? []) {out.push(t);}
        for (const child of db.entrys ?? []) {MarkdownDocGenerator._collectTables(child, out);}
    }

    private static _collectViews(db: JsonDataDB, out: JsonView[]): void {
        for (const v of db.views ?? []) {out.push(v);}
        for (const child of db.entrys ?? []) {MarkdownDocGenerator._collectViews(child, out);}
    }

    private static _collectEnums(db: JsonDataDB, out: JsonEnum[]): void {
        for (const e of db.enums ?? []) {out.push(e);}
        for (const child of db.entrys ?? []) {MarkdownDocGenerator._collectEnums(child, out);}
    }

    private static _collectRoutines(db: JsonDataDB, out: JsonRoutine[]): void {
        for (const r of db.routines ?? []) {out.push(r);}
        for (const child of db.entrys ?? []) {MarkdownDocGenerator._collectRoutines(child, out);}
    }

    private static _collectDatabases(root: JsonDataDB, out: JsonDataDB[]): void {
        if (root.type === JsonDataDBType.database) {out.push(root);}
        for (const child of root.entrys ?? []) {MarkdownDocGenerator._collectDatabases(child, out);}
    }

    private static _buildTableIndex(root: JsonDataDB): TableIndex {
        const out: TableIndex = new Map();
        const walk = (db: JsonDataDB): void => {
            for (const t of db.tables ?? []) {
                out.set(t.unid, {db: db, table: t});
            }
            for (const child of db.entrys ?? []) {walk(child);}
        };
        walk(root);
        return out;
    }

    private static _columnFlags(c: JsonColumn): string {
        const flags: string[] = [];
        if (c.primaryKey) {flags.push('PK');}
        if (c.notNull) {flags.push('NN');}
        if (c.unique) {flags.push('UQ');}
        if (c.autoIncrement) {flags.push('AI');}
        if (c.unsigned) {flags.push('UN');}
        return flags.join(', ');
    }

    private static _typeString(c: JsonColumn, enums: Map<string, JsonEnum>): string {
        if (c.type === 'enum' && c.enumRef) {
            const e = enums.get(c.enumRef);
            return e ? `enum (${e.name})` : 'enum (?)';
        }
        return c.length ? `${c.type}(${c.length})` : c.type;
    }

    private static _renderColumnsTable(table: JsonTable, enums: Map<string, JsonEnum>): string {
        if (table.columns.length === 0) {return '_(no columns)_\n';}
        const esc = MarkdownDocGenerator._escapeMd;
        const lines: string[] = [];
        lines.push('| # | Name | Type | Flags | Default | Description |');
        lines.push('|---|------|------|-------|---------|-------------|');
        let i = 1;
        for (const c of table.columns) {
            lines.push([
                String(i++),
                esc(c.name),
                esc(MarkdownDocGenerator._typeString(c, enums)),
                MarkdownDocGenerator._columnFlags(c),
                c.defaultValue ? `\`${esc(c.defaultValue)}\`` : '',
                esc(c.comment)
            ].map(s => ` ${s} `).join('|').replace(/^/u, '|').replace(/$/u, '|'));
        }
        return `${lines.join('\n')}\n`;
    }

    private static _renderIndexes(table: JsonTable): string {
        if (table.indexes.length === 0) {return '';}
        const esc = MarkdownDocGenerator._escapeMd;
        const lines: string[] = ['#### Indexes\n'];
        lines.push('| Name | Type | Columns | Where | Comment |');
        lines.push('|------|------|---------|-------|---------|');
        const colName = (unid: string): string => {
            const col = table.columns.find(c => c.unid === unid);
            return col ? col.name : '?';
        };
        for (const idx of table.indexes) {
            const cols = idx.columns.map(c => {
                const name = colName(c.columnUnid);
                return c.order ? `${name} ${c.order}` : name;
            }).join(', ');
            lines.push([
                esc(idx.name),
                esc(String(idx.type)),
                esc(cols),
                esc(idx.where),
                esc(idx.comment)
            ].map(s => ` ${s} `).join('|').replace(/^/u, '|').replace(/$/u, '|'));
        }
        return `${lines.join('\n')}\n\n`;
    }

    private static _renderForeignKeysOut(table: JsonTable, tableIndex: TableIndex): string {
        if (table.foreignKeys.length === 0) {return '';}
        const esc = MarkdownDocGenerator._escapeMd;
        const anc = MarkdownDocGenerator._anchor;
        const lines: string[] = ['#### Foreign keys (outgoing)\n'];
        lines.push('| Name | Columns | References | On delete | On update |');
        lines.push('|------|---------|------------|-----------|-----------|');
        const colName = (unid: string): string => {
            const col = table.columns.find(c => c.unid === unid);
            return col ? col.name : '?';
        };
        for (const fk of table.foreignKeys) {
            const ref = tableIndex.get(fk.refTableUnid);
            const refColName = (unid: string): string => {
                if (!ref) {return '?';}
                const col = ref.table.columns.find(c => c.unid === unid);
                return col ? col.name : '?';
            };
            const cols = fk.columns.map(c => colName(c.columnUnid)).join(', ');
            const refDisplay = ref
                ? `[${ref.table.name}](#${anc(`table-${ref.table.name}`)}) (${fk.columns.map(c => refColName(c.refColumnUnid)).join(', ')})`
                : '_(unresolved)_';
            lines.push([
                esc(fk.name),
                esc(cols),
                refDisplay,
                esc(fk.onDelete ? String(fk.onDelete) : ''),
                esc(fk.onUpdate ? String(fk.onUpdate) : '')
            ].map(s => ` ${s} `).join('|').replace(/^/u, '|').replace(/$/u, '|'));
        }
        return `${lines.join('\n')}\n\n`;
    }

    private static _renderForeignKeysIn(target: JsonTable, allTables: JsonTable[]): string {
        /*
         * Inverse FK list: every table in the same database that points
         * AT `target`. Surfaced so the doc reader can navigate the graph
         * both ways. We deliberately don't traverse cross-database FKs
         * because the doc is per-database; cross-database refs are rare
         * and the outgoing-side already lists them.
         */
        const esc = MarkdownDocGenerator._escapeMd;
        const anc = MarkdownDocGenerator._anchor;
        const refs: {fromTable: JsonTable; fk: JsonForeignKey;}[] = [];
        for (const t of allTables) {
            if (t.unid === target.unid) {continue;}
            for (const fk of t.foreignKeys) {
                if (fk.refTableUnid === target.unid) {
                    refs.push({fromTable: t, fk: fk});
                }
            }
        }
        if (refs.length === 0) {return '';}
        const lines: string[] = ['#### Referenced by\n'];
        lines.push('| From | FK name | Columns |');
        lines.push('|------|---------|---------|');
        for (const {fromTable, fk} of refs) {
            const colName = (unid: string): string => {
                const col = fromTable.columns.find(c => c.unid === unid);
                return col ? col.name : '?';
            };
            const cols = fk.columns.map(c => colName(c.columnUnid)).join(', ');
            lines.push([
                `[${fromTable.name}](#${anc(`table-${fromTable.name}`)})`,
                esc(fk.name),
                esc(cols)
            ].map(s => ` ${s} `).join('|').replace(/^/u, '|').replace(/$/u, '|'));
        }
        return `${lines.join('\n')}\n\n`;
    }

    private static _renderTable(table: JsonTable, enums: Map<string, JsonEnum>, tableIndex: TableIndex, allTables: JsonTable[]): string {
        const esc = MarkdownDocGenerator._escapeMd;
        const anc = MarkdownDocGenerator._anchor;
        const out: string[] = [];
        out.push(`### Table \`${table.name}\` <a id="${anc(`table-${table.name}`)}"></a>\n`);
        if (table.description) {out.push(`${table.description}\n`);}
        if (table.options?.comment) {out.push(`> ${esc(table.options.comment)}\n`);}
        if (table.options?.engine || table.options?.charset || table.options?.collation) {
            const opts: string[] = [];
            if (table.options.engine) {opts.push(`engine: \`${table.options.engine}\``);}
            if (table.options.charset) {opts.push(`charset: \`${table.options.charset}\``);}
            if (table.options.collation) {opts.push(`collation: \`${table.options.collation}\``);}
            out.push(`_${opts.join(' · ')}_\n`);
        }
        out.push(MarkdownDocGenerator._renderColumnsTable(table, enums));
        out.push(MarkdownDocGenerator._renderIndexes(table));
        out.push(MarkdownDocGenerator._renderForeignKeysOut(table, tableIndex));
        out.push(MarkdownDocGenerator._renderForeignKeysIn(table, allTables));
        return out.join('\n');
    }

    private static _renderEnum(e: JsonEnum): string {
        const esc = MarkdownDocGenerator._escapeMd;
        const anc = MarkdownDocGenerator._anchor;
        const out: string[] = [];
        out.push(`### Enum \`${e.name}\` <a id="${anc(`enum-${e.name}`)}"></a>\n`);
        if (e.description) {out.push(`${e.description}\n`);}
        if (e.values.length === 0) {
            out.push('_(no values)_\n');
        } else {
            out.push(`Values: ${e.values.map(v => `\`${esc(v.value)}\``).join(', ')}\n`);
        }
        return `${out.join('\n')}\n`;
    }

    private static _renderView(v: JsonView): string {
        const anc = MarkdownDocGenerator._anchor;
        const out: string[] = [];
        const mat = v.materialized ? ' (materialized)' : '';
        out.push(`### View \`${v.name}\`${mat} <a id="${anc(`view-${v.name}`)}"></a>\n`);
        if (v.description) {out.push(`${v.description}\n`);}
        out.push('```sql');
        out.push(v.select);
        out.push('```');
        return `${out.join('\n')}\n\n`;
    }

    private static _renderRoutine(r: JsonRoutine): string {
        const anc = MarkdownDocGenerator._anchor;
        const out: string[] = [];
        out.push(`### Routine \`${r.name}\` _(${r.kind})_ <a id="${anc(`routine-${r.name}`)}"></a>\n`);
        if (r.description) {out.push(`${r.description}\n`);}
        out.push('```sql');
        out.push(r.body ?? '');
        out.push('```');
        return `${out.join('\n')}\n\n`;
    }

    private static _renderDb(db: JsonDataDB): string {
        const anc = MarkdownDocGenerator._anchor;
        const tables: JsonTable[] = [];
        MarkdownDocGenerator._collectTables(db, tables);
        const views: JsonView[] = [];
        MarkdownDocGenerator._collectViews(db, views);
        const enums: JsonEnum[] = [];
        MarkdownDocGenerator._collectEnums(db, enums);
        const routines: JsonRoutine[] = [];
        MarkdownDocGenerator._collectRoutines(db, routines);

        const enumIndex = new Map(enums.map(e => [e.unid, e]));
        const tableIndex = MarkdownDocGenerator._buildTableIndex(db);

        const out: string[] = [];
        out.push(`# Database \`${db.name}\`\n`);
        out.push(`*${tables.length} table(s), ${views.length} view(s), ${enums.length} enum(s), ${routines.length} routine(s).*\n`);

        /* ---- TOC ---- */
        out.push('## Contents\n');
        if (tables.length) {
            out.push('### Tables\n');
            for (const t of tables) {out.push(`- [\`${t.name}\`](#${anc(`table-${t.name}`)})`);}
            out.push('');
        }
        if (views.length) {
            out.push('### Views\n');
            for (const v of views) {out.push(`- [\`${v.name}\`](#${anc(`view-${v.name}`)})`);}
            out.push('');
        }
        if (enums.length) {
            out.push('### Enums\n');
            for (const e of enums) {out.push(`- [\`${e.name}\`](#${anc(`enum-${e.name}`)})`);}
            out.push('');
        }
        if (routines.length) {
            out.push('### Routines\n');
            for (const r of routines) {out.push(`- [\`${r.name}\`](#${anc(`routine-${r.name}`)}) _(${r.kind})_`);}
            out.push('');
        }

        if (tables.length) {
            out.push('## Tables\n');
            for (const t of tables) {out.push(MarkdownDocGenerator._renderTable(t, enumIndex, tableIndex, tables));}
        }
        if (views.length) {
            out.push('## Views\n');
            for (const v of views) {out.push(MarkdownDocGenerator._renderView(v));}
        }
        if (enums.length) {
            out.push('## Enums\n');
            for (const e of enums) {out.push(MarkdownDocGenerator._renderEnum(e));}
        }
        if (routines.length) {
            out.push('## Routines\n');
            for (const r of routines) {out.push(MarkdownDocGenerator._renderRoutine(r));}
        }
        return out.join('\n');
    }

    /**
     * Walk the project's root tree and emit one Markdown document per
     * database. Output paths are `<dbname>.md` so the user can drop the
     * result into a docs/ folder or paste a single file into a wiki.
     *
     * Pure function — no IO, no dialect needed. The doc is just the
     * model's structural facts plus user-supplied comments/descriptions
     * rendered for human reading. Cross-database FKs surface only on
     * the outgoing side; "referenced by" listings stay within the
     * containing database for clarity.
     */
    public static generate(root: JsonDataDB): GeneratedDoc[] {
        const dbs: JsonDataDB[] = [];
        MarkdownDocGenerator._collectDatabases(root, dbs);
        return dbs.map(db => ({
            path: `${db.name}.md`,
            content: MarkdownDocGenerator._renderDb(db)
        }));
    }

}