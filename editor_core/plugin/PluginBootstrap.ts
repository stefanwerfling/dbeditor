import {createRequire} from 'module';
import * as path from 'path';
import {pathToFileURL} from 'url';
import {MysqlDriver} from '../../DbConnection/Drivers/MysqlDriver.js';
import {PostgresDriver} from '../../DbConnection/Drivers/PostgresDriver.js';
import {SqliteDriver} from '../../DbConnection/Drivers/SqliteDriver.js';
import {MariaDbDialect} from '../../DbGenerator/Dialects/MariaDbDialect.js';
import {MySqlDialect} from '../../DbGenerator/Dialects/MySqlDialect.js';
import {PostgresDialect} from '../../DbGenerator/Dialects/PostgresDialect.js';
import {SqliteDialect} from '../../DbGenerator/Dialects/SqliteDialect.js';
import {MwbFileFormatPlugin} from '../../DbMwbImport/MwbFileFormatPlugin.js';
import {Plugin} from './Plugin.js';
import {PluginRegistry} from './PluginRegistry.js';

/**
 * Module-namespace shape returned by `import()`. Plugins are free to
 * export Plugin subclasses as the default export, named exports, or
 * even ready-made instances — the loader handles all three.
 */
export type PluginModule = Record<string, unknown>;

/**
 * Injectable importer used by `loadFromConfig`. Production uses the
 * default (createRequire + dynamic import) which respects the project
 * root's node_modules layout; tests substitute a synchronous fake that
 * resolves the package without touching the filesystem.
 */
export type PluginImporter = (packageName: string, projectRoot: string) => Promise<PluginModule>;

const defaultImporter: PluginImporter = async(packageName, projectRoot) => {
    /*
     * createRequire lets us reuse Node's package resolution algorithm rooted
     * at the user's project (where the npm-installed plugin lives), not the
     * editor's own install location.
     */
    const req = createRequire(path.join(projectRoot, 'package.json'));
    const resolved = req.resolve(packageName);
    const mod = await import(pathToFileURL(resolved).href) as PluginModule;
    return mod;
};

/**
 * Wires bundled "core" plugins (the dialects + file formats that ship in
 * the dbeditor repo itself) into the global registry, and loads
 * user-activated npm-installed plugins on top.
 *
 * Two activation paths:
 *
 *   1. **Builtins** (`bootstrapBuiltins`) — always registered on dev-server
 *      boot. They live inside this repo so users get
 *      MySQL/MariaDB/Postgres/SQLite and the MySQL Workbench (`.mwb`) file
 *      format without any package install.
 *
 *   2. **npm-installed plugins** (`loadFromConfig`) — each project's
 *      `dbeditor.json` carries a `plugins: ["pkg-a", …]` list. For every
 *      entry the loader resolves `node_modules/<name>` from the project
 *      root, dynamically imports the package, and registers whatever
 *      `Plugin` subclasses (or already-instantiated `Plugin` values) its
 *      entry point exposes. Activation is opt-in: installing the package
 *      alone does nothing until it appears in the list.
 *
 * Bootstrap is idempotent — calling `bootstrapBuiltins` twice leaves the
 * registry in the same state (re-registration overwrites by id).
 *
 * Per-package errors during `loadFromConfig` are caught and logged so one
 * bad plugin can't take the editor down. Successfully loaded plugins are
 * returned for caller logging.
 */
export class PluginBootstrap {

    public static bootstrapBuiltins(): void {
        const registry = PluginRegistry.instance;
        registry.register(new MySqlDialect());
        registry.register(new MariaDbDialect());
        registry.register(new PostgresDialect());
        registry.register(new SqliteDialect());
        registry.register(new MwbFileFormatPlugin());
        registry.register(new MysqlDriver());
        registry.register(new PostgresDriver());
        registry.register(new SqliteDriver());
    }

    /**
     * @returns the list of plugin ids successfully registered. Callers
     *   typically log this so users can see which packages took effect.
     */
    public static async loadFromConfig(
        packages: readonly string[],
        projectRoot: string,
        importer: PluginImporter = defaultImporter
    ): Promise<string[]> {
        const registered: string[] = [];
        for (const pkg of packages) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const mod = await importer(pkg, projectRoot);
                const plugins = PluginBootstrap._extractPlugins(mod);
                if (plugins.length === 0) {
                    console.warn(`[dbeditor] plugin package "${pkg}" exposes no Plugin subclasses — nothing registered`);
                    continue;
                }
                for (const plugin of plugins) {
                    PluginRegistry.instance.register(plugin);
                    registered.push(plugin.id);
                }
            } catch (err) {
                console.error(`[dbeditor] failed to load plugin "${pkg}":`, err);
            }
        }
        return registered;
    }

    /**
     * Walks a module's exports and returns every Plugin it can find.
     * Accepted shapes per export:
     *   - a Plugin instance (registered as-is)
     *   - a constructor whose `prototype` chains through `Plugin` (instantiated with no args)
     * Anything else is ignored silently — many modules also export types/
     * helpers we don't care about.
     */
    private static _extractPlugins(mod: PluginModule): Plugin[] {
        const result: Plugin[] = [];
        for (const value of Object.values(mod)) {
            if (value instanceof Plugin) {
                result.push(value);
                continue;
            }
            if (typeof value === 'function' && PluginBootstrap._isPluginConstructor(value)) {
                try {
                    const instance = new (value as new () => Plugin)();
                    if (instance instanceof Plugin) {result.push(instance);}
                } catch (err) {
                    console.warn('[dbeditor] plugin constructor threw during instantiation:', err);
                }
            }
        }
        return result;
    }

    private static _isPluginConstructor(fn: (...args: unknown[]) => unknown): boolean {
        let proto: unknown = fn.prototype;
        while (proto && proto !== Object.prototype) {
            if (proto === Plugin.prototype) {return true;}
            proto = Object.getPrototypeOf(proto);
        }
        return false;
    }

}