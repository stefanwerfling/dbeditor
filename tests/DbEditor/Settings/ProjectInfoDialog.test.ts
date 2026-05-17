// @vitest-environment happy-dom
/*
 * DOM tests for the editable Output settings section in
 * ProjectInfoDialog (added 3230d9e when the Project info + settings
 * dialogs were merged). Covers the diff-only save behaviour and the
 * read-only fallback when no save callback is supplied.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ProjectInfoDialog, ProjectInfoActions} from '../../../DbEditor/Settings/ProjectInfoDialog.js';
import {OutputSettings, ProjectInfo} from '../../../DbEditor/Api/DbApiClient.js';

const mkOutput = (over: Partial<OutputSettings> = {}): OutputSettings => ({
    mode: 'ddl-files',
    destinationPath: './schemas/sql',
    destinationClear: false,
    sqlComment: true,
    sqlIndent: '    ',
    statementTerminator: ';',
    migrationFilenamePattern: '{timestamp}__{name}',
    ...over
});

const mkInfo = (over: Partial<ProjectInfo> = {}): ProjectInfo => ({
    name: 'demo',
    dialect: 'mysql',
    schemaPath: './schemas/demo.json',
    autoGenerate: false,
    output: mkOutput(),
    sync: {ignoreTables: [], ignoreColumnAttributes: []},
    connections: [],
    scriptsBeforeGenerate: [],
    scriptsAfterGenerate: [],
    ...over
});

const baseActions = (): ProjectInfoActions => ({
    testConnection: vi.fn(async() => ({success: true}))
});

let dialog: ProjectInfoDialog | null = null;

beforeEach(() => {
    document.body.replaceChildren();
});

afterEach(() => {
    dialog?.close();
    dialog = null;
});

const findOutputInputs = (): {
    mode: HTMLSelectElement;
    destPath: HTMLInputElement;
    destClear: HTMLInputElement;
    sqlComment: HTMLInputElement;
    sqlIndent: HTMLInputElement;
    statementTerminator: HTMLInputElement;
    migration: HTMLInputElement;
} => {
    const form = document.querySelector<HTMLElement>('.project-info-output-form');
    if (!form) {throw new Error('output form missing — saveOutputSettings was not wired');}
    const inputs = Array.from(form.querySelectorAll<HTMLInputElement>('input'));
    const mode = form.querySelector<HTMLSelectElement>('select')!;
    const destPath = inputs[0];
    const destClear = inputs[1];
    const sqlComment = inputs[2];
    const sqlIndent = inputs[3];
    const statementTerminator = inputs[4];
    const migration = inputs[5];
    return {
        mode: mode,
        destPath: destPath,
        destClear: destClear,
        sqlComment: sqlComment,
        sqlIndent: sqlIndent,
        statementTerminator: statementTerminator,
        migration: migration
    };
};

const sectionTitles = (): string[] => Array.from(document.querySelectorAll('.project-info-section-title'))
.map(e => e.textContent?.trim() ?? '');

describe('ProjectInfoDialog — editable Output section', () => {

    it('renders the editable form when saveOutputSettings is provided', () => {
        const actions = baseActions();
        actions.saveOutputSettings = vi.fn(async() => undefined);
        dialog = new ProjectInfoDialog(mkInfo(), actions);
        dialog.show();
        expect(sectionTitles()).toContain('Output settings');
        const fields = findOutputInputs();
        expect(fields.mode.value).toBe('ddl-files');
        expect(fields.destPath.value).toBe('./schemas/sql');
        expect(fields.sqlComment.checked).toBe(true);
    });

    it('falls back to the read-only "Output (effective)" section when no save callback is supplied', () => {
        dialog = new ProjectInfoDialog(mkInfo(), baseActions());
        dialog.show();
        expect(sectionTitles()).toContain('Output (effective)');
        expect(document.querySelector('.project-info-output-form')).toBeNull();
    });

    it('Save sends a diff-only patch (only changed fields)', async() => {
        const actions = baseActions();
        const saveSpy = vi.fn(async() => undefined);
        actions.saveOutputSettings = saveSpy;
        dialog = new ProjectInfoDialog(mkInfo(), actions);
        dialog.show();

        const fields = findOutputInputs();
        fields.destPath.value = './out';
        fields.destClear.checked = true;

        const saveBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find(b => b.textContent?.trim() === 'Save output settings');
        saveBtn?.click();
        await new Promise<void>(r => { setTimeout(r, 0); });

        expect(saveSpy).toHaveBeenCalledTimes(1);
        expect(saveSpy).toHaveBeenCalledWith({
            destinationPath: './out',
            destinationClear: true
        });
    });

    it('Save with no edits shows "No changes." and never calls the callback', async() => {
        const actions = baseActions();
        const saveSpy = vi.fn(async() => undefined);
        actions.saveOutputSettings = saveSpy;
        dialog = new ProjectInfoDialog(mkInfo(), actions);
        dialog.show();

        const saveBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find(b => b.textContent?.trim() === 'Save output settings');
        saveBtn?.click();
        await new Promise<void>(r => { setTimeout(r, 0); });

        expect(saveSpy).not.toHaveBeenCalled();
        const status = document.querySelector('.project-info-output-status');
        expect(status?.textContent?.trim()).toBe('No changes.');
    });

});