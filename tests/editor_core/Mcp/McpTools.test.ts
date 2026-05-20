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

describe('McpTools — db_update_table / db_delete_table mutations', () => {

    it('db_update_table renames and updates the description', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {table} = repo.createTable(db.unid, 'orders', null, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_update_table', {
            projectUnid: 'pid-1',
            tableUnid: table.unid,
            name: 'sales_orders',
            description: 'Renamed to disambiguate from the legacy table.'
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.patched.sort()).toEqual(['description', 'name']);
        expect(table.name).toBe('sales_orders');
        expect(table.description).toBe('Renamed to disambiguate from the legacy table.');
    });

    it('db_update_table errors when no patch fields are supplied', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {table} = repo.createTable(db.unid, 'orders', null, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_update_table', {projectUnid: 'pid-1', tableUnid: table.unid});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('at least one');
    });

    it('db_delete_table removes the table and strips dangling FKs in other tables', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {table: users} = repo.createTable(db.unid, 'users', null, null);
        const {table: orders} = repo.createTable(db.unid, 'orders', null, null);
        // orders.user_id -> users
        orders.foreignKeys.push({
            unid: 'fk-1',
            name: 'fk_orders_user',
            refTableUnid: users.unid,
            columns: []
        });
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_delete_table', {projectUnid: 'pid-1', tableUnid: users.unid});
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.deleted).toBe(users.unid);
        expect(db.tables.find(t => t.unid === users.unid)).toBeUndefined();
        // FK was stripped when its refTable disappeared
        expect(orders.foreignKeys).toEqual([]);
    });

    it('db_delete_table returns an error for an unknown tableUnid', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_delete_table', {projectUnid: 'pid-1', tableUnid: 'tid-missing'});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('tid-missing');
    });

});

describe('McpTools — db_add_column / db_update_column / db_delete_column mutations', () => {

    it('db_add_column appends to an existing table and returns the new columnUnid', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {table} = repo.createTable(db.unid, 'users', null, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_add_column', {
            projectUnid: 'pid-1',
            tableUnid: table.unid,
            column: {name: 'email', type: 'varchar', length: '255', notNull: true, unique: true}
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.name).toBe('email');
        expect(table.columns).toHaveLength(1);
        expect(table.columns[0]).toMatchObject({name: 'email', type: 'varchar', length: '255', notNull: true, unique: true});
        expect(table.columns[0].unid).toBe(body.columnUnid);
    });

    it('db_update_column patches only the supplied fields', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {table} = repo.createTable(db.unid, 'users', null, null);
        const {column} = repo.addColumn(table.unid, {name: 'email', type: 'varchar', length: '255'}, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_update_column', {
            projectUnid: 'pid-1',
            tableUnid: table.unid,
            columnUnid: column.unid,
            patch: {length: '320', notNull: true}
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.patched.sort()).toEqual(['length', 'notNull']);
        // patched fields changed; unpatched name + type unchanged
        expect(column.name).toBe('email');
        expect(column.type).toBe('varchar');
        expect(column.length).toBe('320');
        expect(column.notNull).toBe(true);
    });

    it('db_update_column rejects an empty patch', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {table} = repo.createTable(db.unid, 'users', null, null);
        const {column} = repo.addColumn(table.unid, {name: 'email', type: 'varchar'}, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_update_column', {
            projectUnid: 'pid-1',
            tableUnid: table.unid,
            columnUnid: column.unid,
            patch: {}
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('at least one');
    });

    it('db_delete_column removes the column and prunes empty indexes referencing it', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {table} = repo.createTable(db.unid, 'users', null, null);
        const {column: email} = repo.addColumn(table.unid, {name: 'email', type: 'varchar', length: '255'}, null);
        // single-column index on email — should be dropped when the column goes
        table.indexes.push({
            unid: 'ix-1',
            name: 'ux_users_email',
            type: 'unique',
            columns: [{columnUnid: email.unid, length: undefined, sort: undefined}]
        } as never);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_delete_column', {
            projectUnid: 'pid-1',
            tableUnid: table.unid,
            columnUnid: email.unid
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.deleted).toBe(email.unid);
        expect(table.columns).toEqual([]);
        // index that had only the deleted column was pruned
        expect(table.indexes).toEqual([]);
    });

    it('db_add_column returns an error for an unknown tableUnid', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_add_column', {
            projectUnid: 'pid-1',
            tableUnid: 'tid-missing',
            column: {name: 'x', type: 'int'}
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('tid-missing');
    });

});

