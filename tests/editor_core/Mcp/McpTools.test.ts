import {describe, expect, it} from 'vitest';
import {Vts} from 'vts';
import {ConfigMcpPolicyAction} from '../../../Config/Config.js';
import {JsonDataDBType} from '../../../DbEditor/JsonData.js';
import {DbFsRepository} from '../../../DbRepository/DbFsRepository.js';
import {DbRepositoryRegistry} from '../../../DbRepository/DbRepositoryRegistry.js';
import {McpPolicy} from '../../../editor_core/Mcp/McpPolicy.js';
import {McpToolBuilder} from '../../../editor_core/Mcp/McpTool.js';
import {McpToolRegistry} from '../../../editor_core/Mcp/McpToolRegistry.js';
import {McpTools} from '../../../editor_core/Mcp/McpTools.js';

const makeRepo = (name: string): DbFsRepository => {
    return new DbFsRepository({
        name: name,
        schemaPath: ':memory:',
        dialect: 'mysql',
        autoGenerate: false,
        output: {
            mode: 'ddl-files',
            destinationPath: './out',
            destinationClear: false,
            sqlComment: true,
            sqlIndent: '    ',
            statementTerminator: ';',
            migrationFilenamePattern: '{timestamp}__{name}'
        },
        connections: [],
        sync: {ignoreTables: [], ignoreColumnAttributes: []},
        scripts_before_generate: [],
        scripts_after_generate: []
    });
};

const parseJsonResult = (result: {content: {type: 'text'; text: string;}[]; isError?: boolean;}): {body: any; isError: boolean;} => {
    return {
        body: JSON.parse(result.content[0].text),
        isError: result.isError === true
    };
};

describe('McpTools — read-only surface', () => {

    it('db_list_projects returns name + dialect + schemaPath + rev for each loaded repo', async() => {
        const repositories = new DbRepositoryRegistry();
        repositories.register('pid-1', makeRepo('demo'));
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_list_projects', {});
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.projects).toHaveLength(1);
        expect(body.projects[0]).toMatchObject({
            unid: 'pid-1',
            name: 'demo',
            schemaPath: ':memory:',
            dialect: 'mysql'
        });
        expect(typeof body.projects[0].rev).toBe('number');
    });

    it('db_get_tree returns the full fs tree for a known project', async() => {
        const repositories = new DbRepositoryRegistry();
        repositories.register('pid-1', makeRepo('demo'));
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_get_tree', {projectUnid: 'pid-1'});
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.fs.unid).toBe('root');
        expect(body.fs.type).toBe(JsonDataDBType.root);
        expect(Array.isArray(body.fs.entrys)).toBe(true);
    });

    it('db_get_tree returns an error result for an unknown projectUnid', async() => {
        const repositories = new DbRepositoryRegistry();
        repositories.register('pid-1', makeRepo('demo'));
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_get_tree', {projectUnid: 'pid-missing'});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('unknown project pid-missing');
    });

    it('db_list_tables walks the tree and returns flat table inventory', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        repo.createTable(db.unid, 'users', null, null);
        repositories.register('pid-1', repo);

        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));
        const result = await reg.call('db_list_tables', {projectUnid: 'pid-1'});
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.tables).toHaveLength(1);
        expect(body.tables[0]).toMatchObject({
            name: 'users',
            columnCount: 0,
            indexCount: 0,
            foreignKeyCount: 0
        });
    });

    it('db_get_table returns the table payload for a known unid and errors for an unknown one', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {table: created} = repo.createTable(db.unid, 'orders', null, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const ok = await reg.call('db_get_table', {projectUnid: 'pid-1', tableUnid: created.unid});
        const {body, isError} = parseJsonResult(ok);
        expect(isError).toBe(false);
        expect(body.table.unid).toBe(created.unid);
        expect(body.table.name).toBe('orders');

        const miss = await reg.call('db_get_table', {projectUnid: 'pid-1', tableUnid: 'tid-missing'});
        expect(miss.isError).toBe(true);
        expect(miss.content[0].text).toContain('unknown table');
    });

});

