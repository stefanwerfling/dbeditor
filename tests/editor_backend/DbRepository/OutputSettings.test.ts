/*
 * Tests for the per-project output-settings override diagram. `project.output`
 * (from `dbeditor.json`) is the default; `data.output` (from the schema
 * file) overrides per-field. The repo surfaces the merge as
 * `effectiveOutput()` / `effectiveProject`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DbFsRepository} from '../../../editor_backend/DbRepository/DbFsRepository.js';
import {DbProject} from '../../../editor_backend/DbProject/DbProject.js';
import {ConfigDialect, ConfigOutputMode} from '../../../editor_backend/Config/Config.js';

let tmpFile = '';

const projectFor = (file: string, output: Partial<DbProject['output']> = {}): DbProject => ({
    name: 'test',
    schemaPath: file,
    dialect: ConfigDialect.mysql,
    output: {
        mode: ConfigOutputMode.ddl_files,
        destinationPath: '/default/path',
        destinationClear: false,
        sqlComment: true,
        sqlIndent: '    ',
        statementTerminator: ';',
        migrationFilenamePattern: '{timestamp}__{name}',
        ...output
    },
    autoGenerate: false,
    scripts_before_generate: [],
    scripts_after_generate: [],
    connections: [],
    sync: {ignoreTables: [], ignoreColumnAttributes: []}
});

beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `dbed-output-${process.pid}-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {fs.unlinkSync(tmpFile);}
});

describe('DbFsRepository.effectiveOutput / effectiveProject', () => {

    it('returns the project defaults when no override is persisted', () => {
        const repo = new DbFsRepository(projectFor(tmpFile, {destinationPath: '/from/dbeditor/json'}));
        expect(repo.effectiveOutput().destinationPath).toBe('/from/dbeditor/json');
        expect(repo.effectiveProject.output.destinationPath).toBe('/from/dbeditor/json');
    });

    it('overrides exactly the fields in the patch, others fall back to defaults', () => {
        const repo = new DbFsRepository(projectFor(tmpFile, {destinationPath: '/default', sqlIndent: '    '}));
        repo.updateOutputSettings({destinationPath: '/from/ui'}, null);
        expect(repo.effectiveOutput().destinationPath).toBe('/from/ui');
        /* sqlIndent kept at default */
        expect(repo.effectiveOutput().sqlIndent).toBe('    ');
    });

    it('partial patches merge across multiple calls', () => {
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateOutputSettings({destinationPath: '/a'}, null);
        repo.updateOutputSettings({sqlIndent: '\t'}, null);
        const out = repo.effectiveOutput();
        expect(out.destinationPath).toBe('/a');
        expect(out.sqlIndent).toBe('\t');
    });

    it('boolean false override wins over the default true', () => {
        const repo = new DbFsRepository(projectFor(tmpFile, {sqlComment: true}));
        repo.updateOutputSettings({sqlComment: false}, null);
        expect(repo.effectiveOutput().sqlComment).toBe(false);
    });

    it('effectiveProject preserves non-output fields verbatim', () => {
        const repo = new DbFsRepository(projectFor(tmpFile));
        repo.updateOutputSettings({destinationPath: '/from/ui'}, null);
        const eff = repo.effectiveProject;
        expect(eff.name).toBe('test');
        expect(eff.dialect).toBe(ConfigDialect.mysql);
        expect(eff.output.destinationPath).toBe('/from/ui');
    });

    it('publishes an output.settings.update event on each call', () => {
        const repo = new DbFsRepository(projectFor(tmpFile));
        const events: string[] = [];
        repo.bus.subscribe(ev => events.push(ev.op));
        repo.updateOutputSettings({destinationPath: '/a'}, null);
        expect(events.filter(e => e === 'output.settings.update')).toHaveLength(1);
    });

});