describe('McpTools — index mutations', () => {

    it('db_add_index creates an index referencing existing columns', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {table} = repo.createTable(db.unid, 'users', null, null);
        const {column: email} = repo.addColumn(table.unid, {name: 'email', type: 'varchar', length: '255'}, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_add_index', {
            projectUnid: 'pid-1',
            tableUnid: table.unid,
            index: {
                name: 'ux_users_email',
                type: 'unique',
                columns: [{columnUnid: email.unid}]
            }
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.name).toBe('ux_users_email');
        expect(table.indexes).toHaveLength(1);
        expect(table.indexes[0]).toMatchObject({name: 'ux_users_email', type: 'unique'});
        expect(table.indexes[0].columns[0].columnUnid).toBe(email.unid);
        expect(table.indexes[0].unid).toBe(body.indexUnid);
    });

    it('db_update_index patches only the supplied fields', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {table} = repo.createTable(db.unid, 'users', null, null);
        const {column: email} = repo.addColumn(table.unid, {name: 'email', type: 'varchar'}, null);
        const {index} = repo.addIndex(table.unid, {name: 'ux_email', type: 'index', columns: [{columnUnid: email.unid}]}, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_update_index', {
            projectUnid: 'pid-1',
            tableUnid: table.unid,
            indexUnid: index.unid,
            patch: {name: 'ux_users_email', type: 'unique'}
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.patched.sort()).toEqual(['name', 'type']);
        expect(index.name).toBe('ux_users_email');
        expect(index.type).toBe('unique');
        // columns unchanged
        expect(index.columns[0].columnUnid).toBe(email.unid);
    });

    it('db_update_index rejects an empty patch', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {table} = repo.createTable(db.unid, 'users', null, null);
        const {column} = repo.addColumn(table.unid, {name: 'email', type: 'varchar'}, null);
        const {index} = repo.addIndex(table.unid, {name: 'ix', type: 'index', columns: [{columnUnid: column.unid}]}, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_update_index', {
            projectUnid: 'pid-1', tableUnid: table.unid, indexUnid: index.unid, patch: {}
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('at least one');
    });

    it('db_delete_index drops the index', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {table} = repo.createTable(db.unid, 'users', null, null);
        const {column} = repo.addColumn(table.unid, {name: 'email', type: 'varchar'}, null);
        const {index} = repo.addIndex(table.unid, {name: 'ix', type: 'index', columns: [{columnUnid: column.unid}]}, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_delete_index', {
            projectUnid: 'pid-1', tableUnid: table.unid, indexUnid: index.unid
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.deleted).toBe(index.unid);
        expect(table.indexes).toEqual([]);
    });

});

