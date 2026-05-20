/*
 * End-to-end test of the .mwb import against the sample/example.mwb
 * file shipped with the repo. The sample is a small synthetic demo
 * schema (`demo` — users / posts / comments / categories with one FK
 * chain and one EER diagram) — small enough to assert exact counts
 * against, large enough to exercise the same code paths that real
 * Workbench output traverses.
 *
 * Phase B/E tests (views / routines / triggers / passthrough) build
 * synthetic .mwb fixtures inline because the demo sample doesn't
 * include those entities by design.
 */
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';
// eslint-disable-next-line import/extensions
import AdmZip from 'adm-zip';
import {MwbReader} from '../../../BundledPlugins/Mwb/MwbReader.js';
import {JsonDataDBType, JsonRoutineKind} from '../../../DbEditor/JsonData.js';

const SAMPLE = path.resolve(__dirname, '../../../sample/example.mwb');

describe('MwbReader.parse — example.mwb integration', () => {

    it('extracts exactly one schema named "demo"', () => {
        const buf = fs.readFileSync(SAMPLE);
        const r = MwbReader.parse(buf);
        expect(r.schemaCount).toBe(1);
        expect(r.databases[0].name).toBe('demo');
        expect(r.databases[0].type).toBe(JsonDataDBType.database);
    });

    it('the schema has 4 tables', () => {
        const r = MwbReader.parse(fs.readFileSync(SAMPLE));
        expect(r.databases[0].tables).toHaveLength(4);
        expect(r.tableCount).toBe(4);
    });

    it('every table has at least one column', () => {
        const r = MwbReader.parse(fs.readFileSync(SAMPLE));
        for (const t of r.databases[0].tables) {
            expect(t.columns.length).toBeGreaterThan(0);
        }
    });

    it('aggregate column count matches the demo schema (17 columns total)', () => {
        const r = MwbReader.parse(fs.readFileSync(SAMPLE));
        expect(r.columnCount).toBe(17);
    });

    it('aggregate FK count matches the demo schema (3 FKs total)', () => {
        const r = MwbReader.parse(fs.readFileSync(SAMPLE));
        expect(r.foreignKeyCount).toBe(3);
    });

    it('every FK refTableUnid resolves to a real table in the result', () => {
        const r = MwbReader.parse(fs.readFileSync(SAMPLE));
        const tableUnids = new Set(r.databases[0].tables.map(t => t.unid));
        for (const t of r.databases[0].tables) {
            for (const fk of t.foreignKeys) {
                expect(tableUnids.has(fk.refTableUnid)).toBe(true);
            }
        }
    });

    it('FK columns resolve to columns on the local AND remote tables', () => {
        const r = MwbReader.parse(fs.readFileSync(SAMPLE));
        const tablesByUnid = new Map(r.databases[0].tables.map(t => [t.unid, t]));
        for (const t of r.databases[0].tables) {
            const localCols = new Set(t.columns.map(c => c.unid));
            for (const fk of t.foreignKeys) {
                const refTable = tablesByUnid.get(fk.refTableUnid);
                expect(refTable).toBeDefined();
                const refCols = new Set(refTable!.columns.map(c => c.unid));
                for (const pair of fk.columns) {
                    expect(localCols.has(pair.columnUnid)).toBe(true);
                    expect(refCols.has(pair.refColumnUnid)).toBe(true);
                }
            }
        }
    });

    it('PRIMARY indexes are surfaced as column.primaryKey flags, not as JsonIndex entries', () => {
        const r = MwbReader.parse(fs.readFileSync(SAMPLE));
        for (const t of r.databases[0].tables) {
            /* No surfaced index should be named PRIMARY — the editor models PKs at the column. */
            for (const ix of t.indexes) {
                expect(ix.name.toUpperCase()).not.toBe('PRIMARY');
            }
        }
        /* And there should be at least some tables with a marked primary-key column. */
        const tablesWithPk = r.databases[0].tables.filter(t => t.columns.some(c => c.primaryKey));
        expect(tablesWithPk.length).toBeGreaterThan(0);
    });

    it('parseAsFsRoot wraps databases under a root node ready for replaceFs', () => {
        const buf = fs.readFileSync(SAMPLE);
        const {fs: root, stats} = MwbReader.parseAsFsRoot(buf);
        expect(root.unid).toBe('root');
        expect(root.type).toBe(JsonDataDBType.root);
        expect(root.entrys).toHaveLength(stats.schemaCount);
        const firstDb = root.entrys[0] as {name: string;};
        expect(firstDb.name).toBe('demo');
    });

    /*
     * Phase C — canvas positions. The demo sample places every table
     * via a TableFigure so positionedTableCount should match
     * tableCount; positions must be non-default integers.
     */
    it('positionedTableCount reports tables placed from a TableFigure', () => {
        const r = MwbReader.parse(fs.readFileSync(SAMPLE));
        expect(r.positionedTableCount).toBe(4);
    });

    it('every table receives a non-default position from its figure', () => {
        const r = MwbReader.parse(fs.readFileSync(SAMPLE));
        const placed = r.databases[0].tables.filter(t => t.pos.x !== 80 || t.pos.y !== 80);
        expect(placed.length).toBe(4);
    });

    it('imported positions are integer pixel coordinates', () => {
        const r = MwbReader.parse(fs.readFileSync(SAMPLE));
        for (const t of r.databases[0].tables) {
            expect(Number.isInteger(t.pos.x)).toBe(true);
            expect(Number.isInteger(t.pos.y)).toBe(true);
        }
    });

    it('no two tables share an exact (x, y) position', () => {
        /*
         * Per-diagram tiling sanity: collapsing several diagrams into
         * one coordinate space used to cause overlapping positions.
         * Demo sample has one diagram with four well-separated cards;
         * if anything ever regresses to "stack everything at (80,80)"
         * this trips.
         */
        const r = MwbReader.parse(fs.readFileSync(SAMPLE));
        const seen = new Map<string, string>();
        const collisions: string[] = [];
        for (const t of r.databases[0].tables) {
            const key = `${t.pos.x},${t.pos.y}`;
            const prior = seen.get(key);
            if (prior) {collisions.push(`${prior} ↔ ${t.name} both at (${key})`);}
            else {seen.set(key, t.name);}
        }
        expect(collisions).toEqual([]);
    });

    it('imports the authored Workbench Layer ("Authoring") as a JsonLayer with bounds', () => {
        const r = MwbReader.parse(fs.readFileSync(SAMPLE));
        const layers = r.databases[0].layers ?? [];
        expect(layers.length).toBeGreaterThanOrEqual(1);
        const authoring = layers.find(l => l.name === 'Authoring');
        expect(authoring).toBeDefined();
        expect(authoring!.unid).toBeTruthy();
        expect(authoring!.diagramUnid).toBeTruthy();
        expect(authoring!.width).toBeGreaterThan(0);
        expect(authoring!.height).toBeGreaterThan(0);
    });

    it('every imported JsonLayer points at a real JsonDiagram parent', () => {
        const r = MwbReader.parse(fs.readFileSync(SAMPLE));
        const diagramUnids = new Set((r.databases[0].diagrams ?? []).map(d => d.unid));
        for (const l of r.databases[0].layers ?? []) {
            expect(diagramUnids).toContain(l.diagramUnid);
        }
    });

    it('every table belongs to its parent Workbench diagram (via diagramUnid)', () => {
        const r = MwbReader.parse(fs.readFileSync(SAMPLE));
        const diagrams = r.databases[0].diagrams ?? [];
        expect(diagrams.length).toBeGreaterThanOrEqual(1);
        const diagramUnids = new Set(diagrams.map(d => d.unid));
        const taggedTables = r.databases[0].tables.filter(t => t.diagramUnid && diagramUnids.has(t.diagramUnid));
        expect(taggedTables.length).toBeGreaterThanOrEqual(2);
    });

    it('positions land in the diagram coordinate space (not all clustered at fallback)', () => {
        const r = MwbReader.parse(fs.readFileSync(SAMPLE));
        const xs = r.databases[0].tables.map(t => t.pos.x);
        const ys = r.databases[0].tables.map(t => t.pos.y);
        const spanX = Math.max(...xs) - Math.min(...xs);
        const spanY = Math.max(...ys) - Math.min(...ys);
        expect(spanX).toBeGreaterThan(100);
        expect(spanY).toBeGreaterThan(100);
    });

    it('a second parse produces identical positions for every table (deterministic)', () => {
        const a = MwbReader.parse(fs.readFileSync(SAMPLE));
        const b = MwbReader.parse(fs.readFileSync(SAMPLE));
        const aByName = new Map(a.databases[0].tables.map(t => [t.name, t.pos]));
        for (const t of b.databases[0].tables) {
            const ap = aByName.get(t.name);
            expect(ap).toBeDefined();
            expect(ap!.x).toBe(t.pos.x);
            expect(ap!.y).toBe(t.pos.y);
        }
    });

});

