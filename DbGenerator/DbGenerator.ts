import * as fs from 'fs';
import * as path from 'path';
import {DbProject} from '../DbProject/DbProject.js';
import {ConfigOutputMode} from '../Config/Config.js';
import {JsonData, JsonDataDB, JsonTable, JsonEnum, JsonColumn} from '../DbEditor/JsonData.js';
import {DbDialect, DialectContext} from './DbDialect.js';
import {pickDialect} from './DialectFactory.js';
import {DbFsTreeWalker} from '../DbRepository/DbFsTreeWalker.js';
import {PluginRegistry} from '../editor_core/plugin/PluginRegistry.js';

const safeFilename = (name: string): string => name.replace(/[^a-zA-Z0-9_-]+/gu, '_');

const clearDir = (dir: string): void => {
    if (!fs.existsSync(dir)) {return;}
    for (const entry of fs.readdirSync(dir)) {
        const p = path.join(dir, entry);
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
            clearDir(p);
            fs.rmdirSync(p);
        } else {
            fs.unlinkSync(p);
        }
    }
};

const ensureDir = (dir: string): void => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {recursive: true});
    }
};

export type GeneratedFile = { path: string; content: string; };

export type GenerateOptions = {
    /**
     * If true: skip all filesystem writes (no mkdir, no writeFileSync,
     * no clearDir) but still populate the returned `GeneratedFile[]`.
     * Used by the "scoped generate" preview flow — the user wants to SEE
     * the SQL for one database/table without polluting the output dir
     * with a partial regenerate.
     */
    dryRun?: boolean;
};

/**
 * SQL DDL generator. Output layout depends on `project.output.mode`:
 *
 *   ddl-files:  one file per table at `<dest>/<database>/<table>.sql`,
 *               plus an `enums.sql` per database (postgres only),
 *               plus `<dest>/_foreign_keys.sql` collecting cross-table FKs
 *               last (so loading them in alphabetical order doesn't fail).
 *
 *   migrations: one timestamped pair `<ts>__init.up.sql` /
 *               `<ts>__init.down.sql` containing every DDL statement in
 *               dependency order (enums → tables → indexes → fks for up;
 *               reverse for down). Subsequent regenerations append a new
 *               pair if existing migrations are present, otherwise overwrite
 *               the init pair. (The current minimal scaffold always writes
 *               the init pair; a proper diff-based migration emitter is a
 *               later iteration.)
 *
 * `generate()` returns the list of files it wrote in the order they were
 * written; callers (e.g. the SQL-preview dialog) use it to surface output
 * to the user without re-reading from disk.
 */
export class DbGenerator {

    private _dryRun = false;

    public async generate(project: DbProject, data: JsonData, options: GenerateOptions = {}): Promise<GeneratedFile[]> {
        this._dryRun = options.dryRun === true;
        try {
            const dialect = pickDialect(project.dialect);
            const ctx = this._buildContext(project, data);

            /*
             * Hooks are skipped in dry-run: a preview should never trigger
             * external side effects (e.g. a hook that pulls live schema,
             * writes typed entity files, or formats prior output).
             */
            const hooks = this._dryRun ? [] : PluginRegistry.instance.generationHooks();
            for (const h of hooks) {
                // sequential by design — earlier hooks may set up state that later ones depend on
                // eslint-disable-next-line no-await-in-loop
                await h.beforeGenerate(project, data);
            }

            const dest = project.output.destinationPath;
            if (project.output.destinationClear && !this._dryRun) {clearDir(dest);}
            if (!this._dryRun) {ensureDir(dest);}

            const written: GeneratedFile[] = [];
            if (project.output.mode === ConfigOutputMode.migrations) {
                await this._writeMigrations(project, data, dialect, ctx, written);
            } else {
                await this._writeDdlFiles(project, data, dialect, ctx, written);
            }

            for (const h of hooks) {
                // sequential by design — afterGenerate may chain (e.g. format then commit)
                // eslint-disable-next-line no-await-in-loop
                await h.afterGenerate(project, data, written);
            }

            return written;
        } finally {
            this._dryRun = false;
        }
    }

