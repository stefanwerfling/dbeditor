/*
 * MwbWriter tests — both round-trip (parse → write → parse) against
 * the demo sample, and synthetic write (build a JsonDataDB by hand,
 * write, parse, assert).
 *
 * Round-trip is the strongest correctness signal: if we can re-parse
 * what we just wrote and the structure matches the original, we know
 * the serialiser at least produces parser-compatible output. This
 * doesn't guarantee Workbench will accept the file (we have no
 * Workbench install in CI) but covers every entity kind the editor
 * persists.
 */
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';
// eslint-disable-next-line import/extensions
import AdmZip from 'adm-zip';
import {parseMwb} from '../../DbMwbImport/MwbReader.js';
import {writeMwb} from '../../DbMwbImport/MwbWriter.js';
import {JsonColumn, JsonDataDB, JsonDataDBType, JsonRoutineKind} from '../../DbEditor/JsonData.js';

const SAMPLE = path.resolve(__dirname, '../../sample/example.mwb');

describe('writeMwb — example.mwb round-trip', () => {

    it('parse → write → parse preserves schema/table/column/FK counts', () => {
        const originalBuf = fs.readFileSync(SAMPLE);
        const original = parseMwb(originalBuf);
        const rewrittenBuf = writeMwb(original.databases);
        const re = parseMwb(rewrittenBuf);

        expect(re.schemaCount).toBe(original.schemaCount);
        expect(re.tableCount).toBe(original.tableCount);
        expect(re.columnCount).toBe(original.columnCount);
        expect(re.foreignKeyCount).toBe(original.foreignKeyCount);
    });

    it('round-trip preserves table names + column names + ordering within each table', () => {
        const original = parseMwb(fs.readFileSync(SAMPLE));
        const re = parseMwb(writeMwb(original.databases));

        expect(re.databases[0].tables.map(t => t.name).sort())
        .toEqual(original.databases[0].tables.map(t => t.name).sort());

        const origByName = new Map(original.databases[0].tables.map(t => [t.name, t]));
        for (const reTable of re.databases[0].tables) {
            const origTable = origByName.get(reTable.name);
            expect(origTable).toBeDefined();
            expect(reTable.columns.map(c => c.name)).toEqual(origTable!.columns.map(c => c.name));
        }
    });

    it('round-trip preserves PK + AI + NN + UNSIGNED column flags', () => {
        const original = parseMwb(fs.readFileSync(SAMPLE));
        const re = parseMwb(writeMwb(original.databases));

        const origByName = new Map(original.databases[0].tables.map(t => [t.name, t]));
        let totalCols = 0;
        for (const reTable of re.databases[0].tables) {
            const origTable = origByName.get(reTable.name)!;
            const origCols = new Map(origTable.columns.map(c => [c.name, c]));
            for (const reCol of reTable.columns) {
                const oc = origCols.get(reCol.name)!;
                expect(Boolean(reCol.primaryKey)).toBe(Boolean(oc.primaryKey));
                expect(Boolean(reCol.autoIncrement)).toBe(Boolean(oc.autoIncrement));
                expect(Boolean(reCol.notNull)).toBe(Boolean(oc.notNull));
                expect(Boolean(reCol.unsigned)).toBe(Boolean(oc.unsigned));
                expect(reCol.type).toBe(oc.type);
                totalCols++;
            }
        }
        /* Sanity: the loop ran over every column. */
        expect(totalCols).toBe(original.columnCount);
    });

    it('round-trip preserves diagram count + per-table diagram-membership', () => {
        /*
         * Phase E — layers survive parse → write → parse. The writer
         * emits each JsonDiagram as `workbench.physical.Layer` inside
         * the single diagram, plus a `diagram` link on each TableFigure.
         * The parser detects authored layers (any non-rootLayer
         * Layer struct) and uses them — so the re-parse should
         * produce the same diagram count and the same table → diagram
         * grouping (matched by name, since unids are minted afresh).
         */
        const original = parseMwb(fs.readFileSync(SAMPLE));
        const re = parseMwb(writeMwb(original.databases));

        expect(re.layerCount).toBe(original.layerCount);

        /*
         * Build name-keyed groupings from each side: diagram name →
         * set of table names. The two sides should match.
         */
        const groupingFor = (databases: typeof original.databases): Map<string, Set<string>> => {
            const layersByUnid = new Map((databases[0].diagrams ?? []).map(l => [l.unid, l]));
            const groups = new Map<string, Set<string>>();
            for (const t of databases[0].tables) {
                if (!t.diagramUnid) {continue;}
                const diagram = layersByUnid.get(t.diagramUnid);
                if (!diagram) {continue;}
                const set = groups.get(diagram.name) ?? new Set<string>();
                set.add(t.name);
                groups.set(diagram.name, set);
            }
            return groups;
        };

        const a = groupingFor(original.databases);
        const b = groupingFor(re.databases);
        expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
        for (const [name, tables] of a) {
            expect(b.get(name)).toBeDefined();
            expect([...b.get(name)!].sort()).toEqual([...tables].sort());
        }
    });

    it('round-trip preserves canvas positions for tables that had a figure', () => {
        const original = parseMwb(fs.readFileSync(SAMPLE));
        const re = parseMwb(writeMwb(original.databases));

        /*
         * Phase C imports positions from `workbench.physical.TableFigure`;
         * Phase D emits them back into a single Diagram on export. If
         * either side regresses, the count of placed tables on the re-
         * parsed file will drop below the original (or above if we leak
         * default-(80,80) tables into the figures list).
         */
        expect(re.positionedTableCount).toBe(original.positionedTableCount);

        const origByName = new Map(original.databases[0].tables.map(t => [t.name, t]));
        for (const reTable of re.databases[0].tables) {
            const origTable = origByName.get(reTable.name)!;
            expect(reTable.pos.x).toBe(origTable.pos.x);
            expect(reTable.pos.y).toBe(origTable.pos.y);
        }
    });

    it('round-trip preserves FK refTable + column-pair structure', () => {
        const original = parseMwb(fs.readFileSync(SAMPLE));
        const re = parseMwb(writeMwb(original.databases));

        const origByName = new Map(original.databases[0].tables.map(t => [t.name, t]));
        const reByName = new Map(re.databases[0].tables.map(t => [t.name, t]));

        for (const [name, origTable] of origByName) {
            const reTable = reByName.get(name)!;
            expect(reTable.foreignKeys.length).toBe(origTable.foreignKeys.length);
            /*
             * The FK names are preserved; pair each up by name and
             * compare the linked column names to verify cross-refs
             * were stitched correctly through the unid-shuffle.
             */
            const origReColMap = new Map(origTable.columns.map(c => [c.unid, c.name]));
            const reReColMap = new Map(reTable.columns.map(c => [c.unid, c.name]));
            const origFkByName = new Map(origTable.foreignKeys.map(fk => [fk.name, fk]));
            for (const reFk of reTable.foreignKeys) {
                const oFk = origFkByName.get(reFk.name)!;
                expect(reFk.columns.length).toBe(oFk.columns.length);
                for (let i = 0; i < reFk.columns.length; i++) {
                    expect(reReColMap.get(reFk.columns[i].columnUnid)).toBe(origReColMap.get(oFk.columns[i].columnUnid));
                }
            }
        }
    });

});