describe('McpTools — db_create_table mutation', () => {

    it('creates an empty table when no columns are supplied', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const revBefore = repo.rev;
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_create_table', {
            projectUnid: 'pid-1',
            containerUnid: db.unid,
            name: 'users'
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(typeof body.tableUnid).toBe('string');
        expect(body.tableUnid.length).toBeGreaterThan(0);
        expect(body.columns).toEqual([]);
        expect(body.rev).toBeGreaterThan(revBefore);

        // table is actually in the repo
        expect(db.tables.map(t => t.name)).toEqual(['users']);
        expect(db.tables[0].unid).toBe(body.tableUnid);
        expect(db.tables[0].columns).toEqual([]);
    });

    it('creates a table with columns in one call and returns each column unid', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_create_table', {
            projectUnid: 'pid-1',
            containerUnid: db.unid,
            name: 'orders',
            columns: [
                {name: 'id', type: 'int', primaryKey: true, autoIncrement: true, notNull: true},
                {name: 'total', type: 'decimal', length: '10,2', notNull: true},
                {name: 'created_at', type: 'timestamp', defaultValue: 'CURRENT_TIMESTAMP'}
            ]
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.columns.map((c: {name: string;}) => c.name)).toEqual(['id', 'total', 'created_at']);
        for (const c of body.columns as {name: string; unid: string;}[]) {
            expect(c.unid).toMatch(/^[0-9a-f-]{36}$/u);
        }

        const stored = db.tables[0];
        expect(stored.name).toBe('orders');
        expect(stored.columns).toHaveLength(3);
        expect(stored.columns[0]).toMatchObject({name: 'id', type: 'int', primaryKey: true, autoIncrement: true, notNull: true});
        expect(stored.columns[1]).toMatchObject({name: 'total', type: 'decimal', length: '10,2'});
        expect(stored.columns[2]).toMatchObject({name: 'created_at', type: 'timestamp', defaultValue: 'CURRENT_TIMESTAMP'});
    });

    it('writes the description when supplied', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        await reg.call('db_create_table', {
            projectUnid: 'pid-1',
            containerUnid: db.unid,
            name: 'audit_log',
            description: 'Append-only audit trail for sensitive ops.'
        });

        expect(db.tables[0].description).toBe('Append-only audit trail for sensitive ops.');
    });

    it('returns an error result for an unknown projectUnid (no repo mutation)', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_create_table', {
            projectUnid: 'pid-missing',
            containerUnid: 'whatever',
            name: 'x'
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('unknown project pid-missing');
    });

    it('returns an error result for an unknown containerUnid', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_create_table', {
            projectUnid: 'pid-1',
            containerUnid: 'cid-missing',
            name: 'x'
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('cid-missing');
        // repo state unchanged — original empty database with no tables
        expect(repo.data.fs.entrys[0].tables).toEqual([]);
    });

    it('honours the policy gate — ask without approval handler blocks the call', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        repositories.register('pid-1', repo);
        const decide = McpPolicy.compile({
            enabled: true,
            policy: {default: ConfigMcpPolicyAction.allow, rules: [{match: 'db_create_*', action: ConfigMcpPolicyAction.ask}]}
        });
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}), {decide: decide});

        const result = await reg.call('db_create_table', {projectUnid: 'pid-1', containerUnid: db.unid, name: 'users'});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('requires user approval');
        // repo state unchanged
        expect(db.tables).toEqual([]);
    });

});

