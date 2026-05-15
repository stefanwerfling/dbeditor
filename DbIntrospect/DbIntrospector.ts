import {DbConnection} from '../DbConnection/DbConnection.js';
import {JsonDataDB} from '../DbEditor/JsonData.js';

/**
 * Reads a live database's schema and produces a `JsonDataDB` tree shaped
 * exactly like the editor's own model. The synthetic node `unid`s are
 * derived from object names (`live:t:<table>`, `live:c:<table>:<col>`, ...)
 * — they're stable across re-introspection of the same DB but intentionally
 * not interchangeable with the model's random unids. The diff engine
 * matches model↔live by name, never by unid.
 */
export interface DbIntrospector {

    /**
     * Introspect a single database/schema. Returns a `JsonDataDB` whose
     * `type` is `database`, populated with tables, indexes, FKs, views, and
     * (for dialects that have native enums) enums.
     *
     * `schemaName` is Postgres-specific (defaults to `'public'`) and is
     * the schema *inside* the connected database. MySQL/MariaDB ignore it
     * (database = schema). SQLite ignores it.
     */
    introspect(conn: DbConnection, databaseName: string, schemaName?: string): Promise<JsonDataDB>;

}