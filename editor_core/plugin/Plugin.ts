import {PluginKind} from './PluginKind.js';

/**
 * Common base for every dbeditor plugin. Subclasses (DialectPlugin,
 * FileFormatPlugin, GenerationHookPlugin) add kind-specific abstract
 * methods; the registry only knows about this shape.
 *
 * The base is intentionally a class (not a bare interface) because the
 * project convention is inheritance-first: a plugin always extends one of
 * the kind-specific abstract classes, never just implements a structural
 * type. That gives third-party plugins a stable extension surface even if
 * we add helper methods to the base later.
 */
export abstract class Plugin {

    public abstract readonly id: string;

    public abstract readonly displayName: string;

    public abstract readonly kind: PluginKind;

}