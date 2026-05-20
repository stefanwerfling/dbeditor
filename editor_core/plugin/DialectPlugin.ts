import {
    JsonColumn,
    JsonEnum,
    JsonForeignKey,
    JsonIndex,
    JsonRoutine,
    JsonTable,
    JsonView
} from '../../editor_frontend/DbEditor/JsonData.js';
import {DbDialect, DialectContext} from '../../editor_backend/DbGenerator/DbDialect.js';
import {Plugin} from './Plugin.js';
import {PluginKind} from './PluginKind.js';

/**
 * Abstract base for SQL dialect plugins.
 *
 * Bridges the legacy `DbDialect` interface with the plugin system: the
 * existing `DbGenerator` and `SyncGenerator` paths still consume `DbDialect`
 * shaped values, so a `DialectPlugin` *is* a `DbDialect` (structurally) plus
 * the plugin identity fields (`id`, `displayName`, `kind`).
 *
 * Subclasses migrate from `implements DbDialect` to `extends DialectPlugin`
 * one at a time — bundled MySQL is the first; the others follow when their
 * tests are touched. Until then, both shapes coexist in the registry vs.
 * legacy-factory paths handled by `DbGenerator`.
 */
export abstract class DialectPlugin extends Plugin implements DbDialect {

    public readonly kind: PluginKind = PluginKind.Dialect;

    public abstract quote(name: string): string;

    public abstract mapColumnType(col: JsonColumn, ctx: DialectContext): string;

    public abstract renderCreateTable(table: JsonTable, ctx: DialectContext): string;

    public abstract renderCreateIndex(table: JsonTable, ix: JsonIndex, ctx: DialectContext): string | null;

    public abstract renderAddForeignKey(table: JsonTable, fk: JsonForeignKey, ctx: DialectContext): string | null;

    public abstract renderCreateEnum(e: JsonEnum, ctx: DialectContext): string | null;

    public abstract renderDropTable(table: JsonTable, ctx: DialectContext): string;

    public abstract renderDropIndex(table: JsonTable, ix: JsonIndex, ctx: DialectContext): string | null;

    public abstract renderDropEnum(e: JsonEnum, ctx: DialectContext): string | null;

    public abstract renderCreateView(view: JsonView, ctx: DialectContext): string | null;

    public abstract renderDropView(view: JsonView, ctx: DialectContext): string | null;

    public abstract renderAlterTableAddColumn(table: JsonTable, col: JsonColumn, ctx: DialectContext): string;

    public abstract renderAlterTableDropColumn(table: JsonTable, col: JsonColumn, ctx: DialectContext): string;

    public abstract renderAlterTableChangeColumn(table: JsonTable, oldCol: JsonColumn, newCol: JsonColumn, ctx: DialectContext): string;

    public abstract renderDropForeignKey(table: JsonTable, fkName: string, ctx: DialectContext): string;

    public abstract renderRenameTable(oldName: string, newName: string, ctx: DialectContext): string | null;

    public abstract renderRenameColumn(table: JsonTable, oldName: string, newCol: JsonColumn, ctx: DialectContext): string | null;

    public abstract renderAlterTableOptions(table: JsonTable, ctx: DialectContext): string | null;

    public abstract renderReplaceView(view: JsonView, ctx: DialectContext): string;

    public abstract renderCreateRoutine(routine: JsonRoutine, ctx: DialectContext): string | null;

    public abstract renderDropRoutine(routine: JsonRoutine, ctx: DialectContext): string | null;

}