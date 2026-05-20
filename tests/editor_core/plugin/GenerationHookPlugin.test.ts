import {beforeEach, describe, expect, it} from 'vitest';
import {DbProject} from '../../../editor_backend/DbProject/DbProject.js';
import {JsonData} from '../../../DbEditor/JsonData.js';
import {GeneratedFile} from '../../../editor_backend/DbGenerator/DbGenerator.js';
import {GenerationHookPlugin} from '../../../editor_core/plugin/GenerationHookPlugin.js';
import {PluginKind} from '../../../editor_core/plugin/PluginKind.js';
import {PluginRegistry} from '../../../editor_core/plugin/PluginRegistry.js';

class RecordingHook extends GenerationHookPlugin {

    public readonly id = 'recording';

    public readonly displayName = 'Recording';

    public readonly calls: string[] = [];

    public override async beforeGenerate(_project: DbProject, _data: JsonData): Promise<void> {
        this.calls.push('before');
    }

    public override async afterGenerate(_project: DbProject, _data: JsonData, written: GeneratedFile[]): Promise<void> {
        this.calls.push(`after:${written.length}`);
    }

}

describe('GenerationHookPlugin', () => {
    beforeEach(() => {
        PluginRegistry.resetForTests();
    });

    it('reports the GenerationHook kind', () => {
        const hook = new RecordingHook();
        expect(hook.kind).toBe(PluginKind.GenerationHook);
    });

    it('records before/after invocations when overridden', async() => {
        const hook = new RecordingHook();
        const project = {} as DbProject;
        const data = {} as JsonData;
        await hook.beforeGenerate(project, data);
        await hook.afterGenerate(project, data, [{path: 'a.sql', content: 'x'}, {path: 'b.sql', content: 'y'}]);
        expect(hook.calls).toEqual(['before', 'after:2']);
    });

    it('registers and is returned from generationHooks()', () => {
        const hook = new RecordingHook();
        PluginRegistry.instance.register(hook);
        const list = PluginRegistry.instance.generationHooks();
        expect(list).toHaveLength(1);
        expect(list[0]).toBe(hook);
    });
});