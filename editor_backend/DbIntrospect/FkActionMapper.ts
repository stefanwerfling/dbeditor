import {JsonForeignKeyAction} from '../../editor_schemas/JsonData.js';

/**
 * Maps an SQL-side FK action string (as returned by information_schema /
 * `pragma foreign_key_list` / Postgres' `confdeltype` decoded) onto the
 * editor's `JsonForeignKeyAction` enum. Identical across MySQL / Postgres /
 * SQLite — they all report the canonical SQL action names — so this lives
 * in one place to prevent drift.
 *
 * Returns `undefined` for empty/null input (the introspectors leave the
 * field unset on the model side in that case). Unrecognised values fall
 * through as the uppercase raw string so future SQL extensions don't get
 * silently lost.
 */
export class FkActionMapper {

    public static fromSql(raw: string | null | undefined): string | undefined {
        if (!raw) {return undefined;}
        const v = String(raw).toUpperCase();
        switch (v) {
            case 'NO ACTION':   return JsonForeignKeyAction.no_action;
            case 'RESTRICT':    return JsonForeignKeyAction.restrict;
            case 'CASCADE':     return JsonForeignKeyAction.cascade;
            case 'SET NULL':    return JsonForeignKeyAction.set_null;
            case 'SET DEFAULT': return JsonForeignKeyAction.set_default;
            default:            return v;
        }
    }

}