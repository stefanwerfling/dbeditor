import {describe, expect, it} from 'vitest';
import {SchemaDiff} from '../../../editor_backend/DbDiff/SchemaDiff.js';
import {SchemaChangeKind} from '../../../editor_backend/DbDiff/ChangeTypes.js';
import {DbProjectSync} from '../../../editor_backend/DbProject/DbProject.js';
import {
    JsonColumn,
    JsonDataDB,
    JsonDataDBType,
    JsonEnum,
    JsonForeignKey,
    JsonIndex,
    JsonIndexType,
    JsonTable,
    JsonTableOptions,
    JsonView
} from '../../../editor_schemas/JsonData.js';

const sync = (patch: Partial<DbProjectSync> = {}): DbProjectSync => ({
    ignoreTables: [],
    ignoreColumnAttributes: [],
    ...patch
});

const col = (name: string, patch: Partial<JsonColumn> = {}): JsonColumn => ({
    unid: `col-${name}`,
    name: name,
    type: 'int',
    ...patch
});

const table = (
    name: string,
    columns: JsonColumn[] = [],
    patch: Partial<JsonTable> = {}
): JsonTable => ({
    unid: `tbl-${name}`,
    name: name,
    pos: {x: 0, y: 0},
    columns: columns,
    indexes: [],
    foreignKeys: [],
    options: undefined,
    ...patch
});

const view = (name: string, select: string, patch: Partial<JsonView> = {}): JsonView => ({
    unid: `vw-${name}`,
    name: name,
    pos: {x: 0, y: 0},
    select: select,
    ...patch
});

const enumOf = (name: string, values: string[]): JsonEnum => ({
    unid: `en-${name}`,
    name: name,
    values: values.map((v, i) => ({unid: `en-${name}-v${i}`, value: v}))
});

const db = (
    name: string,
    tables: JsonTable[] = [],
    views: JsonView[] = [],
    enums: JsonEnum[] = []
): JsonDataDB => ({
    unid: `db-${name}`,
    name: name,
    type: JsonDataDBType.database,
    entrys: [],
    tables: tables,
    views: views,
    enums: enums
});

const findChange = (changes: ReturnType<typeof SchemaDiff.diff>['changes'], kind: SchemaChangeKind, name: string): unknown =>
    changes.find(c => c.kind === kind && (c.tableName === name || c.viewName === name));