/*
 * Phase B — views + routines + triggers
 *
 * Build small synthetic .mwb files (zip with one `document.mwb.xml`
 * member) to exercise the parsers — the demo sample carries one view
 * but no routines/triggers. The XML wrapper mirrors the path the real
 * parser walks:
 *   data > workbench.Document > workbench.physical.Model > db.mysql.Catalog
 *     > db.mysql.Schema > views[] / routines[] / tables[] > triggers[]
 */

const wrap = (schemaInner: string): Buffer => {
    const xml = `<?xml version="1.0"?>
<data>
  <value type="object" struct-name="workbench.Document" id="doc1">
    <value type="list" content-type="object" content-struct-name="workbench.physical.Model" key="physicalModels">
      <value type="object" struct-name="workbench.physical.Model" id="pm1">
        <value type="object" struct-name="db.mysql.Catalog" key="catalog" id="cat1">
          <value type="list" content-type="object" content-struct-name="db.mysql.Schema" key="schemata">
            <value type="object" struct-name="db.mysql.Schema" id="sch1">
              <value type="string" key="name">testdb</value>
              ${schemaInner}
            </value>
          </value>
        </value>
      </value>
    </value>
  </value>
</data>`;
    const zip = new AdmZip();
    zip.addFile('document.mwb.xml', Buffer.from(xml, 'utf-8'));
    return zip.toBuffer();
};

