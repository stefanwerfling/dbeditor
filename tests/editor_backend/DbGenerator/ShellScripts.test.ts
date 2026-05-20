import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {describe, expect, it, beforeEach, afterEach} from 'vitest';
import {DbGenerator} from '../../../editor_backend/DbGenerator/DbGenerator.js';
import {DbProject} from '../../../editor_backend/DbProject/DbProject.js';
import {ConfigDialect, ConfigOutputMode} from '../../../editor_backend/Config/Config.js';
import {JsonData, JsonDataDBType} from '../../../editor_schemas/JsonData.js';

const baseData = (): JsonData => ({
    fs: {
        unid: 'root',
        name: 'root',
        type: JsonDataDBType.root,
        entrys: [],
        tables: [],
        views: [],
        enums: []
    },
    editor: {controls_width: 240}
});

const project = (dest: string, before: {script: string; path: string;}[], after: {script: string; path: string;}[]): DbProject => ({
    name: 'shell-hook-test',
    schemaPath: '/dev/null',
    dialect: ConfigDialect.mysql,
    output: {
        mode: ConfigOutputMode.ddl_files,
        destinationPath: dest,
        destinationClear: false,
        sqlComment: false,
        sqlIndent: '    ',
        statementTerminator: ';',
        migrationFilenamePattern: '{timestamp}__{name}'
    },
    autoGenerate: false,
    scripts_before_generate: before,
    scripts_after_generate: after,
    connections: [],
    sync: {ignoreTables: [], ignoreColumnAttributes: []}
});

describe('DbGenerator shell-hook execution', () => {

    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbed-shell-'));
    });

    afterEach(() => {
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    it('runs before_generate scripts before writing files', async() => {
        const dest = path.join(tmp, 'out');
        const flag = path.join(tmp, 'before.flag');
        // `: > file` is a posix touch; the assertion below confirms it ran before mkdir of dest
        const gen = new DbGenerator();
        await gen.generate(project(dest, [
            {script: `: > ${JSON.stringify(flag)}`, path: tmp}
        ], []), baseData());
        expect(fs.existsSync(flag)).toBe(true);
    });

    it('runs after_generate scripts after writing files', async() => {
        const dest = path.join(tmp, 'out');
        const stamp = path.join(tmp, 'after.flag');
        const gen = new DbGenerator();
        await gen.generate(project(dest, [], [
            {script: `: > ${JSON.stringify(stamp)}`, path: tmp}
        ]), baseData());
        expect(fs.existsSync(stamp)).toBe(true);
        // dest directory exists too — confirms ordering (after-script ran *after* the writes)
        expect(fs.existsSync(dest)).toBe(true);
    });

    it('aborts generate on a non-zero exit from a before_generate script', async() => {
        const dest = path.join(tmp, 'out');
        const gen = new DbGenerator();
        await expect(gen.generate(project(dest, [
            {script: 'exit 7', path: tmp}
        ], []), baseData())).rejects.toThrow(/code 7/u);
        // dest dir was never created — failed before the write phase
        expect(fs.existsSync(dest)).toBe(false);
    });

    it('skips both before and after scripts in dry-run mode', async() => {
        const dest = path.join(tmp, 'out');
        const flagA = path.join(tmp, 'should-not-exist-before.flag');
        const flagB = path.join(tmp, 'should-not-exist-after.flag');
        const gen = new DbGenerator();
        await gen.generate(project(dest, [
            {script: `: > ${JSON.stringify(flagA)}`, path: tmp}
        ], [
            {script: `: > ${JSON.stringify(flagB)}`, path: tmp}
        ]), baseData(), {dryRun: true});
        expect(fs.existsSync(flagA)).toBe(false);
        expect(fs.existsSync(flagB)).toBe(false);
        // dest dir also not created because dry-run skips writes too
        expect(fs.existsSync(dest)).toBe(false);
    });

});