describe('McpToolRegistry — validation + error handling', () => {

    it('returns isError=true when the tool name is unknown', async() => {
        const reg = new McpToolRegistry([]);
        const result = await reg.call('does_not_exist', {});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Unknown tool');
    });

    it('rejects args that fail the VTS inputSchema with isError + a shape message', async() => {
        const reg = new McpToolRegistry([
            McpToolBuilder.define({
                name: 'needs_string',
                description: 'requires a string `q`',
                inputSchema: Vts.object({q: Vts.string()}),
                handler: async({q}) => McpToolBuilder.json({echo: q})
            })
        ]);

        const ok = await reg.call('needs_string', {q: 'hi'});
        expect(ok.isError).toBe(undefined);
        expect(JSON.parse(ok.content[0].text)).toEqual({echo: 'hi'});

        const bad = await reg.call('needs_string', {q: 42});
        expect(bad.isError).toBe(true);
        expect(bad.content[0].text).toContain('Invalid arguments');
    });

    it('converts a handler exception into an error result rather than throwing', async() => {
        const reg = new McpToolRegistry([
            McpToolBuilder.define({
                name: 'always_throws',
                description: 'throws',
                inputSchema: Vts.object({}),
                handler: () => { throw new Error('boom'); }
            })
        ]);

        const result = await reg.call('always_throws', {});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('boom');
    });

    it('rejects construction with duplicate tool names', () => {
        const tool = McpToolBuilder.define({
            name: 'dup',
            description: 'first',
            inputSchema: Vts.object({}),
            handler: () => McpToolBuilder.json({})
        });
        expect(() => new McpToolRegistry([tool, tool])).toThrow(/Duplicate MCP tool name/u);
    });

    it('list() advertises every tool with a JSON-Schema-shaped inputSchema', () => {
        const reg = new McpToolRegistry([
            McpToolBuilder.define({
                name: 'one',
                description: 'first',
                inputSchema: Vts.object({a: Vts.string()}),
                handler: () => McpToolBuilder.json({})
            })
        ]);
        const list = reg.list();
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe('one');
        expect(list[0].inputSchema.type).toBe('object');
        expect(list[0].inputSchema.properties?.a?.type).toBe('string');
        expect(list[0].inputSchema.required).toEqual(['a']);
    });

});

describe('McpToolRegistry — policy gate', () => {

    const makeTool = (name: string): ReturnType<typeof McpToolBuilder.define> => McpToolBuilder.define({
        name: name,
        description: `runs ${name}`,
        inputSchema: Vts.object({}),
        handler: () => McpToolBuilder.json({ran: name})
    });

    it('hides denied tools from list() and rejects calls to them', async() => {
        const decide = McpPolicy.compile({
            enabled: true,
            policy: {
                default: ConfigMcpPolicyAction.allow,
                rules: [{match: 'db_delete_*', action: ConfigMcpPolicyAction.deny}]
            }
        });
        const reg = new McpToolRegistry(
            [makeTool('db_list_projects'), makeTool('db_delete_table')],
            {decide: decide}
        );

        expect(reg.list().map(t => t.name)).toEqual(['db_list_projects']);

        const denied = await reg.call('db_delete_table', {});
        expect(denied.isError).toBe(true);
        expect(denied.content[0].text).toContain('denied by policy');
    });

    it('prefixes ask-action tool descriptions with the approval warning', () => {
        const decide = McpPolicy.compile({
            enabled: true,
            policy: {
                default: ConfigMcpPolicyAction.ask,
                rules: [{match: 'db_list_*', action: ConfigMcpPolicyAction.allow}]
            }
        });
        const reg = new McpToolRegistry(
            [makeTool('db_list_projects'), makeTool('db_create_table')],
            {decide: decide}
        );
        const byName = new Map(reg.list().map(t => [t.name, t]));
        expect(byName.get('db_list_projects')?.description).toBe('runs db_list_projects');
        expect(byName.get('db_create_table')?.description).toMatch(/^⚠ Requires user approval — /u);
    });

    it('blocks ask-action calls when no approval handler is supplied', async() => {
        const decide = McpPolicy.compile({
            enabled: true,
            policy: {default: ConfigMcpPolicyAction.ask}
        });
        const reg = new McpToolRegistry([makeTool('db_anything')], {decide: decide});
        const result = await reg.call('db_anything', {});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('requires user approval');
    });

    it('lets ask-action calls through when the approval handler returns true', async() => {
        const decide = McpPolicy.compile({
            enabled: true,
            policy: {default: ConfigMcpPolicyAction.ask}
        });
        const reg = new McpToolRegistry(
            [makeTool('db_anything')],
            {decide: decide, onApprovalRequest: (): boolean => true}
        );
        const result = await reg.call('db_anything', {});
        expect(result.isError).toBe(undefined);
        expect(JSON.parse(result.content[0].text)).toEqual({ran: 'db_anything'});
    });

    it('rejects ask-action calls when the approval handler returns false', async() => {
        const decide = McpPolicy.compile({
            enabled: true,
            policy: {default: ConfigMcpPolicyAction.ask}
        });
        const reg = new McpToolRegistry(
            [makeTool('db_anything')],
            {decide: decide, onApprovalRequest: (): boolean => false}
        );
        const result = await reg.call('db_anything', {});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('was not confirmed');
    });

});