describe('MwbReader.parse — views (synthetic)', () => {

    it('imports a single view with name + SELECT body', () => {
        const r = MwbReader.parse(wrap(`
          <value type="list" content-type="object" content-struct-name="db.mysql.View" key="views">
            <value type="object" struct-name="db.mysql.View" id="v1">
              <value type="string" key="name">active_users</value>
              <value type="string" key="sqlDefinition">SELECT id, name FROM users WHERE active = 1</value>
            </value>
          </value>
        `));
        expect(r.viewCount).toBe(1);
        expect(r.databases[0].views).toHaveLength(1);
        const v = r.databases[0].views[0];
        expect(v.name).toBe('active_users');
        expect(v.select).toBe('SELECT id, name FROM users WHERE active = 1');
    });

    it('strips a leading "CREATE [...] VIEW name AS" prefix from sqlDefinition', () => {
        const r = MwbReader.parse(wrap(`
          <value type="list" content-type="object" content-struct-name="db.mysql.View" key="views">
            <value type="object" struct-name="db.mysql.View" id="v1">
              <value type="string" key="name">v1</value>
              <value type="string" key="sqlDefinition">CREATE OR REPLACE ALGORITHM=UNDEFINED DEFINER=\`root\`@\`%\` SQL SECURITY DEFINER VIEW \`v1\` AS select 1 as x</value>
            </value>
          </value>
        `));
        expect(r.databases[0].views[0].select).toBe('select 1 as x');
    });

    it('passes through view comment as description', () => {
        const r = MwbReader.parse(wrap(`
          <value type="list" content-type="object" content-struct-name="db.mysql.View" key="views">
            <value type="object" struct-name="db.mysql.View" id="v1">
              <value type="string" key="name">v1</value>
              <value type="string" key="sqlDefinition">SELECT 1</value>
              <value type="string" key="comment">cached daily snapshot</value>
            </value>
          </value>
        `));
        expect(r.databases[0].views[0].description).toBe('cached daily snapshot');
    });

});

