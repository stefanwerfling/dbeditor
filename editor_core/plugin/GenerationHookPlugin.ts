import {DbProject} from '../../editor_backend/DbProject/DbProject.js';
import {JsonData} from '../../DbEditor/JsonData.js';
import {GeneratedFile} from '../../editor_backend/DbGenerator/DbGenerator.js';
import {Plugin} from './Plugin.js';
import {PluginKind} from './PluginKind.js';

/**
 * Abstract base for in-process generation hooks.
 *
 * Today the config supports `scripts.before_generate` / `after_generate`
 * as shell-script paths, but nothing in the codebase executes them yet.
 * This plugin kind is the in-process counterpart: hooks live as TypeScript
 * subclasses and run inside the dev-server process — no spawn, no PATH,
 * full access to the typed project + data tree.
 *
 * Reference plugins (planned): a TypeORM-class generator (writes .ts
 * entity files after each generate), a "format SQL with prettier-plugin-sql"
 * post-processor, and a `before` hook that pulls live schema for
 * sync-with-DB.
 *
 * Subclasses override only the phase they care about; the base provides
 * no-op defaults so a `before`-only hook doesn't have to stub `after`.
 */
export abstract class GenerationHookPlugin extends Plugin {

    public readonly kind: PluginKind = PluginKind.GenerationHook;

    /**
     * Called before the dialect runs. May throw to abort generation —
     * `DbGenerator` propagates the error to the caller without writing
     * any files.
     */
    public async beforeGenerate(_project: DbProject, _data: JsonData): Promise<void> {
        // no-op default
    }

    /**
     * Called after generation has written its files. `written` is the
     * exact list the generator returned; mutating it does not affect
     * the API response.
     */
    public async afterGenerate(_project: DbProject, _data: JsonData, _written: GeneratedFile[]): Promise<void> {
        // no-op default
    }

}