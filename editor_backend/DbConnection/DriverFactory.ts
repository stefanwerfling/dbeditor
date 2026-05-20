import {DbConnectionPlugin} from '../../editor_core/Plugin/DbConnectionPlugin.js';
import {PluginBootstrap} from '../../editor_core/Plugin/PluginBootstrap.js';
import {PluginRegistry} from '../../editor_core/Plugin/PluginRegistry.js';

/**
 * Resolves a live-DB driver by dialect from the plugin registry.
 *
 * The three bundled `DbConnectionPlugin`s (`mysql` covers both `mysql`
 * and `mariadb`; `postgres`; `sqlite`) are registered by
 * `PluginBootstrap.bootstrapBuiltins()`. Bootstrap runs at dev-server
 * boot (`vite.config.ts`) and is called lazily here too — that way any
 * non-server entry point (future CLI, test harness, etc.) gets the
 * same driver set without needing to wire boot itself.
 */
export const pickDriver = (dialect: string): DbConnectionPlugin => {
    let found = PluginRegistry.instance.dbConnectionForDialect(dialect);
    if (!found) {
        PluginBootstrap.bootstrapBuiltins();
        found = PluginRegistry.instance.dbConnectionForDialect(dialect);
    }
    if (!found) {throw new Error(`unknown dialect: ${dialect}`);}
    return found;
};