    /*
     * Single sink for everything we write — keeps the on-disk write and
     * the in-memory record in lockstep so the API response and the file
     * tree can never disagree. In dry-run we skip the actual writeFileSync
     * but still record the file in `written` so the preview dialog has
     * something to show.
     */
    private _writeFile(written: GeneratedFile[], filePath: string, content: string): void {
        if (!this._dryRun) {fs.writeFileSync(filePath, content);}
        written.push({ path: filePath, content: content });
    }

    private _buildContext(project: DbProject, data: JsonData): DialectContext {
        const tablesByUnid = new Map<string, JsonTable>();
        const enumsByUnid = new Map<string, JsonEnum>();
        for (const { table } of DbFsTreeWalker.allTables(data.fs)) {tablesByUnid.set(table.unid, table);}
        for (const { enum: e } of DbFsTreeWalker.allEnums(data.fs)) {enumsByUnid.set(e.unid, e);}

        const columnsByTable = new Map<string, Map<string, JsonColumn>>();
        for (const { table } of DbFsTreeWalker.allTables(data.fs)) {
            const m = new Map<string, JsonColumn>();
            for (const c of table.columns) {m.set(c.unid, c);}
            columnsByTable.set(table.unid, m);
        }

        return {
            indent: project.output.sqlIndent,
            terminator: project.output.statementTerminator,
            comments: project.output.sqlComment,
            findTable: (unid) => tablesByUnid.get(unid),
            findEnum: (unid) => enumsByUnid.get(unid),
            findColumn: (tableUnid, columnUnid) => columnsByTable.get(tableUnid)?.get(columnUnid)
        };
    }

    private async _writeDdlFiles(project: DbProject, data: JsonData, dialect: DbDialect, ctx: DialectContext, written: GeneratedFile[]): Promise<void> {
        const dest = project.output.destinationPath;
        const term = ctx.terminator;
        const fkBuckets: { db: string; sql: string; }[] = [];

        for (const dbNode of (data.fs.entrys as JsonDataDB[])) {
            if (dbNode.type !== 'database') {continue;}
            const dbDir = path.join(dest, safeFilename(dbNode.name));
            if (!this._dryRun) {ensureDir(dbDir);}

            const enumStmts: string[] = [];
            for (const { enum: e } of DbFsTreeWalker.allEnums(dbNode)) {
                const stmt = dialect.renderCreateEnum(e, ctx);
                if (stmt) {enumStmts.push(stmt + term);}
            }
            if (enumStmts.length) {
                this._writeFile(written, path.join(dbDir, '_enums.sql'),
                    `${this._fileHeader(project, `enums for ${dbNode.name}`) + enumStmts.join('\n\n')}\n`);
            }

            for (const { table } of DbFsTreeWalker.allTables(dbNode)) {
                const create = dialect.renderCreateTable(table, ctx) + term;
                const indexes = table.indexes.map(ix => dialect.renderCreateIndex(table, ix, ctx)).filter(Boolean).map(s => s + term);
                const body = [create, ...indexes].join('\n\n');
                this._writeFile(written,
                    path.join(dbDir, `${safeFilename(table.name)}.sql`),
                    `${this._fileHeader(project, `table ${dbNode.name}.${table.name}`) + body}\n`);
            }

            for (const { view } of DbFsTreeWalker.allViews(dbNode)) {
                const stmt = dialect.renderCreateView(view, ctx);
                if (!stmt) {continue;}
                this._writeFile(written,
                    path.join(dbDir, `${safeFilename(view.name)}.view.sql`),
                    `${this._fileHeader(project, `view ${dbNode.name}.${view.name}`)}${stmt}${term}\n`);
            }

            /*
             * One file per routine. We use kind in the filename to keep
             * procedures, functions, and triggers visually grouped in
             * directory listings.
             */
            for (const { routine } of DbFsTreeWalker.allRoutines(dbNode)) {
                const stmt = dialect.renderCreateRoutine(routine, ctx);
                if (!stmt) {continue;}
                const kindTag = String(routine.kind || 'routine').toLowerCase();
                this._writeFile(written,
                    path.join(dbDir, `${safeFilename(routine.name)}.${kindTag}.sql`),
                    `${this._fileHeader(project, `${kindTag} ${dbNode.name}.${routine.name}`)}${stmt}\n`);
            }

            const fkStmts: string[] = [];
            for (const { table } of DbFsTreeWalker.allTables(dbNode)) {
                for (const fk of table.foreignKeys) {
                    const stmt = dialect.renderAddForeignKey(table, fk, ctx);
                    if (stmt) {fkStmts.push(stmt + term);}
                }
            }
            if (fkStmts.length) {fkBuckets.push({ db: dbNode.name, sql: fkStmts.join('\n\n') });}
        }

        if (fkBuckets.length) {
            const all = fkBuckets.map(b => `-- ${b.db}\n${b.sql}`).join('\n\n');
            this._writeFile(written, path.join(dest, '_foreign_keys.sql'),
                `${this._fileHeader(project, 'foreign keys') + all}\n`);
        }
    }