/*
 * Build a column with a globally-unique unid. Real models use
 * `crypto.randomUUID()`; tests previously used `c-${name}` which
 * collided when the same column name appeared in two tables (e.g.
 * `id`) and broke FK cross-ref tests.
 */
let _colCounter = 0;
const mkCol = (over: Partial<JsonColumn> & {name: string; type: string;}): JsonColumn => ({
    unid: `c-${++_colCounter}-${over.name}`,
    ...over
});

describe('writeMwb — synthetic build', () => {

    it('write a one-table model and re-parse it', () => {
        const db: JsonDataDB = {
            unid: 'db-1',
            name: 'mini',
            type: JsonDataDBType.database,
            entrys: [],
            tables: [{
                unid: 't-1',
                name: 'user',
                pos: {x: 0, y: 0},
                columns: [
                    mkCol({name: 'id', type: 'int', primaryKey: true, autoIncrement: true, notNull: true, unsigned: true}),
                    mkCol({name: 'email', type: 'varchar', length: '255', notNull: true}),
                    mkCol({name: 'amount', type: 'decimal', length: '10,2'})
                ],
                indexes: [],
                foreignKeys: []
            }],
            views: [],
            enums: [],
            routines: []
        };
        const r = parseMwb(writeMwb([db]));
        expect(r.schemaCount).toBe(1);
        expect(r.databases[0].name).toBe('mini');
        expect(r.databases[0].tables).toHaveLength(1);
        const t = r.databases[0].tables[0];
        expect(t.name).toBe('user');
        expect(t.columns).toHaveLength(3);
        expect(t.columns[0]).toMatchObject({name: 'id', type: 'int', primaryKey: true, autoIncrement: true, notNull: true, unsigned: true});
        expect(t.columns[1]).toMatchObject({name: 'email', type: 'varchar', length: '255', notNull: true});
        expect(t.columns[2]).toMatchObject({name: 'amount', type: 'decimal', length: '10,2'});
    });

    it('write a unique index and re-parse it as unique', () => {
        const id = mkCol({name: 'id', type: 'int', primaryKey: true});
        const slug = mkCol({name: 'slug', type: 'varchar', length: '64'});
        const db: JsonDataDB = {
            unid: 'db-1', name: 'mini', type: JsonDataDBType.database, entrys: [],
            tables: [{
                unid: 't-1', name: 'user', pos: {x: 0, y: 0},
                columns: [id, slug],
                indexes: [{
                    unid: 'ix-1',
                    name: 'uk_slug',
                    type: 'unique',
                    columns: [{columnUnid: slug.unid}]
                }],
                foreignKeys: []
            }],
            views: [], enums: [], routines: []
        };
        const r = parseMwb(writeMwb([db]));
        const t = r.databases[0].tables[0];
        const ix = t.indexes.find(i => i.name === 'uk_slug');
        expect(ix).toBeDefined();
        expect(ix!.type).toBe('unique');
    });

    it('write FK between two tables and re-parse cross-refs', () => {
        const userPk = mkCol({name: 'id', type: 'int', primaryKey: true});
        const postPk = mkCol({name: 'id', type: 'int', primaryKey: true});
        const postUserId = mkCol({name: 'user_id', type: 'int', notNull: true});
        const db: JsonDataDB = {
            unid: 'db-1', name: 'mini', type: JsonDataDBType.database, entrys: [],
            tables: [
                {
                    unid: 't-user', name: 'user', pos: {x: 0, y: 0},
                    columns: [userPk],
                    indexes: [], foreignKeys: []
                },
                {
                    unid: 't-post', name: 'post', pos: {x: 0, y: 0},
                    columns: [postPk, postUserId],
                    indexes: [],
                    foreignKeys: [{
                        unid: 'fk-1',
                        name: 'fk_post_user',
                        refTableUnid: 't-user',
                        columns: [{columnUnid: postUserId.unid, refColumnUnid: userPk.unid}],
                        onDelete: 'CASCADE',
                        onUpdate: 'NO ACTION'
                    }]
                }
            ],
            views: [], enums: [], routines: []
        };
        const r = parseMwb(writeMwb([db]));
        const post = r.databases[0].tables.find(t => t.name === 'post')!;
        expect(post.foreignKeys).toHaveLength(1);
        const fk = post.foreignKeys[0];
        expect(fk.name).toBe('fk_post_user');
        expect(fk.onDelete).toBe('CASCADE');
        const user = r.databases[0].tables.find(t => t.name === 'user')!;
        expect(fk.refTableUnid).toBe(user.unid);
        const userIdCol = post.columns.find(c => c.name === 'user_id')!;
        const userIdPk = user.columns.find(c => c.name === 'id')!;
        expect(fk.columns[0].columnUnid).toBe(userIdCol.unid);
        expect(fk.columns[0].refColumnUnid).toBe(userIdPk.unid);
    });

    it('write a diagram + table.diagramUnid and re-parse the grouping', () => {
        const userPk = mkCol({name: 'id', type: 'int', primaryKey: true});
        const diagramUnid = 'lay-1';
        const db: JsonDataDB = {
            unid: 'db-1', name: 'mini', type: JsonDataDBType.database, entrys: [],
            tables: [{
                unid: 't-user', name: 'user', pos: {x: 100, y: 100},
                columns: [userPk],
                indexes: [], foreignKeys: [],
                diagramUnid: diagramUnid
            }],
            views: [], enums: [], routines: [],
            diagrams: [{
                unid: diagramUnid,
                name: 'People',
                pos: {x: 50, y: 50},
                width: 400,
                height: 300,
                color: 'rgba(64, 145, 220, 0.10)'
            }]
        };
        const r = parseMwb(writeMwb([db]));
        expect(r.layerCount).toBe(1);
        const reLayers = r.databases[0].diagrams ?? [];
        expect(reLayers).toHaveLength(1);
        expect(reLayers[0].name).toBe('People');
        expect(reLayers[0].width).toBe(400);
        expect(reLayers[0].height).toBe(300);
        const reTable = r.databases[0].tables[0];
        expect(reTable.diagramUnid).toBe(reLayers[0].unid);
    });

    it('write a positioned view and re-parse the pos via ViewFigure', () => {
        /*
         * Phase C — view-position round-trip parallel to the existing
         * table-position one. A view with a non-default `pos` must
         * emit a `workbench.physical.ViewFigure` so a re-parse lands
         * the same coordinates back on the model. Views at the
         * (80, 80) fallback are skipped (Workbench auto-layouts).
         */
        const db: JsonDataDB = {
            unid: 'db-1', name: 'mini', type: JsonDataDBType.database, entrys: [],
            tables: [],
            views: [
                {
                    unid: 'v-placed', name: 'placed_view',
                    pos: {x: 420, y: 240}, select: 'SELECT 1'
                },
                {
                    unid: 'v-default', name: 'default_view',
                    pos: {x: 80, y: 80}, select: 'SELECT 2'
                }
            ],
            enums: [], routines: []
        };
        const r = parseMwb(writeMwb([db]));
        expect(r.positionedViewCount).toBe(1);
        const placed = r.databases[0].views.find(v => v.name === 'placed_view')!;
        const defaulted = r.databases[0].views.find(v => v.name === 'default_view')!;
        expect(placed.pos).toEqual({x: 420, y: 240});
        expect(defaulted.pos).toEqual({x: 80, y: 80});
    });

    it('write view + routine + trigger and re-parse them', () => {
        const db: JsonDataDB = {
            unid: 'db-1', name: 'mini', type: JsonDataDBType.database, entrys: [],
            tables: [{
                unid: 't-orders', name: 'orders', pos: {x: 0, y: 0},
                columns: [mkCol({name: 'id', type: 'int', primaryKey: true})],
                indexes: [], foreignKeys: []
            }],
            views: [{
                unid: 'v-1', name: 'active_orders', pos: {x: 0, y: 0},
                select: 'SELECT * FROM orders WHERE status = 1'
            }],
            enums: [],
            routines: [
                {
                    unid: 'r-1', name: 'sp_calc', pos: {x: 0, y: 0},
                    kind: JsonRoutineKind.procedure,
                    body: 'CREATE PROCEDURE sp_calc() BEGIN SELECT 1; END'
                },
                {
                    unid: 'r-2', name: 'trg_audit', pos: {x: 0, y: 0},
                    kind: JsonRoutineKind.trigger,
                    body: 'CREATE TRIGGER trg_audit AFTER INSERT ON orders FOR EACH ROW INSERT INTO audit (id) VALUES (NEW.id)'
                }
            ]
        };
        const r = parseMwb(writeMwb([db]));
        expect(r.viewCount).toBe(1);
        expect(r.routineCount).toBe(1);
        expect(r.triggerCount).toBe(1);
        const reDb = r.databases[0];
        expect(reDb.views[0].name).toBe('active_orders');
        const routines = reDb.routines ?? [];
        expect(routines.find(x => x.name === 'sp_calc')?.kind).toBe(JsonRoutineKind.procedure);
        expect(routines.find(x => x.name === 'trg_audit')?.kind).toBe(JsonRoutineKind.trigger);
    });

});

