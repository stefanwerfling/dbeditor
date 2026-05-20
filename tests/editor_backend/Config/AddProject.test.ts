import {describe, expect, it} from 'vitest';
import {
    ProjectConfig,
    AddProjectError
} from '../../../editor_backend/Config/AddProject.js';

const baseConfig = (): unknown => ({
    projects: [
        {
            name: 'MyDatabase',
            schemaPath: './schemas/database.json',
            dialect: 'mysql',
            output: {
                mode: 'ddl-files',
                destinationPath: './schemas/sql'
            }
        }
    ],
    server: {port: 5274},
    browser: {open: false}
});

const validInput = (overrides: Record<string, any> = {}): any => ({
    name: 'Second',
    schemaPath: './schemas/second.json',
    dialect: 'postgres',
    output: {
        mode: 'migrations',
        destinationPath: './schemas/second-sql'
    },
    ...overrides
});

describe('addProjectToConfig', () => {

    it('appends a new project entry without touching existing ones', () => {
        const next = ProjectConfig.add(baseConfig(), validInput());
        expect(next.projects.length).toBe(2);
        expect(next.projects[0].name).toBe('MyDatabase');
        expect(next.projects[1]).toMatchObject({
            name: 'Second',
            schemaPath: './schemas/second.json',
            dialect: 'postgres',
            output: {mode: 'migrations', destinationPath: './schemas/second-sql'}
        });
    });

    it('preserves server/browser blocks verbatim', () => {
        const next = ProjectConfig.add(baseConfig(), validInput());
        expect(next.server).toEqual({port: 5274});
        expect(next.browser).toEqual({open: false});
    });

    it('omits autoGenerate when not requested (default behaviour stays implicit)', () => {
        const next = ProjectConfig.add(baseConfig(), validInput());
        expect((next.projects[1] as any).autoGenerate).toBeUndefined();
    });

    it('emits autoGenerate: true only when requested', () => {
        const next = ProjectConfig.add(baseConfig(), validInput({autoGenerate: true}));
        expect((next.projects[1] as any).autoGenerate).toBe(true);
    });

    it('rejects duplicate name (case-insensitive)', () => {
        expect(() => ProjectConfig.add(baseConfig(), validInput({name: 'MYDATABASE'})))
        .toThrow(AddProjectError);
        try {
            ProjectConfig.add(baseConfig(), validInput({name: 'mydatabase'}));
        } catch (err) {
            expect(err).toBeInstanceOf(AddProjectError);
            expect((err as AddProjectError).code).toBe('duplicate-name');
        }
    });

    it('rejects duplicate schemaPath (case-sensitive)', () => {
        try {
            ProjectConfig.add(baseConfig(), validInput({schemaPath: './schemas/database.json'}));
        } catch (err) {
            expect(err).toBeInstanceOf(AddProjectError);
            expect((err as AddProjectError).code).toBe('duplicate-schema-path');
        }
    });

    it('rejects unknown dialect', () => {
        try {
            ProjectConfig.add(baseConfig(), validInput({dialect: 'oracle'}));
        } catch (err) {
            expect(err).toBeInstanceOf(AddProjectError);
            expect((err as AddProjectError).code).toBe('invalid-input');
            expect((err as AddProjectError).message).toContain('oracle');
        }
    });

    it('rejects unknown output mode', () => {
        try {
            ProjectConfig.add(baseConfig(), validInput({output: {mode: 'json-files', destinationPath: './x'}}));
        } catch (err) {
            expect(err).toBeInstanceOf(AddProjectError);
            expect((err as AddProjectError).code).toBe('invalid-input');
        }
    });

    it('rejects empty name after trim', () => {
        try {
            ProjectConfig.add(baseConfig(), validInput({name: '   '}));
        } catch (err) {
            expect(err).toBeInstanceOf(AddProjectError);
            expect((err as AddProjectError).code).toBe('invalid-input');
        }
    });

    it('rejects empty schemaPath after trim', () => {
        try {
            ProjectConfig.add(baseConfig(), validInput({schemaPath: '   '}));
        } catch (err) {
            expect(err).toBeInstanceOf(AddProjectError);
            expect((err as AddProjectError).code).toBe('invalid-input');
        }
    });

    it('rejects empty destinationPath after trim', () => {
        try {
            ProjectConfig.add(baseConfig(), validInput({output: {mode: 'ddl-files', destinationPath: '   '}}));
        } catch (err) {
            expect(err).toBeInstanceOf(AddProjectError);
            expect((err as AddProjectError).code).toBe('invalid-input');
        }
    });

    it('rejects malformed config object (no projects array)', () => {
        try {
            ProjectConfig.add({server: {port: 5174}}, validInput());
        } catch (err) {
            expect(err).toBeInstanceOf(AddProjectError);
            expect((err as AddProjectError).code).toBe('invalid-config');
        }
    });

    it('appends correctly when starting from a single-project config', () => {
        const next = ProjectConfig.add(baseConfig(), validInput({name: 'Analytics', schemaPath: './schemas/analytics.json'}));
        expect(next.projects.map(p => p.name)).toEqual(['MyDatabase', 'Analytics']);
    });

    it('appends correctly when starting from an empty projects array', () => {
        const cfg: unknown = {projects: [], server: {port: 5174}};
        const next = ProjectConfig.add(cfg, validInput());
        expect(next.projects.length).toBe(1);
        expect(next.projects[0].name).toBe('Second');
    });

    it('trims name and schemaPath before persisting', () => {
        const next = ProjectConfig.add(baseConfig(), validInput({name: '  Padded  ', schemaPath: '  ./schemas/padded.json  '}));
        expect(next.projects[1].name).toBe('Padded');
        expect(next.projects[1].schemaPath).toBe('./schemas/padded.json');
    });

    it('accepts all four supported dialects', () => {
        for (const dialect of ['mysql', 'mariadb', 'postgres', 'sqlite']) {
            const next = ProjectConfig.add(baseConfig(), validInput({
                name: `proj-${dialect}`,
                schemaPath: `./schemas/${dialect}.json`,
                dialect: dialect
            }));
            expect(next.projects[1].dialect).toBe(dialect);
        }
    });

});