describe('McpTools — foreign-key mutations', () => {

    it('db_add_foreign_key creates a FK between two tables', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {table: users} = repo.createTable(db.unid, 'users', null, null);
        const {column: userId} = repo.addColumn(users.unid, {name: 'id', type: 'int', primaryKey: true}, null);
        const {table: orders} = repo.createTable(db.unid, 'orders', null, null);
        const {column: ordersUserId} = repo.addColumn(orders.unid, {name: 'user_id', type: 'int'}, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_add_foreign_key', {
            projectUnid: 'pid-1',
            tableUnid: orders.unid,
            fk: {
                name: 'fk_orders_user',
                refTableUnid: users.unid,
                columns: [{columnUnid: ordersUserId.unid, refColumnUnid: userId.unid}],
                onDelete: 'CASCADE'
            }
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.name).toBe('fk_orders_user');
        expect(orders.foreignKeys).toHaveLength(1);
        expect(orders.foreignKeys[0]).toMatchObject({
            name: 'fk_orders_user',
            refTableUnid: users.unid,
            onDelete: 'CASCADE'
        });
        expect(orders.foreignKeys[0].columns[0]).toEqual({columnUnid: ordersUserId.unid, refColumnUnid: userId.unid});
        expect(orders.foreignKeys[0].unid).toBe(body.fkUnid);
    });

    it('db_update_foreign_key changes onDelete/onUpdate', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {table: users} = repo.createTable(db.unid, 'users', null, null);
        const {column: userId} = repo.addColumn(users.unid, {name: 'id', type: 'int'}, null);
        const {table: orders} = repo.createTable(db.unid, 'orders', null, null);
        const {column: ordersUserId} = repo.addColumn(orders.unid, {name: 'user_id', type: 'int'}, null);
        const {fk} = repo.addForeignKey(orders.unid, {
            name: 'fk_x',
            refTableUnid: users.unid,
            columns: [{columnUnid: ordersUserId.unid, refColumnUnid: userId.unid}]
        }, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_update_foreign_key', {
            projectUnid: 'pid-1',
            tableUnid: orders.unid,
            fkUnid: fk.unid,
            patch: {onDelete: 'CASCADE', onUpdate: 'RESTRICT'}
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.patched.sort()).toEqual(['onDelete', 'onUpdate']);
        expect(fk.onDelete).toBe('CASCADE');
        expect(fk.onUpdate).toBe('RESTRICT');
        // name + columns unchanged
        expect(fk.name).toBe('fk_x');
    });

    it('db_delete_foreign_key drops the FK', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {table: users} = repo.createTable(db.unid, 'users', null, null);
        const {column: userId} = repo.addColumn(users.unid, {name: 'id', type: 'int'}, null);
        const {table: orders} = repo.createTable(db.unid, 'orders', null, null);
        const {column: ordersUserId} = repo.addColumn(orders.unid, {name: 'user_id', type: 'int'}, null);
        const {fk} = repo.addForeignKey(orders.unid, {
            name: 'fk_x',
            refTableUnid: users.unid,
            columns: [{columnUnid: ordersUserId.unid, refColumnUnid: userId.unid}]
        }, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_delete_foreign_key', {
            projectUnid: 'pid-1', tableUnid: orders.unid, fkUnid: fk.unid
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.deleted).toBe(fk.unid);
        expect(orders.foreignKeys).toEqual([]);
    });

});

describe('McpTools — container mutations', () => {

    it('db_create_container creates a folder under an existing database', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_create_container', {
            projectUnid: 'pid-1',
            parentUnid: db.unid,
            name: 'public',
            type: 'folder'
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.type).toBe('folder');
        expect(body.name).toBe('public');
        expect(db.entrys).toHaveLength(1);
        expect(db.entrys[0].name).toBe('public');
        expect(db.entrys[0].type).toBe(JsonDataDBType.folder);
    });

    it('db_update_container renames a folder', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {entry: folder} = repo.createContainer(db.unid, 'old', JsonDataDBType.folder, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_update_container', {
            projectUnid: 'pid-1',
            containerUnid: folder.unid,
            name: 'new'
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.patched).toEqual(['name']);
        expect(folder.name).toBe('new');
    });

    it('db_delete_container removes a folder and everything inside it', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {entry: folder} = repo.createContainer(db.unid, 'doomed', JsonDataDBType.folder, null);
        repo.createTable(folder.unid, 'inner', null, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_delete_container', {projectUnid: 'pid-1', containerUnid: folder.unid});
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.deleted).toBe(folder.unid);
        expect(db.entrys).toEqual([]);
    });

});

