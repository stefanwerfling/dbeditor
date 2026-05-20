import {DbConnectionPlugin} from './DbConnectionPlugin.js';
import {DialectPlugin} from './DialectPlugin.js';
import {FileFormatPlugin} from './FileFormatPlugin.js';
import {GenerationHookPlugin} from './GenerationHookPlugin.js';
import {Plugin} from './Plugin.js';
import {PluginKind} from './PluginKind.js';

/**
 * Process-wide registry for dbeditor plugins.
 *
 * The registry is the single resolution point — `DbGenerator` asks the
 * registry for a dialect by id, the API asks it for a file-format plugin
 * by extension, and the generator dispatcher asks it for the list of
 * hooks that should run for a given project.
 *
 * A single instance lives at `PluginRegistry.instance`; bundled plugins
 * register themselves via `PluginBootstrap.bootstrap()` which is invoked
 * once during dev-server startup. Third-party plugins (when the loader
 * lands) will use the same `register()` entry point.
 */
export class PluginRegistry {

    private static _instance: PluginRegistry | undefined = undefined;

    public static get instance(): PluginRegistry {
        if (!PluginRegistry._instance) {
            PluginRegistry._instance = new PluginRegistry();
        }
        return PluginRegistry._instance;
    }

    /**
     * Test-only: forget every registered plugin so a fresh `bootstrap()`
     * starts from a clean slate. Production callers never need this.
     */
    public static resetForTests(): void {
        PluginRegistry._instance = new PluginRegistry();
    }

    private readonly _byKind: Map<PluginKind, Map<string, Plugin>> = new Map();

    public register(plugin: Plugin): void {
        let bucket = this._byKind.get(plugin.kind);
        if (!bucket) {
            bucket = new Map();
            this._byKind.set(plugin.kind, bucket);
        }
        bucket.set(plugin.id, plugin);
    }

    public dialect(id: string): DialectPlugin | undefined {
        return this._lookup(PluginKind.Dialect, id) as DialectPlugin | undefined;
    }

    public fileFormat(id: string): FileFormatPlugin | undefined {
        return this._lookup(PluginKind.FileFormat, id) as FileFormatPlugin | undefined;
    }

    public fileFormatByExtension(extension: string): FileFormatPlugin | undefined {
        const ext = extension.toLowerCase().replace(/^\./u, '');
        for (const p of this._all(PluginKind.FileFormat)) {
            const fp = p as FileFormatPlugin;
            if (fp.extensions.includes(ext)) {return fp;}
        }
        return undefined;
    }

    public generationHooks(): GenerationHookPlugin[] {
        return this._all(PluginKind.GenerationHook) as GenerationHookPlugin[];
    }

    public dbConnection(id: string): DbConnectionPlugin | undefined {
        return this._lookup(PluginKind.DbConnection, id) as DbConnectionPlugin | undefined;
    }

    public dbConnectionForDialect(dialect: string): DbConnectionPlugin | undefined {
        const dlc = (dialect || '').toLowerCase();
        for (const p of this._all(PluginKind.DbConnection)) {
            const dp = p as DbConnectionPlugin;
            if (dp.supportedDialects.includes(dlc)) {return dp;}
        }
        return undefined;
    }

    private _lookup(kind: PluginKind, id: string): Plugin | undefined {
        return this._byKind.get(kind)?.get(id);
    }

    private _all(kind: PluginKind): Plugin[] {
        const bucket = this._byKind.get(kind);
        return bucket ? Array.from(bucket.values()) : [];
    }

}