/*
 * Phase E — round-trip preservation of `wbPassthrough`. The demo
 * sample was generated by our own writer with no unknowns to capture,
 * so the round-trip-against-real-Workbench tests are gone. We keep
 * the synthetic-write test that verifies a hand-crafted
 * passthrough payload survives write+re-parse — the smaller but
 * faithful signal that the codec is bidirectional.
 */
describe('writeMwb — Phase E wbPassthrough round-trip', () => {

    it('synthetic passthrough: a custom value round-trips through write+re-parse', () => {
        const db: JsonDataDB = {
            unid: 'db-x', name: 'app', type: JsonDataDBType.database,
            entrys: [], views: [], enums: [], routines: [],
            tables: [{
                unid: 'tbl-x', name: 'users',
                pos: {x: 0, y: 0}, columns: [], indexes: [], foreignKeys: [],
                wbPassthrough: {
                    values: [
                        {key: 'vendorTag', xml: '      <value type="string" key="vendorTag">workbench-only</value>'},
                        {key: 'vendorFlag', xml: '      <value type="int" key="vendorFlag">42</value>'}
                    ]
                }
            }]
        };
        const re = parseMwb(writeMwb([db]));
        const reTable = re.databases[0].tables.find(t => t.name === 'users');
        expect(reTable).toBeDefined();
        const captured = (reTable?.wbPassthrough?.values ?? []).map(v => v.key);
        expect(captured.includes('vendorTag')).toBe(true);
        expect(captured.includes('vendorFlag')).toBe(true);
    });

});