const twoProjectConfig = (): unknown => ({
    projects: [
        {
            name: 'Primary',
            schemaPath: './schemas/primary.json',
            dialect: 'mysql',
            output: {mode: 'ddl-files', destinationPath: './schemas/primary-sql'}
        },
        {
            name: 'Analytics',
            schemaPath: './schemas/analytics.json',
            dialect: 'postgres',
            output: {mode: 'migrations', destinationPath: './schemas/analytics-sql'},
            autoGenerate: true
        }
    ],
    server: {port: 5274}
});

const expectAddError = (fn: () => unknown, code: string): AddProjectError => {
    try {
        fn();
    } catch (err) {
        expect(err).toBeInstanceOf(AddProjectError);
        const e = err as AddProjectError;
        expect(e.code).toBe(code);
        return e;
    }
    throw new Error(`expected AddProjectError with code "${code}" but call returned normally`);
};

describe('updateProjectInConfig', () => {

    it('renames a project (case-insensitive lookup)', () => {
        const next = ProjectConfig.update(twoProjectConfig(), 'primary', {name: 'Main'});
        expect(next.projects[0].name).toBe('Main');
        expect(next.projects[1].name).toBe('Analytics');
    });

    it('keeps autoGenerate when patch omits it', () => {
        const next = ProjectConfig.update(twoProjectConfig(), 'Analytics', {name: 'AnalyticsV2'});
        expect((next.projects[1] as any).autoGenerate).toBe(true);
    });

    it('explicit autoGenerate:false removes the key', () => {
        const next = ProjectConfig.update(twoProjectConfig(), 'Analytics', {autoGenerate: false});
        expect((next.projects[1] as any).autoGenerate).toBeUndefined();
    });

    it('explicit autoGenerate:true sets the key', () => {
        const next = ProjectConfig.update(twoProjectConfig(), 'Primary', {autoGenerate: true});
        expect((next.projects[0] as any).autoGenerate).toBe(true);
    });

    it('patches output.mode without touching destinationPath', () => {
        const next = ProjectConfig.update(twoProjectConfig(), 'Primary', {output: {mode: 'migrations'}});
        expect(next.projects[0].output.mode).toBe('migrations');
        expect(next.projects[0].output.destinationPath).toBe('./schemas/primary-sql');
    });

    it('rejects rename collision with another project (case-insensitive)', () => {
        expectAddError(
            () => ProjectConfig.update(twoProjectConfig(), 'Primary', {name: 'ANALYTICS'}),
            'duplicate-name'
        );
    });

    it('allows keeping own name (no-op rename)', () => {
        const next = ProjectConfig.update(twoProjectConfig(), 'Primary', {name: 'PRIMARY'});
        expect(next.projects[0].name).toBe('PRIMARY');
    });

    it('rejects schemaPath collision with another project', () => {
        expectAddError(
            () => ProjectConfig.update(twoProjectConfig(), 'Primary', {schemaPath: './schemas/analytics.json'}),
            'duplicate-schema-path'
        );
    });

    it('allows keeping own schemaPath', () => {
        const next = ProjectConfig.update(twoProjectConfig(), 'Primary', {schemaPath: './schemas/primary.json'});
        expect(next.projects[0].schemaPath).toBe('./schemas/primary.json');
    });

    it('rejects unknown dialect', () => {
        expectAddError(
            () => ProjectConfig.update(twoProjectConfig(), 'Primary', {dialect: 'oracle'}),
            'invalid-input'
        );
    });

    it('rejects unknown output mode', () => {
        expectAddError(
            () => ProjectConfig.update(twoProjectConfig(), 'Primary', {output: {mode: 'json-files'}}),
            'invalid-input'
        );
    });

    it('rejects empty trimmed name (cannot clear)', () => {
        expectAddError(
            () => ProjectConfig.update(twoProjectConfig(), 'Primary', {name: '   '}),
            'invalid-input'
        );
    });

    it('rejects empty trimmed schemaPath', () => {
        expectAddError(
            () => ProjectConfig.update(twoProjectConfig(), 'Primary', {schemaPath: '   '}),
            'invalid-input'
        );
    });

    it('rejects empty trimmed output.destinationPath', () => {
        expectAddError(
            () => ProjectConfig.update(twoProjectConfig(), 'Primary', {output: {destinationPath: '   '}}),
            'invalid-input'
        );
    });

    it('rejects unknown project name', () => {
        expectAddError(
            () => ProjectConfig.update(twoProjectConfig(), 'Nope', {name: 'X'}),
            'unknown-project'
        );
    });

    it('preserves unmanaged fields (connections, sync) verbatim', () => {
        const cfg = {
            projects: [{
                name: 'KeepFields',
                schemaPath: './schemas/keep.json',
                dialect: 'mysql',
                output: {mode: 'ddl-files', destinationPath: './schemas/keep-sql'},
                connections: [{databaseUnid: 'x', host: 'h', user: 'u', database: 'd'}],
                sync: {ignoreTables: ['junction']}
            }]
        };
        const next = ProjectConfig.update(cfg, 'KeepFields', {name: 'Renamed'});
        const p = next.projects[0] as any;
        expect(p.connections).toEqual([{databaseUnid: 'x', host: 'h', user: 'u', database: 'd'}]);
        expect(p.sync).toEqual({ignoreTables: ['junction']});
    });

    it('leaves the other project untouched when one is patched', () => {
        const next = ProjectConfig.update(twoProjectConfig(), 'Primary', {name: 'Main', dialect: 'mariadb'});
        expect(next.projects[1]).toMatchObject({
            name: 'Analytics',
            schemaPath: './schemas/analytics.json',
            dialect: 'postgres'
        });
    });

});