describe('MwbReader.parse — routines (synthetic)', () => {

    it('imports procedures and functions with the right kind', () => {
        const r = MwbReader.parse(wrap(`
          <value type="list" content-type="object" content-struct-name="db.mysql.Routine" key="routines">
            <value type="object" struct-name="db.mysql.Routine" id="r1">
              <value type="string" key="name">sp_calc</value>
              <value type="string" key="routineType">procedure</value>
              <value type="string" key="sqlDefinition">CREATE PROCEDURE sp_calc() BEGIN SELECT 1; END</value>
            </value>
            <value type="object" struct-name="db.mysql.Routine" id="r2">
              <value type="string" key="name">fn_sum</value>
              <value type="string" key="routineType">function</value>
              <value type="string" key="sqlDefinition">CREATE FUNCTION fn_sum(a INT, b INT) RETURNS INT RETURN a + b</value>
            </value>
          </value>
        `));
        expect(r.routineCount).toBe(2);
        const list = r.databases[0].routines ?? [];
        expect(list).toHaveLength(2);
        expect(list[0]).toMatchObject({name: 'sp_calc', kind: JsonRoutineKind.procedure});
        expect(list[1]).toMatchObject({name: 'fn_sum', kind: JsonRoutineKind.function});
        expect(list[0].body).toContain('BEGIN');
    });

    it('routineType case is normalised', () => {
        const r = MwbReader.parse(wrap(`
          <value type="list" content-type="object" content-struct-name="db.mysql.Routine" key="routines">
            <value type="object" struct-name="db.mysql.Routine" id="r1">
              <value type="string" key="name">F</value>
              <value type="string" key="routineType">FUNCTION</value>
              <value type="string" key="sqlDefinition">x</value>
            </value>
          </value>
        `));
        expect((r.databases[0].routines ?? [])[0].kind).toBe(JsonRoutineKind.function);
    });

});