    private async _writeMigrations(project: DbProject, data: JsonData, dialect: DbDialect, ctx: DialectContext, written: GeneratedFile[]): Promise<void> {
        const dest = project.output.destinationPath;
        const term = ctx.terminator;
        const ts = new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14);
        const pattern = project.output.migrationFilenamePattern || '{timestamp}__{name}';
        const baseName = pattern.replace('{timestamp}', ts).replace('{name}', 'init');
        const upFile = path.join(dest, `${baseName}.up.sql`);
        const downFile = path.join(dest, `${baseName}.down.sql`);

        const up: string[] = [];
        const down: string[] = [];

        // up: enums -> tables -> indexes -> fks
        for (const { enum: e } of DbFsTreeWalker.allEnums(data.fs)) {
            const s = dialect.renderCreateEnum(e, ctx);
            if (s) {up.push(s + term);}
        }
        for (const { table } of DbFsTreeWalker.allTables(data.fs)) {
            up.push(dialect.renderCreateTable(table, ctx) + term);
        }
        for (const { table } of DbFsTreeWalker.allTables(data.fs)) {
            for (const ix of table.indexes) {
                const s = dialect.renderCreateIndex(table, ix, ctx);
                if (s) {up.push(s + term);}
            }
        }
        for (const { table } of DbFsTreeWalker.allTables(data.fs)) {
            for (const fk of table.foreignKeys) {
                const s = dialect.renderAddForeignKey(table, fk, ctx);
                if (s) {up.push(s + term);}
            }
        }
        // views before routines so a routine body referencing a view resolves
        for (const { view } of DbFsTreeWalker.allViews(data.fs)) {
            const s = dialect.renderCreateView(view, ctx);
            if (s) {up.push(s + term);}
        }
        for (const { routine } of DbFsTreeWalker.allRoutines(data.fs)) {
            const s = dialect.renderCreateRoutine(routine, ctx);
            if (s) {up.push(s);}
        }

        // down: reverse — drop routines first, then views, then fks/indexes/tables/enums
        for (const { routine } of DbFsTreeWalker.allRoutines(data.fs)) {
            const s = dialect.renderDropRoutine(routine, ctx);
            if (s) {down.push(s + term);}
        }
        for (const { view } of DbFsTreeWalker.allViews(data.fs)) {
            const s = dialect.renderDropView(view, ctx);
            if (s) {down.push(s + term);}
        }
        for (const { table } of DbFsTreeWalker.allTables(data.fs)) {
            for (const fk of table.foreignKeys) {
                down.push(`ALTER TABLE ${dialect.quote(table.name)} DROP CONSTRAINT ${dialect.quote(fk.name)}${term}`);
            }
        }
        for (const { table } of DbFsTreeWalker.allTables(data.fs)) {
            for (const ix of table.indexes) {
                const s = dialect.renderDropIndex(table, ix, ctx);
                if (s) {down.push(s + term);}
            }
        }
        for (const { table } of DbFsTreeWalker.allTables(data.fs)) {
            down.push(dialect.renderDropTable(table, ctx) + term);
        }
        for (const { enum: e } of DbFsTreeWalker.allEnums(data.fs)) {
            const s = dialect.renderDropEnum(e, ctx);
            if (s) {down.push(s + term);}
        }

        this._writeFile(written, upFile, `${this._fileHeader(project, `migration up — ${baseName}`) + up.join('\n\n')}\n`);
        this._writeFile(written, downFile, `${this._fileHeader(project, `migration down — ${baseName}`) + down.join('\n\n')}\n`);
    }

    private _fileHeader(project: DbProject, subject: string): string {
        if (!project.output.sqlComment) {return '';}
        return `-- generated by dbeditor — ${subject}\n-- dialect: ${project.dialect}\n\n`;
    }

}