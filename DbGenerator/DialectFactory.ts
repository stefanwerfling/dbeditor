import {PluginBootstrap} from '../editor_core/plugin/PluginBootstrap.js';
import {PluginRegistry} from '../editor_core/plugin/PluginRegistry.js';
import {DbDialect} from './DbDialect.js';

/**
 * Resolves a dialect by name from the plugin registry.
 *
 * All four bundled dialects (`mysql`, `mariadb`, `postgres`, `sqlite`)
 * now extend `DialectPlugin` and are registered by
 * `PluginBootstrap.bootstrapBuiltins()`. Bootstrap runs at dev-server
 * boot (`vite.config.ts`) and is called lazily here too — that way
 * any non-server entry point (future CLI, test harness, etc.) gets
 * the same dialect set without needing to wire boot itself.
 */
export const pickDialect = (name: string): DbDialect => {
    const id = (name || '').toLowerCase();
    let found = PluginRegistry.instance.dialect(id);
    if (!found) {
        PluginBootstrap.bootstrapBuiltins();
        found = PluginRegistry.instance.dialect(id);
    }
    if (!found) {throw new Error(`unknown dialect: ${name}`);}
    return found;
};