describe('MwbReader.parse — triggers (synthetic)', () => {

    it('triggers nested in a table land in the schema-level routines list with kind=trigger', () => {
        const r = MwbReader.parse(wrap(`
          <value type="list" content-type="object" content-struct-name="db.mysql.Table" key="tables">
            <value type="object" struct-name="db.mysql.Table" id="t1">
              <value type="string" key="name">orders</value>
              <value type="list" content-type="object" content-struct-name="db.mysql.Trigger" key="triggers">
                <value type="object" struct-name="db.mysql.Trigger" id="tg1">
                  <value type="string" key="name">trg_audit</value>
                  <value type="string" key="event">INSERT</value>
                  <value type="string" key="timing">AFTER</value>
                  <value type="string" key="sqlDefinition">CREATE TRIGGER trg_audit AFTER INSERT ON orders FOR EACH ROW INSERT INTO audit (...) VALUES (...)</value>
                </value>
              </value>
            </value>
          </value>
        `));
        expect(r.triggerCount).toBe(1);
        expect(r.routineCount).toBe(0);
        const routines = r.databases[0].routines ?? [];
        expect(routines).toHaveLength(1);
        expect(routines[0]).toMatchObject({name: 'trg_audit', kind: JsonRoutineKind.trigger});
        expect(routines[0].body).toContain('AFTER INSERT');
    });

    it('routines and triggers coexist; procedures/functions come first, triggers last', () => {
        const r = MwbReader.parse(wrap(`
          <value type="list" content-type="object" content-struct-name="db.mysql.Table" key="tables">
            <value type="object" struct-name="db.mysql.Table" id="t1">
              <value type="string" key="name">t</value>
              <value type="list" content-type="object" content-struct-name="db.mysql.Trigger" key="triggers">
                <value type="object" struct-name="db.mysql.Trigger" id="tg1">
                  <value type="string" key="name">trg_x</value>
                  <value type="string" key="sqlDefinition">body</value>
                </value>
              </value>
            </value>
          </value>
          <value type="list" content-type="object" content-struct-name="db.mysql.Routine" key="routines">
            <value type="object" struct-name="db.mysql.Routine" id="r1">
              <value type="string" key="name">sp_a</value>
              <value type="string" key="routineType">procedure</value>
              <value type="string" key="sqlDefinition">body</value>
            </value>
          </value>
        `));
        const list = r.databases[0].routines ?? [];
        expect(list).toHaveLength(2);
        expect(list[0].kind).toBe(JsonRoutineKind.procedure);
        expect(list[1].kind).toBe(JsonRoutineKind.trigger);
    });

});

describe('MwbReader.parse — empty schema', () => {

    it('returns viewCount/routineCount/triggerCount = 0 when none present', () => {
        const r = MwbReader.parse(wrap(''));
        expect(r.viewCount).toBe(0);
        expect(r.routineCount).toBe(0);
        expect(r.triggerCount).toBe(0);
    });

});

/*
 * Phase E — wbPassthrough capture. Real Workbench `.mwb` files carry
 * many child values per entity that we don't model (`isStub`,
 * `customData`, extension flags, …). The demo sample doesn't include
 * these (it's written by our own writer which has no unknowns to
 * pass through), so capture is exercised via synthetic XML fragments
 * that hand-craft known + unknown keys side-by-side.
 */