describe('McpTools — enum mutations', () => {

    it('db_create_enum creates an enum with initial values in one call', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_create_enum', {
            projectUnid: 'pid-1',
            containerUnid: db.unid,
            name: 'order_status',
            values: ['pending', 'paid', 'shipped', 'cancelled']
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.values.map((v: {value: string;}) => v.value)).toEqual(['pending', 'paid', 'shipped', 'cancelled']);
        expect(db.enums).toHaveLength(1);
        expect(db.enums[0].name).toBe('order_status');
        expect(db.enums[0].values.map(v => v.value)).toEqual(['pending', 'paid', 'shipped', 'cancelled']);
    });

    it('db_add_enum_value / db_update_enum_value / db_delete_enum_value mutate the value list in place', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {enumNode} = repo.createEnum(db.unid, 'order_status', null, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        // add
        const added = await reg.call('db_add_enum_value', {projectUnid: 'pid-1', enumUnid: enumNode.unid, value: 'draft'});
        const {body: addedBody} = parseJsonResult(added);
        expect(enumNode.values).toHaveLength(1);
        expect(enumNode.values[0].value).toBe('draft');
        const valueUnid = addedBody.valueUnid as string;

        // update
        const updated = await reg.call('db_update_enum_value', {
            projectUnid: 'pid-1', enumUnid: enumNode.unid, valueUnid: valueUnid, value: 'pending'
        });
        expect(updated.isError).toBe(undefined);
        expect(enumNode.values[0].value).toBe('pending');

        // delete
        const deleted = await reg.call('db_delete_enum_value', {projectUnid: 'pid-1', enumUnid: enumNode.unid, valueUnid: valueUnid});
        expect(deleted.isError).toBe(undefined);
        expect(enumNode.values).toEqual([]);
    });

    it('db_delete_enum removes the enum from its container', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {enumNode} = repo.createEnum(db.unid, 'order_status', null, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_delete_enum', {projectUnid: 'pid-1', enumUnid: enumNode.unid});
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.deleted).toBe(enumNode.unid);
        expect(db.enums).toEqual([]);
    });

});

describe('McpTools — view mutations', () => {

    it('db_create_view persists the SELECT body and materialized flag in one call', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_create_view', {
            projectUnid: 'pid-1',
            containerUnid: db.unid,
            name: 'active_orders',
            select: 'SELECT * FROM orders WHERE status = \'active\'',
            materialized: true,
            description: 'Materialized cache of active orders'
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(typeof body.viewUnid).toBe('string');
        expect(db.views).toHaveLength(1);
        expect(db.views[0]).toMatchObject({
            name: 'active_orders',
            select: 'SELECT * FROM orders WHERE status = \'active\'',
            materialized: true,
            description: 'Materialized cache of active orders'
        });
    });

    it('db_update_view patches the SELECT body without touching the name', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {view} = repo.createView(db.unid, 'v', null, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_update_view', {
            projectUnid: 'pid-1',
            viewUnid: view.unid,
            select: 'SELECT 1'
        });
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.patched).toEqual(['select']);
        expect(view.select).toBe('SELECT 1');
        expect(view.name).toBe('v');
    });

    it('db_delete_view removes the view', async() => {
        const repositories = new DbRepositoryRegistry();
        const repo = makeRepo('demo');
        const db = repo.data.fs.entrys[0]!;
        const {view} = repo.createView(db.unid, 'v', null, null);
        repositories.register('pid-1', repo);
        const reg = new McpToolRegistry(McpTools.build({repositories: repositories}));

        const result = await reg.call('db_delete_view', {projectUnid: 'pid-1', viewUnid: view.unid});
        const {body, isError} = parseJsonResult(result);

        expect(isError).toBe(false);
        expect(body.deleted).toBe(view.unid);
        expect(db.views).toEqual([]);
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