import {beforeEach, describe, expect, it, vi} from 'vitest';
import {FileFormatPlugin} from '../../../editor_core/Plugin/FileFormatPlugin.js';
import {PluginBootstrap, PluginImporter, PluginModule} from '../../../editor_core/Plugin/PluginBootstrap.js';
import {PluginRegistry} from '../../../editor_core/Plugin/PluginRegistry.js';

class ThirdPartyFormat extends FileFormatPlugin {

    public readonly id = 'third-party';
    public readonly displayName = 'Third-party format';
    public readonly extensions = ['tpf'] as const;
    public readonly mimeType = 'application/x-tpf';
    public import(): never { throw new Error('not used'); }
    public export(): never { throw new Error('not used'); }

}

const moduleExportingConstructor: PluginModule = {ThirdPartyFormat: ThirdPartyFormat};
const moduleExportingInstance: PluginModule = {plugin: new ThirdPartyFormat()};
const moduleExportingNothingUseful: PluginModule = {someHelper: (): number => 42};

describe('PluginBootstrap.loadFromConfig', () => {
    beforeEach(() => {
        PluginRegistry.resetForTests();
    });

    it('registers a Plugin subclass exported as a constructor', async() => {
        const importer: PluginImporter = async() => moduleExportingConstructor;
        const ids = await PluginBootstrap.loadFromConfig(['fake-pkg'], '/tmp/fake-root', importer);
        expect(ids).toEqual(['third-party']);
        expect(PluginRegistry.instance.fileFormat('third-party')).toBeInstanceOf(ThirdPartyFormat);
    });

    it('registers a Plugin instance exported directly', async() => {
        const importer: PluginImporter = async() => moduleExportingInstance;
        const ids = await PluginBootstrap.loadFromConfig(['fake-pkg'], '/tmp/fake-root', importer);
        expect(ids).toEqual(['third-party']);
        expect(PluginRegistry.instance.fileFormat('third-party')).toBe(moduleExportingInstance.plugin);
    });

    it('warns and registers nothing when the package has no Plugin exports', async() => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const importer: PluginImporter = async() => moduleExportingNothingUseful;
        const ids = await PluginBootstrap.loadFromConfig(['useless-pkg'], '/tmp/fake-root', importer);
        expect(ids).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('useless-pkg'));
        warn.mockRestore();
    });

    it('logs and continues when one package fails to import', async() => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let call = 0;
        const importer: PluginImporter = async() => {
            call += 1;
            if (call === 1) {throw new Error('module not found');}
            return moduleExportingConstructor;
        };
        const ids = await PluginBootstrap.loadFromConfig(['broken-pkg', 'good-pkg'], '/tmp/fake-root', importer);
        expect(ids).toEqual(['third-party']);
        expect(err).toHaveBeenCalledWith(expect.stringContaining('broken-pkg'), expect.any(Error));
        err.mockRestore();
    });

    it('processes the package list in order', async() => {
        const seen: string[] = [];
        const importer: PluginImporter = async(pkg) => {
            seen.push(pkg);
            return moduleExportingNothingUseful;
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await PluginBootstrap.loadFromConfig(['a', 'b', 'c'], '/tmp/fake-root', importer);
        expect(seen).toEqual(['a', 'b', 'c']);
        warn.mockRestore();
    });
});