describe('MwbReader.parse — Phase E passthrough capture', () => {

    it('captures unknown schema-level keys into wbPassthrough', () => {
        const r = MwbReader.parse(wrap(`
          <value type="string" key="customData">vendor-specific</value>
          <value type="int" key="vendorFlag">42</value>
        `));
        const db = r.databases[0];
        expect(db.wbPassthrough).toBeDefined();
        const keys = (db.wbPassthrough?.values ?? []).map(v => v.key).sort();
        expect(keys).toContain('customData');
        expect(keys).toContain('vendorFlag');
    });

    it('captures unknown table-level keys', () => {
        const r = MwbReader.parse(wrap(`
          <value type="list" content-type="object" content-struct-name="db.mysql.Table" key="tables">
            <value type="object" struct-name="db.mysql.Table" id="t1">
              <value type="string" key="name">orders</value>
              <value type="string" key="customAuthor">jdoe</value>
              <value type="int" key="vendorRev">7</value>
            </value>
          </value>
        `));
        const t = r.databases[0].tables[0];
        const keys = (t.wbPassthrough?.values ?? []).map(v => v.key).sort();
        expect(keys).toContain('customAuthor');
        expect(keys).toContain('vendorRev');
    });

    it('does NOT capture keys we already model into passthrough', () => {
        const r = MwbReader.parse(wrap(`
          <value type="list" content-type="object" content-struct-name="db.mysql.Table" key="tables">
            <value type="object" struct-name="db.mysql.Table" id="t1">
              <value type="string" key="name">orders</value>
              <value type="string" key="tableEngine">InnoDB</value>
              <value type="string" key="comment">order rows</value>
              <value type="string" key="vendorTag">extra</value>
            </value>
          </value>
        `));
        const t = r.databases[0].tables[0];
        const captured = (t.wbPassthrough?.values ?? []).map(v => v.key);
        for (const modelled of ['name', 'columns', 'indexes', 'foreignKeys', 'triggers', 'tableEngine', 'comment']) {
            expect(captured.includes(modelled)).toBe(false);
        }
        expect(captured).toContain('vendorTag');
    });

    it('captures unknown column-level keys', () => {
        const r = MwbReader.parse(wrap(`
          <value type="list" content-type="object" content-struct-name="db.mysql.Table" key="tables">
            <value type="object" struct-name="db.mysql.Table" id="t1">
              <value type="string" key="name">orders</value>
              <value type="list" content-type="object" content-struct-name="db.mysql.Column" key="columns">
                <value type="object" struct-name="db.mysql.Column" id="c1">
                  <value type="string" key="name">id</value>
                  <value type="int" key="precision">10</value>
                  <value type="string" key="vendorClass">primary</value>
                </value>
              </value>
            </value>
          </value>
        `));
        const col = r.databases[0].tables[0].columns[0];
        const captured = (col.wbPassthrough?.values ?? []).map(v => v.key);
        expect(captured).toContain('vendorClass');
        for (const modelled of ['name', 'simpleType', 'length', 'isNotNull', 'comment', 'autoIncrement']) {
            expect(captured.includes(modelled)).toBe(false);
        }
    });

    it('lifts schema-level defaultCharset / defaultCollation onto JsonDataDB (synthetic)', () => {
        const r = MwbReader.parse(wrap(`
          <value type="string" key="defaultCharacterSetName">utf8mb4</value>
          <value type="string" key="defaultCollationName">utf8mb4_unicode_ci</value>
        `));
        const db = r.databases[0];
        expect(db.defaultCharset).toBe('utf8mb4');
        expect(db.defaultCollation).toBe('utf8mb4_unicode_ci');
    });

    it('leaves defaults unset when schema declares them as empty strings', () => {
        /*
         * Workbench frequently writes `<value type="string" key="defaultCharacterSetName"></value>`
         * meaning "no schema-level default". The reader treats empty
         * as "not set" so user-defined defaults stay free.
         */
        const r = MwbReader.parse(wrap(`
          <value type="string" key="defaultCharacterSetName"></value>
          <value type="string" key="defaultCollationName"></value>
        `));
        const db = r.databases[0];
        expect(db.defaultCharset).toBeUndefined();
        expect(db.defaultCollation).toBeUndefined();
    });

    it('does NOT also capture defaultCharacterSetName/defaultCollationName into passthrough', () => {
        const r = MwbReader.parse(wrap(`
          <value type="string" key="defaultCharacterSetName">utf8mb4</value>
          <value type="string" key="defaultCollationName">utf8mb4_unicode_ci</value>
        `));
        const keys = (r.databases[0].wbPassthrough?.values ?? []).map(v => v.key);
        expect(keys.includes('defaultCharacterSetName')).toBe(false);
        expect(keys.includes('defaultCollationName')).toBe(false);
    });

});

/*
 * View canvas positions — ViewFigure parallel to TableFigure. The
 * synthetic wrapper below adds a `diagrams` sibling next to `catalog`
 * inside the physical model, holding one Diagram with hand-authored
 * figures. The reader's `findStructs` walks the whole document, but
 * the per-diagram tiling logic groups figures by their `owner` link,
 * so figures need a proper Diagram parent to land in the same
 * coordinate bucket as their fellow figures.
 */