describe('writeMwb — Phase E.2 per-routine passthrough', () => {

    /*
     * When the writer is handed a cached XML for a routine.unid it
     * emits those bytes verbatim, only rewriting the owner link to
     * match the current schemaId. Re-parsing keeps the routine
     * recognisable (name, kind, body) — i.e. the cache path doesn't
     * silently drop content.
     */
    it('uses the cached XML and rewrites the owner link to the new schemaId', () => {
        const db: JsonDataDB = {
            unid: 'db-1', name: 'app', type: JsonDataDBType.database, entrys: [],
            tables: [], views: [], enums: [],
            routines: [{
                unid: 'r-cached', name: 'whatever_the_writer_says',
                pos: {x: 0, y: 0}, kind: JsonRoutineKind.procedure,
                body: 'IGNORED — cache takes precedence'
            }]
        };
        const cachedXml = `      <value type="object" struct-name="db.mysql.Routine" id="wb-old-id">
        <value type="string" key="routineType">procedure</value>
        <value type="string" key="sqlDefinition">CREATE PROCEDURE preserved_sql() BEGIN /* untouched */ END</value>
        <value type="string" key="name">preserved_sp</value>
        <value type="string" key="oldName">preserved_sp</value>
        <link type="object" struct-name="GrtObject" key="owner">OLD_SCHEMA_ID</link>
      </value>`;
        const cache = new Map([['r-cached', cachedXml]]);
        const out = writeMwb([db], {routineXmlByUnid: cache});
        const re = parseMwb(out);
        const routines = re.databases[0].routines ?? [];
        const cachedRoutine = routines.find(r => r.name === 'preserved_sp');
        expect(cachedRoutine).toBeDefined();
        expect(cachedRoutine?.body).toBe('CREATE PROCEDURE preserved_sql() BEGIN /* untouched */ END');
        /* The original `whatever_the_writer_says` is *not* in the output — the cache won. */
        expect(routines.find(r => r.name === 'whatever_the_writer_says')).toBeUndefined();

        /* Owner-link rewrite proof: the literal placeholder is gone from the raw XML. */
        const xmlBack = new AdmZip(out).getEntry('document.mwb.xml')!.getData().toString('utf-8');
        expect(xmlBack).not.toContain('OLD_SCHEMA_ID');
    });

    it('falls back to regeneration for routines whose unid is missing from the cache', () => {
        const db: JsonDataDB = {
            unid: 'db-1', name: 'app', type: JsonDataDBType.database, entrys: [],
            tables: [], views: [], enums: [],
            routines: [{
                unid: 'r-fresh', name: 'fresh_sp', pos: {x: 0, y: 0},
                kind: JsonRoutineKind.procedure,
                body: 'CREATE PROCEDURE fresh_sp() BEGIN END'
            }]
        };
        const re = parseMwb(writeMwb([db], {routineXmlByUnid: new Map()}));
        expect(re.databases[0].routines?.[0]?.name).toBe('fresh_sp');
    });

    it('table cache wins over model + pre-mints table/column GRT ids', () => {
        /*
         * The cached XML has table id "grt-tbl-A" and column id
         * "grt-col-A1". The writer should NOT mint a fresh
         * randomUUID() for these — and the resulting document must
         * carry the cached ids so an FK in another table to this
         * column would resolve.
         */
        const db: JsonDataDB = {
            unid: 'db-1', name: 'app', type: JsonDataDBType.database, entrys: [],
            views: [], enums: [], routines: [],
            tables: [{
                unid: 't-cached', name: 'WRITER_TABLE_NAME', pos: {x: 0, y: 0},
                columns: [{unid: 'c-cached', name: 'writer_col', type: 'int'}],
                indexes: [], foreignKeys: []
            }]
        };
        const cachedXml = `      <value type="object" struct-name="db.mysql.Table" id="grt-tbl-A">
        <value type="list" content-type="object" content-struct-name="db.mysql.Column" key="columns">
          <value type="object" struct-name="db.mysql.Column" id="grt-col-A1">
            <value type="string" key="name">cached_id</value>
            <value type="string" key="oldName">cached_id</value>
            <link type="object" struct-name="db.SimpleDatatype" key="simpleType">com.mysql.rdbms.mysql.datatype.int</link>
            <value type="int" key="isNotNull">1</value>
          </value>
        </value>
        <value type="list" content-type="object" content-struct-name="db.mysql.Index" key="indices"/>
        <value type="list" content-type="object" content-struct-name="db.mysql.ForeignKey" key="foreignKeys"/>
        <value type="list" content-type="object" content-struct-name="db.mysql.Trigger" key="triggers"/>
        <value type="string" key="name">cached_table</value>
        <value type="string" key="oldName">cached_table</value>
        <link type="object" struct-name="GrtObject" key="owner">OLD_SCHEMA_X</link>
      </value>`;
        const cache = new Map([['t-cached', {
            xml: cachedXml,
            grtId: 'grt-tbl-A',
            columnGrtIds: ['grt-col-A1']
        }]]);
        const out = writeMwb([db], {tableCacheByUnid: cache});
        const re = parseMwb(out);
        const t = re.databases[0].tables[0];
        expect(t.name).toBe('cached_table');
        expect(t.columns[0]?.name).toBe('cached_id');
        /* Owner placeholder rewritten. */
        const xmlBack = new AdmZip(out).getEntry('document.mwb.xml')!.getData().toString('utf-8');
        expect(xmlBack).not.toContain('OLD_SCHEMA_X');
        /* Cached GRT ids preserved in the document. */
        expect(xmlBack).toContain('id="grt-tbl-A"');
        expect(xmlBack).toContain('id="grt-col-A1"');
    });

    it('view cache wins over model + pre-mints ids.viewId from cached GRT id', () => {
        const db: JsonDataDB = {
            unid: 'db-1', name: 'app', type: JsonDataDBType.database, entrys: [],
            tables: [], enums: [], routines: [],
            views: [{
                unid: 'v-cached', name: 'WRITER_NAME', pos: {x: 0, y: 0},
                select: 'WRITER_BODY'
            }]
        };
        const cachedViewXml = `      <value type="object" struct-name="db.mysql.View" id="wb-view-id-99">
        <value type="string" key="sqlDefinition">SELECT cached_body FROM original</value>
        <value type="string" key="name">preserved_view</value>
        <value type="string" key="oldName">preserved_view</value>
        <link type="object" struct-name="GrtObject" key="owner">OLD_OWNER</link>
      </value>`;
        const out = writeMwb([db], {viewXmlByUnid: new Map([['v-cached', cachedViewXml]])});
        const re = parseMwb(out);
        const v = re.databases[0].views[0];
        expect(v.name).toBe('preserved_view');
        expect(v.select).toBe('SELECT cached_body FROM original');
        /* Owner placeholder gone after rewrite. */
        const xmlBack = new AdmZip(out).getEntry('document.mwb.xml')!.getData().toString('utf-8');
        expect(xmlBack).not.toContain('OLD_OWNER');
        /* Cached id is what the document carries (proves ids.viewId pre-mint). */
        expect(xmlBack).toContain('id="wb-view-id-99"');
    });

});