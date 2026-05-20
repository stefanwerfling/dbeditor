import {JsonDataDB, JsonDataDBType} from '../../editor_schemas/JsonData.js';
import {FileFormatImportResult, FileFormatPlugin} from '../../editor_core/Plugin/FileFormatPlugin.js';
import {MwbImportResult, MwbReader} from './MwbReader.js';
import {MwbWriter} from './MwbWriter.js';

/**
 * Options accepted by `writeFull`. Mirrors the internal `WriteMwbOptions`
 * but is re-exported here so callers don't need to import from the
 * private writer module. The three cache maps hold per-object original
 * XML captured at import time; the writer re-emits cached bytes verbatim
 * (with owner-link rewriting) when the source object hasn't been edited.
 */
export type MwbWriteOptions = {
    routineXmlByUnid?: Map<string, string>;
    viewXmlByUnid?: Map<string, string>;
    tableCacheByUnid?: Map<string, {xml: string; grtId: string; columnGrtIds: string[];}>;
};

/**
 * MySQL Workbench `.mwb` file-format plugin.
 *
 * Delegates to `MwbReader.parse` / `MwbWriter.write` for the heavy
 * lifting. What this class establishes:
 *
 *   1. MWB is registered with the plugin system, so the registry can
 *      answer "which file formats are supported?" (future generic file-
 *      upload dispatch, MCP server tool listings).
 *   2. API routes and any future caller go through `PluginRegistry`
 *      → no more direct imports of the reader / writer from consumer
 *      code.
 *
 * The base `import()` / `export()` methods satisfy the bare
 * `FileFormatPlugin` contract for generic dispatch; rich consumers
 * (today only the two `DbApiRoutes` handlers) call `parseFull` /
 * `writeFull` for the full result and write-options surface.
 */
export class MwbFileFormatPlugin extends FileFormatPlugin {

    public readonly id: string = 'mwb';

    public readonly displayName: string = 'MySQL Workbench';

    public readonly extensions: readonly string[] = ['mwb'];

    public readonly mimeType: string = 'application/octet-stream';

    /**
     * Generic-dispatch import. Returns one `JsonDataDB` root wrapping
     * every imported schema as a top-level child — matches the shape
     * the rest of the editor expects as its on-disk schema root.
     * Rich stats (counts + cache maps) are dropped at this layer;
     * callers that need them use `parseFull` instead.
     */
    public import(buffer: Buffer): FileFormatImportResult {
        const result = MwbReader.parse(buffer);
        return {
            fs: this._rootOf(result.databases),
            stats: {
                schemaCount: result.schemaCount,
                tableCount: result.tableCount,
                columnCount: result.columnCount,
                viewCount: result.viewCount,
                routineCount: result.routineCount
            }
        };
    }

    /**
     * Generic-dispatch export. Accepts a single root tree or an array of
     * databases; no cache passthrough (re-emits everything from the
     * model). Callers that need per-object roundtrip caches use
     * `writeFull` with the relevant `MwbWriteOptions`.
     */
    public export(input: JsonDataDB | JsonDataDB[]): Buffer {
        return MwbWriter.write(input);
    }

    /**
     * Full-fidelity import — preserves stats and per-object original-XML
     * caches so subsequent exports can round-trip the file losslessly.
     */
    public parseFull(buffer: Buffer): MwbImportResult {
        return MwbReader.parse(buffer);
    }

    /**
     * Full-fidelity export — `opts` carries the per-object XML caches
     * captured at import time. Untouched objects are re-emitted verbatim.
     */
    public writeFull(input: JsonDataDB | JsonDataDB[], opts: MwbWriteOptions = {}): Buffer {
        return MwbWriter.write(input, opts);
    }

    private _rootOf(databases: JsonDataDB[]): JsonDataDB {
        return {
            unid: 'root',
            name: 'root',
            type: JsonDataDBType.root,
            entrys: databases,
            tables: [],
            views: [],
            enums: [],
            routines: []
        } as unknown as JsonDataDB;
    }

}