const wrapWithDiagrams = (schemaInner: string, diagramsInner: string): Buffer => {
    const xml = `<?xml version="1.0"?>
<data>
  <value type="object" struct-name="workbench.Document" id="doc1">
    <value type="list" content-type="object" content-struct-name="workbench.physical.Model" key="physicalModels">
      <value type="object" struct-name="workbench.physical.Model" id="pm1">
        <value type="object" struct-name="db.mysql.Catalog" key="catalog" id="cat1">
          <value type="list" content-type="object" content-struct-name="db.mysql.Schema" key="schemata">
            <value type="object" struct-name="db.mysql.Schema" id="sch1">
              <value type="string" key="name">testdb</value>
              ${schemaInner}
            </value>
          </value>
        </value>
        <value type="list" content-type="object" content-struct-name="workbench.physical.Diagram" key="diagrams">
          ${diagramsInner}
        </value>
      </value>
    </value>
  </value>
</data>`;
    const zip = new AdmZip();
    zip.addFile('document.mwb.xml', Buffer.from(xml, 'utf-8'));
    return zip.toBuffer();
};

describe('MwbReader.parse — view positions (synthetic)', () => {

    it('reads a ViewFigure into JsonView.pos and counts it as positioned', () => {
        const r = MwbReader.parse(wrapWithDiagrams(
            `<value type="list" content-type="object" content-struct-name="db.mysql.View" key="views">
                <value type="object" struct-name="db.mysql.View" id="v1">
                    <value type="string" key="name">active_users</value>
                    <value type="string" key="sqlDefinition">SELECT 1</value>
                </value>
            </value>`,
            `<value type="object" struct-name="workbench.physical.Diagram" id="d1">
                <value type="string" key="name">Main</value>
                <value type="list" content-type="object" content-struct-name="model.Figure" key="figures">
                    <value type="object" struct-name="workbench.physical.ViewFigure" id="vf1">
                        <value type="real" key="left">420</value>
                        <value type="real" key="top">240</value>
                        <link type="object" struct-name="db.View" key="view">v1</link>
                        <link type="object" struct-name="model.Diagram" key="owner">d1</link>
                        <value type="string" key="name">active_users</value>
                    </value>
                </value>
            </value>`
        ));
        expect(r.positionedViewCount).toBe(1);
        expect(r.databases[0].views[0].pos).toEqual({x: 420, y: 240});
    });

    it('falls back to (80, 80) when a view has no ViewFigure', () => {
        const r = MwbReader.parse(wrap(`
          <value type="list" content-type="object" content-struct-name="db.mysql.View" key="views">
            <value type="object" struct-name="db.mysql.View" id="v1">
              <value type="string" key="name">orphan_view</value>
              <value type="string" key="sqlDefinition">SELECT 1</value>
            </value>
          </value>
        `));
        expect(r.positionedViewCount).toBe(0);
        expect(r.databases[0].views[0].pos).toEqual({x: 80, y: 80});
    });

    it('rounds real-valued ViewFigure coordinates to integers', () => {
        const r = MwbReader.parse(wrapWithDiagrams(
            `<value type="list" content-type="object" content-struct-name="db.mysql.View" key="views">
                <value type="object" struct-name="db.mysql.View" id="v1">
                    <value type="string" key="name">v1</value>
                    <value type="string" key="sqlDefinition">SELECT 1</value>
                </value>
            </value>`,
            `<value type="object" struct-name="workbench.physical.Diagram" id="d1">
                <value type="list" content-type="object" content-struct-name="model.Figure" key="figures">
                    <value type="object" struct-name="workbench.physical.ViewFigure" id="vf1">
                        <value type="real" key="left">123.6</value>
                        <value type="real" key="top">87.4</value>
                        <link type="object" struct-name="db.View" key="view">v1</link>
                        <link type="object" struct-name="model.Diagram" key="owner">d1</link>
                    </value>
                </value>
            </value>`
        ));
        const v = r.databases[0].views[0];
        expect(Number.isInteger(v.pos.x)).toBe(true);
        expect(Number.isInteger(v.pos.y)).toBe(true);
        expect(v.pos).toEqual({x: 124, y: 87});
    });

});