describe('removeProjectFromConfig', () => {

    it('drops the named project (case-insensitive)', () => {
        const next = ProjectConfig.remove(twoProjectConfig(), 'analytics');
        expect(next.projects).toHaveLength(1);
        expect(next.projects[0].name).toBe('Primary');
    });

    it('preserves the surviving project verbatim', () => {
        const next = ProjectConfig.remove(twoProjectConfig(), 'Analytics');
        expect(next.projects[0]).toMatchObject({
            name: 'Primary',
            schemaPath: './schemas/primary.json',
            dialect: 'mysql',
            output: {mode: 'ddl-files', destinationPath: './schemas/primary-sql'}
        });
    });

    it('preserves server/browser blocks', () => {
        const next = ProjectConfig.remove(twoProjectConfig(), 'Primary');
        expect(next.server).toEqual({port: 5274});
    });

    it('produces an empty projects[] when the last entry is removed', () => {
        const cfg = {
            projects: [{
                name: 'Only',
                schemaPath: './schemas/only.json',
                dialect: 'mysql',
                output: {mode: 'ddl-files', destinationPath: './schemas/only-sql'}
            }],
            server: {port: 5174}
        };
        const next = ProjectConfig.remove(cfg, 'Only');
        expect(next.projects).toEqual([]);
    });

    it('rejects unknown project name', () => {
        expectAddError(
            () => ProjectConfig.remove(twoProjectConfig(), 'Nope'),
            'unknown-project'
        );
    });

    it('rejects malformed config', () => {
        expectAddError(
            () => ProjectConfig.remove({server: {port: 5174}}, 'X'),
            'invalid-config'
        );
    });

});