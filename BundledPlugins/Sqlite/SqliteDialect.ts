import {JsonColumn, JsonEnum, JsonForeignKey, JsonIndex, JsonIndexType, JsonRoutine, JsonRoutineKind, JsonTable, JsonView} from '../../editor_schemas/JsonData.js';
import {DialectContext} from '../../editor_backend/DbGenerator/DbDialect.js';
import {DialectPlugin} from '../../editor_core/Plugin/DialectPlugin.js';

/**
 * SQLite DDL renderer. SQLite has no separate AUTO_INCREMENT for arbitrary
 * integers (only for INTEGER PRIMARY KEY), no native ENUM type (we use
 * TEXT + CHECK constraint), and FOREIGN KEY constraints are inline (no
 * ALTER TABLE ADD CONSTRAINT). The dispatcher handles inline-FK insertion
 * by passing FKs to renderCreateTable; we render them inside the body.
 */
export class SqliteDialect extends DialectPlugin {

    public readonly id: string = 'sqlite';

    public readonly displayName: string = 'SQLite';

    public quote(name: string): string {
        return `"${  name.replace(/"/gu, '""')  }"`;
    }

    public mapColumnType(col: JsonColumn, _ctx: DialectContext): string {
        const t = (col.type || '').toLowerCase();
        switch (t) {
            case 'tinyint':
            case 'smallint':
            case 'mediumint':
            case 'int':
            case 'integer':
            case 'bigint':    return 'INTEGER';
            case 'bool':
            case 'boolean':   return 'INTEGER';
            case 'decimal':
            case 'numeric':   return 'NUMERIC';
            case 'float':
            case 'double':    return 'REAL';
            case 'char':
            case 'varchar':
            case 'tinytext':
            case 'text':
            case 'mediumtext':
            case 'longtext':
            case 'json':
            case 'uuid':
            case 'enum':
            case 'date':
            case 'time':
            case 'datetime':
            case 'timestamp': return 'TEXT';
            case 'blob':
            case 'longblob':
            case 'binary':
            case 'varbinary': return 'BLOB';
            default:          return col.type.toUpperCase();
        }
    }

    protected renderColumnFlags(col: JsonColumn, ctx: DialectContext): string {
        const parts: string[] = [];
        if (col.notNull) {parts.push('NOT NULL');}
        /*
         * SQLite autoincrement only valid on INTEGER PRIMARY KEY; render as
         * PRIMARY KEY AUTOINCREMENT inline when both flags are set
         */
        if (col.primaryKey && col.autoIncrement) {parts.push('PRIMARY KEY AUTOINCREMENT');}
        if (col.defaultValue !== undefined && col.defaultValue !== '') {
            parts.push(`DEFAULT ${col.defaultValue}`);
        }
        if (col.unique && !col.primaryKey) {parts.push('UNIQUE');}
        if (col.type.toLowerCase() === 'enum' && col.enumRef) {
            const e = ctx.findEnum(col.enumRef);
            if (e && e.values.length) {
                const list = e.values.map(v => `'${v.value.replace(/'/gu, '\'\'')}'`).join(', ');
                parts.push(`CHECK (${this.quote(col.name)} IN (${list}))`);
            }
        }
        return parts.join(' ');
    }

    public renderCreateTable(table: JsonTable, ctx: DialectContext): string {
        const lines: string[] = [];
        for (const col of table.columns) {
            const type = this.mapColumnType(col, ctx);
            const flags = this.renderColumnFlags(col, ctx);
            lines.push(`${ctx.indent}${this.quote(col.name)} ${type}${flags ? ` ${  flags}` : ''}`);
        }
        // emit composite/non-autoinc PK as a table-level constraint
        const pkCols = table.columns.filter(c => c.primaryKey && !c.autoIncrement);
        if (pkCols.length) {
            lines.push(`${ctx.indent}PRIMARY KEY (${pkCols.map(c => this.quote(c.name)).join(', ')})`);
        }
        // SQLite has no ALTER TABLE ADD CONSTRAINT — emit inline FKs
        for (const fk of table.foreignKeys) {
            const inline = this._inlineForeignKey(table, fk, ctx);
            if (inline) {lines.push(`${ctx.indent}${inline}`);}
        }
        return `CREATE TABLE ${this.quote(table.name)} (\n${lines.join(',\n')}\n)`;
    }

    private _inlineForeignKey(table: JsonTable, fk: JsonForeignKey, ctx: DialectContext): string | null {
        const ref = ctx.findTable(fk.refTableUnid);
        if (!ref) {return null;}
        const localCols: string[] = [];
        const refCols: string[] = [];
        for (const fc of fk.columns) {
            const local = ctx.findColumn(table.unid, fc.columnUnid);
            const remote = ctx.findColumn(ref.unid, fc.refColumnUnid);
            if (!local || !remote) {return null;}
            localCols.push(this.quote(local.name));
            refCols.push(this.quote(remote.name));
        }
        const onDelete = fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '';
        const onUpdate = fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : '';
        return `CONSTRAINT ${this.quote(fk.name)} FOREIGN KEY (${localCols.join(', ')}) `
            + `REFERENCES ${this.quote(ref.name)} (${refCols.join(', ')})${onDelete}${onUpdate}`;
    }