describe('MwbReader.parse — multi-diagram table membership (synthetic)', () => {

    /*
     * Sample: one table appears as a TableFigure in two diagrams. The
     * first figure's coords become the table's primary `pos` and
     * `diagramUnid` (pointing at the first synthesised diagram-diagram);
     * the second figure becomes a `diagramPlacements` entry referencing
     * the second diagram-diagram. Position records its own coords
     * (post-tiling) so the table sits at the right spot on each
     * diagram.
     */
    it('records the second figure as a diagramPlacements entry', () => {
        const r = MwbReader.parse(wrapWithDiagrams(
            `<value type="list" content-type="object" content-struct-name="db.mysql.Table" key="tables">
                <value type="object" struct-name="db.mysql.Table" id="t1">
                    <value type="string" key="name">users</value>
                    <value type="list" content-type="object" content-struct-name="db.mysql.Column" key="columns"/>
                </value>
            </value>`,
            `<value type="object" struct-name="workbench.physical.Diagram" id="d1">
                <value type="string" key="name">Schema A</value>
                <value type="list" content-type="object" content-struct-name="model.Figure" key="figures">
                    <value type="object" struct-name="workbench.physical.TableFigure" id="tf1a">
                        <value type="real" key="left">100</value>
                        <value type="real" key="top">100</value>
                        <link type="object" struct-name="db.Table" key="table">t1</link>
                        <link type="object" struct-name="model.Diagram" key="owner">d1</link>
                    </value>
                </value>
            </value>
            <value type="object" struct-name="workbench.physical.Diagram" id="d2">
                <value type="string" key="name">Schema B</value>
                <value type="list" content-type="object" content-struct-name="model.Figure" key="figures">
                    <value type="object" struct-name="workbench.physical.TableFigure" id="tf1b">
                        <value type="real" key="left">50</value>
                        <value type="real" key="top">200</value>
                        <link type="object" struct-name="db.Table" key="table">t1</link>
                        <link type="object" struct-name="model.Diagram" key="owner">d2</link>
                    </value>
                </value>
            </value>`
        ));
        expect(r.multiDiagramTableCount).toBe(1);
        const table = r.databases[0].tables[0];
        const layers = r.databases[0].diagrams ?? [];
        expect(layers.length).toBe(2);
        const primaryLayer = layers.find(l => l.unid === table.diagramUnid);
        expect(primaryLayer?.name).toBe('Schema A');
        expect(table.pos).toEqual({x: 100, y: 100});

        const placements = table.diagramPlacements ?? [];
        expect(placements).toHaveLength(1);
        const secondaryLayer = layers.find(l => l.unid === placements[0].diagramUnid);
        expect(secondaryLayer?.name).toBe('Schema B');
        /* Second diagram's coords are shifted past the first diagram's bbox + GAP. */
        expect(placements[0].pos.x).toBeGreaterThan(100);
        expect(placements[0].pos.y).toBe(200);
    });

    it('leaves single-diagram tables with no diagramPlacements', () => {
        const r = MwbReader.parse(wrapWithDiagrams(
            `<value type="list" content-type="object" content-struct-name="db.mysql.Table" key="tables">
                <value type="object" struct-name="db.mysql.Table" id="t1">
                    <value type="string" key="name">solo</value>
                    <value type="list" content-type="object" content-struct-name="db.mysql.Column" key="columns"/>
                </value>
            </value>`,
            `<value type="object" struct-name="workbench.physical.Diagram" id="d1">
                <value type="list" content-type="object" content-struct-name="model.Figure" key="figures">
                    <value type="object" struct-name="workbench.physical.TableFigure" id="tf1">
                        <value type="real" key="left">10</value>
                        <value type="real" key="top">20</value>
                        <link type="object" struct-name="db.Table" key="table">t1</link>
                        <link type="object" struct-name="model.Diagram" key="owner">d1</link>
                    </value>
                </value>
            </value>`
        ));
        expect(r.multiDiagramTableCount).toBe(0);
        expect(r.databases[0].tables[0].diagramPlacements).toBeUndefined();
    });

});