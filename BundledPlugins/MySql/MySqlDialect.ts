import {JsonColumn, JsonEnum, JsonForeignKey, JsonIndex, JsonIndexType, JsonRoutine, JsonRoutineKind, JsonTable, JsonView} from '../../editor_frontend/DbEditor/JsonData.js';
import {DialectContext} from '../../editor_backend/DbGenerator/DbDialect.js';
import {DialectPlugin} from '../../editor_core/plugin/DialectPlugin.js';

/**
 * MySQL DDL renderer. Identifiers are backtick-quoted, ENUMs are inlined
 * into the column type, AUTO_INCREMENT is rendered for auto-increment
 * columns, and table-level ENGINE / CHARSET / COLLATE / COMMENT options
 * are emitted from `JsonTable.options`.
 *
 * First bundled dialect to migrate from the legacy `implements DbDialect`
 * shape to the plugin base — the other three follow when next touched.
 */
export class MySqlDialect extends DialectPlugin {

    public readonly id: string = 'mysql';

    public readonly displayName: string = 'MySQL';

    public quote(name: string): string {
        return `\`${  name.replace(/`/gu, '``')  }\``;
    }

    public mapColumnType(col: JsonColumn, ctx: DialectContext): string {
        const t = (col.type || '').toLowerCase();
        const len = col.length ? `(${col.length})` : '';
        switch (t) {
            case 'tinyint':   return `TINYINT${len}`;
            case 'smallint':  return `SMALLINT${len}`;
            case 'mediumint': return `MEDIUMINT${len}`;
            case 'int':
            case 'integer':   return `INT${len}`;
            case 'bigint':    return `BIGINT${len}`;
            case 'bool':
            case 'boolean':   return 'TINYINT(1)';
            case 'decimal':
            case 'numeric':   return `DECIMAL${len || '(10,0)'}`;
            case 'float':     return `FLOAT${len}`;
            case 'double':    return `DOUBLE${len}`;
            case 'char':      return `CHAR${len || '(1)'}`;
            case 'varchar':   return `VARCHAR${len || '(255)'}`;
            case 'tinytext':  return 'TINYTEXT';
            case 'text':      return 'TEXT';
            case 'mediumtext':return 'MEDIUMTEXT';
            case 'longtext':  return 'LONGTEXT';
            case 'blob':      return 'BLOB';
            case 'longblob':  return 'LONGBLOB';
            case 'binary':    return `BINARY${len}`;
            case 'varbinary': return `VARBINARY${len || '(255)'}`;
            case 'json':      return 'JSON';
            case 'uuid':      return 'CHAR(36)';
            case 'date':      return 'DATE';
            case 'time':      return `TIME${len}`;
            case 'datetime':  return `DATETIME${len}`;
            case 'timestamp': return `TIMESTAMP${len}`;
            case 'year':      return 'YEAR';
            case 'enum': {
                if (!col.enumRef) {return 'VARCHAR(64)';}
                const e = ctx.findEnum(col.enumRef);
                if (!e || !e.values.length) {return 'VARCHAR(64)';}
                return `ENUM(${e.values.map(v => `'${v.value.replace(/'/gu, '\'\'')}'`).join(', ')})`;
            }
            default:
                // unknown logical type — pass through verbatim for raw SQL types
                return col.length ? `${col.type.toUpperCase()}(${col.length})` : col.type.toUpperCase();
        }
    }

    protected renderColumnFlags(col: JsonColumn): string {
        const parts: string[] = [];
        if (col.unsigned) {parts.push('UNSIGNED');}
        if (col.notNull) {parts.push('NOT NULL');} else {parts.push('NULL');}
        if (col.autoIncrement) {parts.push('AUTO_INCREMENT');}
        if (col.defaultValue !== undefined && col.defaultValue !== '') {
            parts.push(`DEFAULT ${col.defaultValue}`);
        }
        if (col.unique && !col.primaryKey) {parts.push('UNIQUE');}
        if (col.comment) {parts.push(`COMMENT '${col.comment.replace(/'/gu, '\'\'')}'`);}
        return parts.join(' ');
    }

    public renderCreateTable(table: JsonTable, ctx: DialectContext): string {
        const lines: string[] = [];
        for (const col of table.columns) {
            const type = this.mapColumnType(col, ctx);
            const flags = this.renderColumnFlags(col);
            lines.push(`${ctx.indent}${this.quote(col.name)} ${type}${flags ? ` ${  flags}` : ''}`);
        }
        const pkCols = table.columns.filter(c => c.primaryKey);
        if (pkCols.length) {
            lines.push(`${ctx.indent}PRIMARY KEY (${pkCols.map(c => this.quote(c.name)).join(', ')})`);
        }

        const opts: string[] = [];
        const o = table.options || {};
        if (o.engine) {opts.push(`ENGINE=${o.engine}`);}
        if (o.charset) {opts.push(`DEFAULT CHARSET=${o.charset}`);}
        if (o.collation) {opts.push(`COLLATE=${o.collation}`);}
        if (o.comment) {opts.push(`COMMENT='${o.comment.replace(/'/gu, '\'\'')}'`);}

        const head = `CREATE TABLE ${this.quote(table.name)} (\n`;
        const body = lines.join(',\n');
        const tail = `\n)${opts.length ? ` ${  opts.join(' ')}` : ''}`;
        return head + body + tail;
    }

    public renderCreateIndex(table: JsonTable, ix: JsonIndex, ctx: DialectContext): string | null {
        if (!ix.columns.length) {return null;}
        const cols = ix.columns.map(ic => {
            const c = ctx.findColumn(table.unid, ic.columnUnid);
            if (!c) {return '';}
            const len = ic.length ? `(${ic.length})` : '';
            const order = ic.order && ic.order.toUpperCase() === 'DESC' ? ' DESC' : '';
            return `${this.quote(c.name)}${len}${order}`;
        }).filter(Boolean).join(', ');
        const t = (ix.type || JsonIndexType.index).toLowerCase();
        switch (t) {
            case JsonIndexType.unique:
                return `CREATE UNIQUE INDEX ${this.quote(ix.name)} ON ${this.quote(table.name)} (${cols})`;
            case JsonIndexType.fulltext:
                return `ALTER TABLE ${this.quote(table.name)} ADD FULLTEXT INDEX ${this.quote(ix.name)} (${cols})`;
            case JsonIndexType.spatial:
                return `ALTER TABLE ${this.quote(table.name)} ADD SPATIAL INDEX ${this.quote(ix.name)} (${cols})`;
            default:
                return `CREATE INDEX ${this.quote(ix.name)} ON ${this.quote(table.name)} (${cols})`;
        }
    }

    public renderAddForeignKey(table: JsonTable, fk: JsonForeignKey, ctx: DialectContext): string | null {
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
        return `ALTER TABLE ${this.quote(table.name)} `
            + `ADD CONSTRAINT ${this.quote(fk.name)} `
            + `FOREIGN KEY (${localCols.join(', ')}) `
            + `REFERENCES ${this.quote(ref.name)} (${refCols.join(', ')})${onDelete}${onUpdate}`;
    }

    /** MySQL inlines enum values in column types, so no separate CREATE TYPE. */
    public renderCreateEnum(_e: JsonEnum, _ctx: DialectContext): string | null {
        return null;
    }

    public renderDropTable(table: JsonTable, _ctx: DialectContext): string {
        return `DROP TABLE IF EXISTS ${this.quote(table.name)}`;
    }

    public renderDropIndex(table: JsonTable, ix: JsonIndex, _ctx: DialectContext): string | null {
        return `DROP INDEX ${this.quote(ix.name)} ON ${this.quote(table.name)}`;
    }

    public renderDropEnum(_e: JsonEnum, _ctx: DialectContext): string | null {
        return null;
    }

    public renderCreateView(view: JsonView, _ctx: DialectContext): string | null {
        const body = view.select.trim();
        if (!body) {return null;}
        // MySQL has no MATERIALIZED VIEW — flag is silently ignored.
        return `CREATE OR REPLACE VIEW ${this.quote(view.name)} AS\n${body}`;
    }

    public renderDropView(view: JsonView, _ctx: DialectContext): string | null {
        return `DROP VIEW IF EXISTS ${this.quote(view.name)}`;
    }

    /*
     * -----------------------------------------------------------------------
     * Sync-with-DB ALTER renderers
     * -----------------------------------------------------------------------
     */

    private _renderColumnDefinition(col: JsonColumn, ctx: DialectContext): string {
        const type = this.mapColumnType(col, ctx);
        const flags = this.renderColumnFlags(col);
        return `${this.quote(col.name)} ${type}${flags ? ` ${flags}` : ''}`;
    }

    public renderAlterTableAddColumn(table: JsonTable, col: JsonColumn, ctx: DialectContext): string {
        return `ALTER TABLE ${this.quote(table.name)} ADD COLUMN ${this._renderColumnDefinition(col, ctx)}`;
    }

    public renderAlterTableDropColumn(table: JsonTable, col: JsonColumn, _ctx: DialectContext): string {
        return `ALTER TABLE ${this.quote(table.name)} DROP COLUMN ${this.quote(col.name)}`;
    }

    public renderAlterTableChangeColumn(table: JsonTable, _oldCol: JsonColumn, newCol: JsonColumn, ctx: DialectContext): string {
        /*
         * MODIFY keeps the same name; CHANGE renames. v1 never renames, so
         * MODIFY is the right call. The old column is in the signature for
         * future rename support.
         */
        return `ALTER TABLE ${this.quote(table.name)} MODIFY COLUMN ${this._renderColumnDefinition(newCol, ctx)}`;
    }

    public renderDropForeignKey(table: JsonTable, fkName: string, _ctx: DialectContext): string {
        return `ALTER TABLE ${this.quote(table.name)} DROP FOREIGN KEY ${this.quote(fkName)}`;
    }

    public renderAlterTableOptions(table: JsonTable, _ctx: DialectContext): string | null {
        const o = table.options || {};
        const parts: string[] = [];
        if (o.engine) {parts.push(`ENGINE=${o.engine}`);}
        if (o.charset) {parts.push(`DEFAULT CHARSET=${o.charset}`);}
        if (o.collation) {parts.push(`COLLATE=${o.collation}`);}
        if (o.comment) {parts.push(`COMMENT='${o.comment.replace(/'/gu, '\'\'')}'`);}
        if (!parts.length) {return null;}
        return `ALTER TABLE ${this.quote(table.name)} ${parts.join(', ')}`;
    }

    public renderRenameTable(oldName: string, newName: string, _ctx: DialectContext): string | null {
        /*
         * MySQL's portable rename uses the multi-rename form so the
         * statement is consistent with renaming many tables at once
         * (used by sync). `RENAME TABLE` is atomic and respects FK
         * constraints; `ALTER TABLE … RENAME TO …` is the older form.
         */
        return `RENAME TABLE ${this.quote(oldName)} TO ${this.quote(newName)}`;
    }

    public renderRenameColumn(table: JsonTable, oldName: string, newCol: JsonColumn, _ctx: DialectContext): string | null {
        /*
         * MySQL 8.0+ supports bare `ALTER TABLE … RENAME COLUMN`.
         * Earlier versions need `CHANGE COLUMN old new <type>` —
         * we target 8+ here, which matches the rest of the dialect
         * (e.g. `ALGORITHM=INSTANT` defaults). If sync against an
         * older server is needed, swap to the `CHANGE COLUMN` form
         * and re-include the column type.
         */
        return `ALTER TABLE ${this.quote(table.name)} RENAME COLUMN ${this.quote(oldName)} TO ${this.quote(newCol.name)}`;
    }

    public renderReplaceView(view: JsonView, ctx: DialectContext): string {
        const stmt = this.renderCreateView(view, ctx);
        /*
         * renderCreateView already emits `CREATE OR REPLACE VIEW` for MySQL,
         * so the replace path is identical. Returning a non-null string is
         * required by the interface — fall back to a no-op only if the view
         * body itself is unrenderable.
         */
        return stmt ?? `-- view ${view.name} has empty body`;
    }

    public renderCreateRoutine(routine: JsonRoutine, _ctx: DialectContext): string | null {
        const body = routine.body.trim();
        if (!body) {return null;}
        /*
         * MySQL needs DELIMITER swap so the semicolons inside the body
         * don't terminate the outer statement. We emit non-default
         * DELIMITER guards on every routine — the user pastes raw SQL
         * that may contain any combination of statements.
         */
        return `DELIMITER $$\n${body}$$\nDELIMITER ;`;
    }

    public renderDropRoutine(routine: JsonRoutine, _ctx: DialectContext): string | null {
        const kind = String(routine.kind || '').toLowerCase();
        switch (kind) {
            case JsonRoutineKind.procedure: return `DROP PROCEDURE IF EXISTS ${this.quote(routine.name)}`;
            case JsonRoutineKind.function:  return `DROP FUNCTION IF EXISTS ${this.quote(routine.name)}`;
            case JsonRoutineKind.trigger:   return `DROP TRIGGER IF EXISTS ${this.quote(routine.name)}`;
            default: return `DROP PROCEDURE IF EXISTS ${this.quote(routine.name)}`;
        }
    }

}