    public renderCreateIndex(table: JsonTable, ix: JsonIndex, ctx: DialectContext): string | null {
        if (!ix.columns.length) {return null;}
        const cols = ix.columns.map(ic => {
            const c = ctx.findColumn(table.unid, ic.columnUnid);
            if (!c) {return '';}
            const order = ic.order && ic.order.toUpperCase() === 'DESC' ? ' DESC' : '';
            return `${this.quote(c.name)}${order}`;
        }).filter(Boolean).join(', ');
        const unique = ix.type === JsonIndexType.unique ? 'UNIQUE ' : '';
        const where = ix.where ? ` WHERE ${ix.where}` : '';
        return `CREATE ${unique}INDEX ${this.quote(ix.name)} ON ${this.quote(table.name)} (${cols})${where}`;
    }

    /** SQLite has no ALTER TABLE ADD FK — handled inline in renderCreateTable. */
    public renderAddForeignKey(_table: JsonTable, _fk: JsonForeignKey, _ctx: DialectContext): string | null {
        return null;
    }

    public renderCreateEnum(_e: JsonEnum, _ctx: DialectContext): string | null {
        return null;
    }

    public renderDropTable(table: JsonTable, _ctx: DialectContext): string {
        return `DROP TABLE IF EXISTS ${this.quote(table.name)}`;
    }

    public renderDropIndex(_table: JsonTable, ix: JsonIndex, _ctx: DialectContext): string | null {
        return `DROP INDEX IF EXISTS ${this.quote(ix.name)}`;
    }

    public renderDropEnum(_e: JsonEnum, _ctx: DialectContext): string | null {
        return null;
    }

    public renderCreateView(view: JsonView, _ctx: DialectContext): string | null {
        const body = view.select.trim();
        if (!body) {return null;}
        // SQLite doesn't support CREATE OR REPLACE — drop first, then create.
        return `DROP VIEW IF EXISTS ${this.quote(view.name)};\nCREATE VIEW ${this.quote(view.name)} AS\n${body}`;
    }

    public renderDropView(view: JsonView, _ctx: DialectContext): string | null {
        return `DROP VIEW IF EXISTS ${this.quote(view.name)}`;
    }

    /*
     * -----------------------------------------------------------------------
     * Sync-with-DB ALTER renderers
     *
     * SQLite supports `ALTER TABLE … ADD COLUMN` (always) and
     * `ALTER TABLE … DROP COLUMN` (since 3.35) natively. For column-type
     * changes — and for dropping a foreign-key constraint, since SQLite
     * has no `ALTER TABLE DROP CONSTRAINT` at all — we fall back to the
     * canonical "rebuild" pattern wrapped in PRAGMA-foreign_keys/transaction
     * brackets. The brackets keep enforcement enabled outside the rebuild
     * (so the live DB stays consistent) while letting the temp table exist
     * mid-rebuild without dangling-FK errors.
     * -----------------------------------------------------------------------
     */

    public renderAlterTableAddColumn(table: JsonTable, col: JsonColumn, ctx: DialectContext): string {
        const type = this.mapColumnType(col, ctx);
        const flags = this.renderColumnFlags(col, ctx);
        const def = `${this.quote(col.name)} ${type}${flags ? ` ${flags}` : ''}`;
        return `ALTER TABLE ${this.quote(table.name)} ADD COLUMN ${def}`;
    }

    public renderAlterTableDropColumn(table: JsonTable, col: JsonColumn, _ctx: DialectContext): string {
        return `ALTER TABLE ${this.quote(table.name)} DROP COLUMN ${this.quote(col.name)}`;
    }

    public renderAlterTableChangeColumn(table: JsonTable, oldCol: JsonColumn, newCol: JsonColumn, ctx: DialectContext): string {
        /*
         * Rebuild pattern: create a temp table with the new schema, copy
         * data from the live table (with the renamed/retyped column), drop
         * the live table, rename the temp table. The `_table` we get here
         * already reflects the model side — we use its columns as the
         * post-change definition for the new table. The `oldCol.name`
         * survives as the SELECT-from-source column.
         */
        const newColumns = table.columns.map(c => c.unid === newCol.unid || c.name === newCol.name ? newCol : c);
        const newColDefs = newColumns.map(c => {
            const type = this.mapColumnType(c, ctx);
            const flags = this.renderColumnFlags(c, ctx);
            return `${this.quote(c.name)} ${type}${flags ? ` ${flags}` : ''}`;
        });
        const pkCols = newColumns.filter(c => c.primaryKey && !c.autoIncrement);
        if (pkCols.length) {
            newColDefs.push(`PRIMARY KEY (${pkCols.map(c => this.quote(c.name)).join(', ')})`);
        }
        for (const fk of table.foreignKeys) {
            const inline = this._inlineForeignKey(table, fk, ctx);
            if (inline) {newColDefs.push(inline);}
        }
        const tempName = `${table.name}__dbed_tmp__`;
        const selectCols = newColumns.map(c => {
            /*
             * For the column being changed we read from the OLD column name
             * (which on iter-1 rules equals the new name — no renames in
             * scope). For every other column the name is identical.
             */
            const source = c.name === newCol.name ? oldCol.name : c.name;
            return this.quote(source);
        }).join(', ');
        const targetCols = newColumns.map(c => this.quote(c.name)).join(', ');

        return [
            'PRAGMA foreign_keys = OFF',
            'BEGIN TRANSACTION',
            `CREATE TABLE ${this.quote(tempName)} (\n  ${newColDefs.join(',\n  ')}\n)`,
            `INSERT INTO ${this.quote(tempName)} (${targetCols}) SELECT ${selectCols} FROM ${this.quote(table.name)}`,
            `DROP TABLE ${this.quote(table.name)}`,
            `ALTER TABLE ${this.quote(tempName)} RENAME TO ${this.quote(table.name)}`,
            'COMMIT',
            'PRAGMA foreign_keys = ON'
        ].join(';\n');
    }