describe('SchemaDiff.diff', () => {

    it('flags tables only in the model as added', () => {
        const model = db('app', [table('users', [col('id')])]);
        const live = db('app', []);
        const result = SchemaDiff.diff(model, live, sync());
        const added = result.changes.find(c => c.kind === SchemaChangeKind.tableAdded);
        expect(added).toBeDefined();
        expect(added?.tableName).toBe('users');
        expect(added?.severity).toBe('safe');
    });

    it('flags tables only in the live DB as dropped, with destructive severity', () => {
        const model = db('app', []);
        const live = db('app', [table('legacy', [col('id')])]);
        const result = SchemaDiff.diff(model, live, sync());
        const dropped = result.changes.find(c => c.kind === SchemaChangeKind.tableDropped);
        expect(dropped).toBeDefined();
        expect(dropped?.tableName).toBe('legacy');
        expect(dropped?.severity).toBe('destructive');
    });

    it('ignoreTables excludes tables on both sides', () => {
        const model = db('app', [table('users', [col('id')])]);
        const live = db('app', [table('legacy', [col('id')])]);
        const result = SchemaDiff.diff(model, live, sync({ignoreTables: ['users', 'legacy']}));
        expect(result.changes).toHaveLength(0);
    });

    it('emits no changes when model and live are identical', () => {
        const cols = [col('id', {primaryKey: true, notNull: true, autoIncrement: true})];
        const model = db('app', [table('users', cols)]);
        const live = db('app', [table('users', cols)]);
        const result = SchemaDiff.diff(model, live, sync());
        expect(result.changes).toHaveLength(0);
    });

    it('detects columnAdded / columnDropped / columnChanged for a matching table', () => {
        const model = db('app', [table('users', [
            col('id', {primaryKey: true}),
            col('email', {type: 'varchar', length: '255'})
        ])]);
        const live = db('app', [table('users', [
            col('id', {primaryKey: true}),
            col('username', {type: 'varchar', length: '64'})
        ])]);
        const result = SchemaDiff.diff(model, live, sync());
        expect(findChange(result.changes, SchemaChangeKind.columnAdded, 'users')).toBeDefined();
        expect(findChange(result.changes, SchemaChangeKind.columnDropped, 'users')).toBeDefined();
    });

    it('columnChanged carries before/after column snapshots', () => {
        const model = db('app', [table('users', [col('id', {type: 'bigint'})])]);
        const live = db('app', [table('users', [col('id', {type: 'int'})])]);
        const result = SchemaDiff.diff(model, live, sync());
        const ch = result.changes.find(c => c.kind === SchemaChangeKind.columnChanged);
        expect(ch).toBeDefined();
        expect((ch?.before as JsonColumn).type).toBe('int');
        expect((ch?.after as JsonColumn).type).toBe('bigint');
        expect(ch?.severity).toBe('warn');
    });

    it('honours ignoreColumnAttributes for collation/charset', () => {
        const model = db('app', [table('t', [col('id', {collation: 'utf8mb4_general_ci'})])]);
        const live = db('app', [table('t', [col('id', {collation: 'utf8mb4_unicode_ci'})])]);

        const ignored = SchemaDiff.diff(model, live, sync({ignoreColumnAttributes: ['collation']}));
        expect(ignored.changes).toHaveLength(0);

        const tracked = SchemaDiff.diff(model, live, sync());
        expect(tracked.changes.some(c => c.kind === SchemaChangeKind.columnChanged)).toBe(true);
    });

    it('detects indexAdded / indexDropped / indexChanged', () => {
        const liveIdx: JsonIndex = {
            unid: 'i1',
            name: 'idx_email',
            type: JsonIndexType.index,
            columns: [{columnUnid: 'col-email'}]
        };
        const modelIdx: JsonIndex = {
            unid: 'i1m',
            name: 'idx_email',
            type: JsonIndexType.unique,
            columns: [{columnUnid: 'col-email'}]
        };
        const modelOnly: JsonIndex = {
            unid: 'i2',
            name: 'idx_new',
            type: JsonIndexType.index,
            columns: [{columnUnid: 'col-email'}]
        };
        const liveOnly: JsonIndex = {
            unid: 'i3',
            name: 'idx_legacy',
            type: JsonIndexType.index,
            columns: [{columnUnid: 'col-email'}]
        };

        const model = db('app', [table('t', [col('email')], {indexes: [modelIdx, modelOnly]})]);
        const live = db('app', [table('t', [col('email')], {indexes: [liveIdx, liveOnly]})]);
        const result = SchemaDiff.diff(model, live, sync());

        expect(result.changes.some(c => c.kind === SchemaChangeKind.indexChanged && c.indexName === 'idx_email')).toBe(true);
        expect(result.changes.some(c => c.kind === SchemaChangeKind.indexAdded && c.indexName === 'idx_new')).toBe(true);
        expect(result.changes.some(c => c.kind === SchemaChangeKind.indexDropped && c.indexName === 'idx_legacy')).toBe(true);
    });

    it('detects fkAdded / fkDropped', () => {
        const fkModel: JsonForeignKey = {
            unid: 'fk1',
            name: 'fk_user',
            refTableUnid: 'tbl-users',
            columns: [{columnUnid: 'col-user_id', refColumnUnid: 'col-id'}],
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        };

        const model = db('app', [
            table('users', [col('id', {primaryKey: true})]),
            table('orders', [col('user_id')], {foreignKeys: [fkModel]})
        ]);
        const live = db('app', [
            table('users', [col('id', {primaryKey: true})]),
            table('orders', [col('user_id')])
        ]);

        const result = SchemaDiff.diff(model, live, sync());
        expect(result.changes.some(c => c.kind === SchemaChangeKind.fkAdded && c.fkName === 'fk_user')).toBe(true);
    });

    it('detects tableOptionsChanged', () => {
        const liveOpts: JsonTableOptions = {engine: 'MyISAM', charset: 'latin1'};
        const modelOpts: JsonTableOptions = {engine: 'InnoDB', charset: 'utf8mb4'};
        const model = db('app', [table('t', [col('id')], {options: modelOpts})]);
        const live = db('app', [table('t', [col('id')], {options: liveOpts})]);
        const result = SchemaDiff.diff(model, live, sync());
        const ch = result.changes.find(c => c.kind === SchemaChangeKind.tableOptionsChanged);
        expect(ch).toBeDefined();
        expect(ch?.severity).toBe('warn');
    });

    it('detects view added / dropped / changed and is order-stable across sides', () => {
        const model = db('app', [], [
            view('v_zeta', 'SELECT 1'),
            view('v_alpha', 'SELECT 2')
        ]);
        const live = db('app', [], [
            view('v_alpha', 'SELECT 99'),
            view('v_legacy', 'SELECT 3')
        ]);

        const result = SchemaDiff.diff(model, live, sync());
        const kinds = result.changes.map(c => c.kind);
        expect(kinds).toContain(SchemaChangeKind.viewAdded);
        expect(kinds).toContain(SchemaChangeKind.viewDropped);
        expect(kinds).toContain(SchemaChangeKind.viewChanged);

        const added = result.changes.find(c => c.kind === SchemaChangeKind.viewAdded);
        const dropped = result.changes.find(c => c.kind === SchemaChangeKind.viewDropped);
        const changed = result.changes.find(c => c.kind === SchemaChangeKind.viewChanged);
        expect(added?.viewName).toBe('v_zeta');
        expect(dropped?.viewName).toBe('v_legacy');
        expect(changed?.viewName).toBe('v_alpha');
    });

    it('walks folders on the model side (live side is flat)', () => {
        const folder: JsonDataDB = {
            unid: 'folder1',
            name: 'sub',
            type: JsonDataDBType.folder,
            entrys: [],
            tables: [table('nested', [col('id')])],
            views: [],
            enums: []
        };
        const model = db('app', []);
        model.entrys = [folder];

        const live = db('app', []);
        const result = SchemaDiff.diff(model, live, sync());
        const added = result.changes.find(c => c.kind === SchemaChangeKind.tableAdded);
        expect(added?.tableName).toBe('nested');
    });

    it('returns databaseUnid from model and databaseName from live', () => {
        const model = db('app');
        model.unid = 'project-db-uuid';
        const live = db('production_db');
        const result = SchemaDiff.diff(model, live, sync());
        expect(result.databaseUnid).toBe('project-db-uuid');
        expect(result.databaseName).toBe('production_db');
    });

    it('every change has a non-empty id, empty sql array, and three-tier severity', () => {
        const model = db('app', [table('a', [col('id')]), table('b', [col('id', {type: 'bigint'})])]);
        const live = db('app', [table('b', [col('id', {type: 'int'})]), table('c', [col('id')])]);
        const result = SchemaDiff.diff(model, live, sync());
        for (const c of result.changes) {
            expect(c.id).toBeTypeOf('string');
            expect(c.id.length).toBeGreaterThan(0);
            expect(c.sql).toEqual([]);
            expect(['safe', 'warn', 'destructive']).toContain(c.severity);
        }
        const ids = result.changes.map(c => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    /*
     * --------------------- diagram-scoping ---------------------
     */
    it('diagram scope: includes only tables tagged with the given diagramUnid (model)', () => {
        const inLayer = table('users', [col('id')], {diagramUnid: 'lyr-1'});
        /* `audits` left without a diagramUnid so it falls outside the scope */
        const outOfLayer = table('audits', [col('id')]);
        const model = db('app', [inLayer, outOfLayer]);
        /* live has both — only the in-diagram table should drive a change */
        const liveInLayer = table('users', [col('id'), col('email', {type: 'varchar', length: '64', notNull: true})]);
        const liveOutOfLayer = table('audits', [col('id'), col('action', {type: 'varchar', length: '32'})]);
        const live = db('app', [liveInLayer, liveOutOfLayer]);
        const result = SchemaDiff.diff(model, live, sync(), undefined, 'lyr-1');
        const tableNames = new Set(result.changes.map(c => c.tableName));
        expect(tableNames.has('users')).toBe(true);
        expect(tableNames.has('audits')).toBe(false);
    });

    it('diagram scope: live tables NOT in the diagram are not reported as dropped', () => {
        const inLayer = table('users', [col('id')], {diagramUnid: 'lyr-1'});
        const model = db('app', [inLayer]);
        /* `audits` is live-only — would normally be tableDropped, but it's outside the diagram scope */
        const live = db('app', [
            table('users', [col('id')]),
            table('audits', [col('id')])
        ]);
        const result = SchemaDiff.diff(model, live, sync(), undefined, 'lyr-1');
        const dropped = result.changes.find(c => c.kind === SchemaChangeKind.tableDropped);
        expect(dropped).toBeUndefined();
    });

    it('diagram scope: skips views entirely (diagram-scope is table-only)', () => {
        const inLayer = table('users', [col('id')], {diagramUnid: 'lyr-1'});
        const model = db('app', [inLayer], [view('user_summary', 'SELECT * FROM users')]);
        const live = db('app', [], []);
        const result = SchemaDiff.diff(model, live, sync(), undefined, 'lyr-1');
        const viewChange = result.changes.find(c => c.viewName !== undefined);
        expect(viewChange).toBeUndefined();
    });

    it('diagram scope: unknown diagramUnid yields an empty change set', () => {
        const model = db('app', [table('users', [col('id')], {diagramUnid: 'lyr-1'})]);
        const live = db('app', [table('users', [col('id'), col('extra')])]);
        const result = SchemaDiff.diff(model, live, sync(), undefined, 'lyr-bogus');
        expect(result.changes).toHaveLength(0);
    });

    /*
     * --------------------- manual rename hints (iter 7) ---------------------
     * SchemaDiff doesn't infer renames; the SyncDialog UI collects
     * user-paired hints and forwards them via the renames arg. Each
     * matched (drop, add) pair collapses into a single rename entry.
     */
    it('rename hint: collapses tableDropped + tableAdded into one tableRenamed', () => {
        const model = db('app', [table('users_v2', [col('id')])]);
        const live = db('app', [table('users', [col('id')])]);
        const before = SchemaDiff.diff(model, live, sync());
        expect(before.changes.find(c => c.kind === SchemaChangeKind.tableAdded)?.tableName).toBe('users_v2');
        expect(before.changes.find(c => c.kind === SchemaChangeKind.tableDropped)?.tableName).toBe('users');

        const after = SchemaDiff.diff(model, live, sync(), undefined, undefined, {
            tables: [{from: 'users', to: 'users_v2'}]
        });
        const renamed = after.changes.find(c => c.kind === SchemaChangeKind.tableRenamed);
        expect(renamed?.tableName).toBe('users_v2');
        expect(after.changes.find(c => c.kind === SchemaChangeKind.tableAdded)).toBeUndefined();
        expect(after.changes.find(c => c.kind === SchemaChangeKind.tableDropped)).toBeUndefined();
    });

    it('rename hint: drops a hint with no matching pair without error', () => {
        const model = db('app', [table('users', [col('id')])]);
        const live = db('app', [table('users', [col('id')])]);
        const after = SchemaDiff.diff(model, live, sync(), undefined, undefined, {
            tables: [{from: 'no_such', to: 'no_such_v2'}]
        });
        expect(after.changes.length).toBe(0);
    });

    it('rename hint: collapses columnDropped + columnAdded within a table', () => {
        const model = db('app', [table('users', [col('id'), col('email_new')])]);
        const live = db('app', [table('users', [col('id'), col('email_old')])]);
        const before = SchemaDiff.diff(model, live, sync());
        expect(before.changes.some(c => c.kind === SchemaChangeKind.columnAdded && c.columnName === 'email_new')).toBe(true);
        expect(before.changes.some(c => c.kind === SchemaChangeKind.columnDropped && c.columnName === 'email_old')).toBe(true);

        const after = SchemaDiff.diff(model, live, sync(), undefined, undefined, {
            columns: [{tableName: 'users', from: 'email_old', to: 'email_new'}]
        });
        const renamed = after.changes.find(c => c.kind === SchemaChangeKind.columnRenamed);
        expect(renamed?.columnName).toBe('email_new');
        expect(renamed?.tableName).toBe('users');
        expect(after.changes.find(c => c.kind === SchemaChangeKind.columnAdded)).toBeUndefined();
        expect(after.changes.find(c => c.kind === SchemaChangeKind.columnDropped)).toBeUndefined();
    });

    it('rename hint: two separate table renames coexist in one diff', () => {
        const model = db('app', [table('users_v2', [col('id')]), table('orders_v2', [col('id')])]);
        const live = db('app', [table('users', [col('id')]), table('orders', [col('id')])]);
        const after = SchemaDiff.diff(model, live, sync(), undefined, undefined, {
            tables: [
                {from: 'users', to: 'users_v2'},
                {from: 'orders', to: 'orders_v2'}
            ]
        });
        const renamed = after.changes.filter(c => c.kind === SchemaChangeKind.tableRenamed);
        expect(renamed).toHaveLength(2);
        expect(after.changes.some(c => c.kind === SchemaChangeKind.tableAdded)).toBe(false);
        expect(after.changes.some(c => c.kind === SchemaChangeKind.tableDropped)).toBe(false);
    });

    it('rename hint: column rename within an UNCHANGED table works', () => {
        /*
         * The column drop+add pair only surfaces when the table name
         * is unchanged — the diff's table loop goes INSIDE the table
         * only on name match. So column renames stack with table
         * renames as a two-pass operation (apply the table rename
         * first, re-diff, then apply column renames), not in one
         * round. This test pins that semantic.
         */
        const model = db('app', [table('users', [col('id'), col('email_new')])]);
        const live = db('app', [table('users', [col('id'), col('email_old')])]);
        const after = SchemaDiff.diff(model, live, sync(), undefined, undefined, {
            columns: [{tableName: 'users', from: 'email_old', to: 'email_new'}]
        });
        const renamed = after.changes.find(c => c.kind === SchemaChangeKind.columnRenamed);
        expect(renamed).toBeDefined();
        expect(after.changes.some(c => c.kind === SchemaChangeKind.columnAdded)).toBe(false);
        expect(after.changes.some(c => c.kind === SchemaChangeKind.columnDropped)).toBe(false);
    });

});

describe('SchemaDiff.diff — deterministic change ids', () => {

    /*
     * Regression: change ids must be stable across diff calls on the
     * same input. The sync routes (test-run / apply / reverse-apply)
     * re-run the diff server-side and filter by the `changeIds` the
     * client sent from a prior preview; if ids drifted, the filter
     * would always be empty and every selected change would silently
     * fall out → 409 "no matching changes — re-run preview".
     */

    it('two diff calls on identical input produce identical change ids', () => {
        const model = db('app', [
            table('users', [col('id'), col('email')]),
            table('orders', [col('id'), col('total')])
        ]);
        const live = db('app', [
            table('users', [col('id')]),
            table('legacy', [col('id')])
        ]);
        const a = SchemaDiff.diff(model, live, sync());
        const b = SchemaDiff.diff(model, live, sync());
        const idsA = a.changes.map(c => c.id).sort();
        const idsB = b.changes.map(c => c.id).sort();
        expect(idsA).toEqual(idsB);
        expect(idsA.length).toBeGreaterThan(0);
    });

    it('id encodes the change identity — kind + table/column/index/fk/view name', () => {
        const model = db('app', [table('users', [col('id'), col('email')])]);
        const live = db('app', [table('users', [col('id')])]);
        const changes = SchemaDiff.diff(model, live, sync()).changes;
        const added = changes.find(c => c.kind === SchemaChangeKind.columnAdded);
        expect(added).toBeDefined();
        expect(added!.id).toBe('columnAdded:users:email::::');
    });

    it('different changes get different ids within one diff', () => {
        const model = db('app', [
            table('users', [col('id'), col('a'), col('b')])
        ]);
        const live = db('app', [table('users', [col('id')])]);
        const ids = SchemaDiff.diff(model, live, sync()).changes.map(c => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('rename hint produces a stable id incorporating from + to', () => {
        const model = db('app', [table('users', [col('id'), col('email_new')])]);
        const live = db('app', [table('users', [col('id'), col('email_old')])]);
        const renames = {columns: [{tableName: 'users', from: 'email_old', to: 'email_new'}]};
        const a = SchemaDiff.diff(model, live, sync(), undefined, undefined, renames);
        const b = SchemaDiff.diff(model, live, sync(), undefined, undefined, renames);
        const aRen = a.changes.find(c => c.kind === SchemaChangeKind.columnRenamed);
        const bRen = b.changes.find(c => c.kind === SchemaChangeKind.columnRenamed);
        expect(aRen?.id).toBe('columnRenamed:users:email_old:email_new');
        expect(aRen?.id).toBe(bRen?.id);
    });

});

describe('SchemaDiff.diff — enums', () => {

    it('flags enums only in the model as added with safe severity', () => {
        const model = db('app', [], [], [enumOf('status', ['active', 'inactive'])]);
        const live = db('app', [], [], []);
        const changes = SchemaDiff.diff(model, live, sync()).changes;
        const added = changes.find(c => c.kind === SchemaChangeKind.enumAdded);
        expect(added).toBeDefined();
        expect(added?.enumName).toBe('status');
        expect(added?.severity).toBe('safe');
        expect(added?.after).toBeDefined();
    });

    it('flags enums only in the live DB as dropped with destructive severity', () => {
        const model = db('app', [], [], []);
        const live = db('app', [], [], [enumOf('legacy_kind', ['old'])]);
        const changes = SchemaDiff.diff(model, live, sync()).changes;
        const dropped = changes.find(c => c.kind === SchemaChangeKind.enumDropped);
        expect(dropped).toBeDefined();
        expect(dropped?.enumName).toBe('legacy_kind');
        expect(dropped?.severity).toBe('destructive');
        expect(dropped?.before).toBeDefined();
    });

    it('matches enums by name and emits no change when value lists are identical in order', () => {
        const model = db('app', [], [], [enumOf('status', ['a', 'b', 'c'])]);
        const live = db('app', [], [], [enumOf('status', ['a', 'b', 'c'])]);
        const changes = SchemaDiff.diff(model, live, sync()).changes;
        expect(changes.some(c => c.kind === SchemaChangeKind.enumChanged)).toBe(false);
    });

    it('flags an enum as changed when the model adds a value', () => {
        const model = db('app', [], [], [enumOf('status', ['a', 'b', 'c'])]);
        const live = db('app', [], [], [enumOf('status', ['a', 'b'])]);
        const changes = SchemaDiff.diff(model, live, sync()).changes;
        const changed = changes.find(c => c.kind === SchemaChangeKind.enumChanged);
        expect(changed).toBeDefined();
        expect(changed?.enumName).toBe('status');
        expect(changed?.severity).toBe('warn');
    });

    it('flags an enum as changed when values are reordered (positional compare)', () => {
        const model = db('app', [], [], [enumOf('status', ['b', 'a'])]);
        const live = db('app', [], [], [enumOf('status', ['a', 'b'])]);
        const changes = SchemaDiff.diff(model, live, sync()).changes;
        const changed = changes.find(c => c.kind === SchemaChangeKind.enumChanged);
        expect(changed).toBeDefined();
    });

    it('enum change id encodes the kind + enumName, stable across diff calls', () => {
        const model = db('app', [], [], [enumOf('status', ['a', 'b', 'c'])]);
        const live = db('app', [], [], [enumOf('status', ['a', 'b'])]);
        const a = SchemaDiff.diff(model, live, sync()).changes
        .find(c => c.kind === SchemaChangeKind.enumChanged);
        const b = SchemaDiff.diff(model, live, sync()).changes
        .find(c => c.kind === SchemaChangeKind.enumChanged);
        expect(a?.id).toBe('enumChanged::::::status');
        expect(a?.id).toBe(b?.id);
    });

    it('skips enum diff entirely when diagram-scoped (enums are not layer members)', () => {
        const layeredTable = table('users', [col('id')], {diagramUnid: 'lay-1'});
        const model = db('app', [layeredTable], [], [enumOf('status', ['a'])]);
        const live = db('app', [layeredTable], [], []);
        const changes = SchemaDiff.diff(model, live, sync(), undefined, 'lay-1').changes;
        expect(changes.some(c => c.kind === SchemaChangeKind.enumAdded)).toBe(false);
    });

});