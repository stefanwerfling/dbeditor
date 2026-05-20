import {JsonDataDB} from '../../editor_schemas/JsonData.js';
import {Plugin} from './Plugin.js';
import {PluginKind} from './PluginKind.js';

/**
 * Result of importing a foreign file format into our `JsonDataDB` tree.
 * `stats` is opaque per-format diagnostics surfaced to the UI (e.g. MWB
 * reports counts of figures/groups/routines skipped).
 */
export type FileFormatImportResult = {
    fs: JsonDataDB;
    stats?: Record<string, unknown>;
};

/**
 * Abstract base for file-format plugins (import + export).
 *
 * The MWB reader/writer is the first concrete implementation; others on
 * the punch list include Liquibase, Prisma, and raw SQL dumps. A format
 * plugin advertises which file extensions it claims so the dispatcher
 * can pick one without UI menuing.
 *
 * Sub-classes override the capability flags (`canImport` / `canExport`)
 * for asymmetric formats — a read-only dump importer would set
 * `canExport = false` and `export()` would never be called.
 */
export abstract class FileFormatPlugin extends Plugin {

    public readonly kind: PluginKind = PluginKind.FileFormat;

    /** File extensions this plugin claims (lowercase, no leading dot). */
    public abstract readonly extensions: readonly string[];

    /** MIME type used for HTTP downloads of exported buffers. */
    public abstract readonly mimeType: string;

    public readonly canImport: boolean = true;

    public readonly canExport: boolean = true;

    /**
     * Parse a raw file buffer into our internal JsonDataDB tree.
     * Throws on unrecoverable parse errors so the API layer can return
     * 400 to the client.
     */
    public abstract import(buffer: Buffer): FileFormatImportResult;

    /**
     * Serialize a JsonDataDB tree (or array of trees) into the foreign
     * file format. Implementations that need additional options should
     * accept them via a constructor-bound config object — keep the
     * public surface uniform across formats.
     */
    public abstract export(input: JsonDataDB | JsonDataDB[]): Buffer;

}