    public renderDropForeignKey(table: JsonTable, fkName: string, ctx: DialectContext): string {
        /*
         * SQLite has no `ALTER TABLE … DROP CONSTRAINT`. To remove a FK we
         * rebuild the table with all FKs except the named one. The model
         * side passed in here already has the to-be-kept FK list (the diff
         * is "drop this one" — caller hands us the post-change table).
         */
        const colDefs = table.columns.map(c => {
            const type = this.mapColumnType(c, ctx);
            const flags = this.renderColumnFlags(c, ctx);
            return `${this.quote(c.name)} ${type}${flags ? ` ${flags}` : ''}`;
        });
        const pkCols = table.columns.filter(c => c.primaryKey && !c.autoIncrement);
        if (pkCols.length) {
            colDefs.push(`PRIMARY KEY (${pkCols.map(c => this.quote(c.name)).join(', ')})`);
        }
        for (const fk of table.foreignKeys) {
            if (fk.name === fkName) {continue;}
            const inline = this._inlineForeignKey(table, fk, ctx);
            if (inline) {colDefs.push(inline);}
        }
        const tempName = `${table.name}__dbed_tmp__`;
        const colNames = table.columns.map(c => this.quote(c.name)).join(', ');
        return [
            'PRAGMA foreign_keys = OFF',
            'BEGIN TRANSACTION',
            `CREATE TABLE ${this.quote(tempName)} (\n  ${colDefs.join(',\n  ')}\n)`,
            `INSERT INTO ${this.quote(tempName)} (${colNames}) SELECT ${colNames} FROM ${this.quote(table.name)}`,
            `DROP TABLE ${this.quote(table.name)}`,
            `ALTER TABLE ${this.quote(tempName)} RENAME TO ${this.quote(table.name)}`,
            'COMMIT',
            'PRAGMA foreign_keys = ON'
        ].join(';\n');
    }

    public renderAlterTableOptions(_table: JsonTable, _ctx: DialectContext): string | null {
        /*
         * SQLite has no per-table options the editor models (no engine, no
         * charset, no tablespace, no persistence). Comments aren't a thing
         * either at the table level.
         */
        return null;
    }

    public renderRenameTable(oldName: string, newName: string, _ctx: DialectContext): string | null {
        return `ALTER TABLE ${this.quote(oldName)} RENAME TO ${this.quote(newName)}`;
    }

    public renderRenameColumn(table: JsonTable, oldName: string, newCol: JsonColumn, _ctx: DialectContext): string | null {
        /* SQLite 3.25+ supports ALTER TABLE ... RENAME COLUMN. */
        return `ALTER TABLE ${this.quote(table.name)} RENAME COLUMN ${this.quote(oldName)} TO ${this.quote(newCol.name)}`;
    }

    public renderReplaceView(view: JsonView, _ctx: DialectContext): string {
        const body = view.select.trim();
        if (!body) {return `-- view ${view.name} has empty body`;}
        return `DROP VIEW IF EXISTS ${this.quote(view.name)};\nCREATE VIEW ${this.quote(view.name)} AS\n${body}`;
    }

    public renderCreateRoutine(routine: JsonRoutine, _ctx: DialectContext): string | null {
        /*
         * SQLite has no stored procedures or functions; it only supports
         * triggers (CREATE TRIGGER … FOR EACH ROW BEGIN … END). For a
         * trigger we emit the user's body verbatim. Procedures/functions
         * fall through to a documenting comment so generate output shows
         * the user there's something to manually port.
         */
        const kind = String(routine.kind || '').toLowerCase();
        const body = routine.body.trim();
        if (!body) {return null;}
        if (kind === JsonRoutineKind.trigger) {return body;}
        return `-- ${routine.name}: ${kind} not supported by SQLite — body kept in schema for reference`;
    }

    public renderDropRoutine(routine: JsonRoutine, _ctx: DialectContext): string | null {
        const kind = String(routine.kind || '').toLowerCase();
        if (kind === JsonRoutineKind.trigger) {
            return `DROP TRIGGER IF EXISTS ${this.quote(routine.name)}`;
        }
        return null;
    }

}