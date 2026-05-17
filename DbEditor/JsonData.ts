import {ExtractSchemaResultType, Vts} from 'vts';

/*
 * ---------------------------------------------------------------------------
 * Tree node types
 * ---------------------------------------------------------------------------
 */

/**
 * Treeview node kinds. The on-disk JSON tree mirrors the editor's left panel:
 * a single `root` containing `database` nodes; a database contains `folder`s
 * and `table`/`view`/`enum` nodes.
 */
export enum JsonDataDBType {
    root = 'root',
    project = 'project',
    database = 'database',
    folder = 'folder',
    table = 'table',
    view = 'view',
    enum = 'enum',
    routine = 'routine',
    diagram = 'diagram'
}

export enum JsonRoutineKind {
    procedure = 'procedure',
    function = 'function',
    trigger = 'trigger'
}

/*
 * ---------------------------------------------------------------------------
 * Position on canvas
 * ---------------------------------------------------------------------------
 */

export const SchemaJsonPosition = Vts.object({
    x: Vts.number(),
    y: Vts.number()
});
export type JsonPosition = ExtractSchemaResultType<typeof SchemaJsonPosition>;

/*
 * ---------------------------------------------------------------------------
 * Workbench .mwb round-trip passthrough
 *
 * When importing a `.mwb` file, MwbReader consumes the GRT XML fields we
 * model (name, columns, options, …) and historically dropped everything
 * else (custom flags, vendor extension fields, table-figure colours, …).
 * `wbPassthrough` is an opaque container for those leftovers: the reader
 * stashes any `<value key="X">…</value>` or `<link key="X">UUID</link>`
 * child whose `X` we don't recognise, plus unknown attributes on the
 * entity's open tag. The writer re-emits the captured XML verbatim
 * alongside the modelled fields, so an open + save round-trip preserves
 * vendor data without our model needing to grow per-extension fields.
 *
 * Optional + back-compat: pre-Phase-E schema files don't carry the field
 * and validate fine. Entities created in the editor (vs. imported) have
 * no passthrough.
 * ---------------------------------------------------------------------------
 */
export const SchemaWbPassthrough = Vts.object({
    /**
     * Unknown `<value>` / `<link>` children, one entry per unrecognised
     * key. The `xml` string is the verbatim serialised element (no
     * surrounding whitespace) and the writer splices it back at the
     * correct indent.
     */
    values: Vts.optional(Vts.array(Vts.object({
        key: Vts.string(),
        xml: Vts.string()
    }))),
    /** Unknown attributes on the entity's open tag, by attribute name. */
    attrs: Vts.optional(Vts.array(Vts.object({
        name: Vts.string(),
        value: Vts.string()
    })))
});
export type JsonWbPassthrough = ExtractSchemaResultType<typeof SchemaWbPassthrough>;

/*
 * ---------------------------------------------------------------------------
 * Column
 * ---------------------------------------------------------------------------
 */

/**
 * Reference attribute / generation behaviour for a column.
 * Most flags map 1:1 to one or more dialects. The generator's job is to
 * translate them per dialect (e.g. `autoIncrement` → `AUTO_INCREMENT` on
 * MySQL, `SERIAL` / `IDENTITY` on Postgres, `AUTOINCREMENT` on SQLite).
 */
export const SchemaJsonColumn = Vts.object({
    unid: Vts.string(),
    name: Vts.string(),
    /**
     * Logical type name. The dialect resolver maps it to the concrete SQL
     * type. Examples: `int`, `bigint`, `varchar`, `text`, `decimal`, `bool`,
     * `datetime`, `date`, `time`, `timestamp`, `json`, `uuid`, `enum`.
     */
    type: Vts.string(),
    /** Optional length / precision / scale (e.g. `255`, `10,2`). */
    length: Vts.optional(Vts.string()),
    /** For `enum` type: the unid of the JsonEnum to use. */
    enumRef: Vts.optional(Vts.string()),
    notNull: Vts.optional(Vts.boolean()),
    primaryKey: Vts.optional(Vts.boolean()),
    autoIncrement: Vts.optional(Vts.boolean()),
    unique: Vts.optional(Vts.boolean()),
    unsigned: Vts.optional(Vts.boolean()),
    /** Default expression (raw SQL). `'CURRENT_TIMESTAMP'`, `'0'`, `"'foo'"`. */
    defaultValue: Vts.optional(Vts.string()),
    /** Generated/computed column expression (raw SQL). */
    generatedExpression: Vts.optional(Vts.string()),
    generatedStored: Vts.optional(Vts.boolean()),
    collation: Vts.optional(Vts.string()),
    charset: Vts.optional(Vts.string()),
    comment: Vts.optional(Vts.string()),
    wbPassthrough: Vts.optional(SchemaWbPassthrough)
});
export type JsonColumn = ExtractSchemaResultType<typeof SchemaJsonColumn>;

/*
 * ---------------------------------------------------------------------------
 * Index
 * ---------------------------------------------------------------------------
 */

export enum JsonIndexType {
    index = 'index',
    unique = 'unique',
    fulltext = 'fulltext',
    spatial = 'spatial'
}

export const SchemaJsonIndexColumn = Vts.object({
    columnUnid: Vts.string(),
    /** ASC|DESC, default ASC. */
    order: Vts.optional(Vts.string()),
    /** Optional prefix length (mysql). */
    length: Vts.optional(Vts.number())
});
export type JsonIndexColumn = ExtractSchemaResultType<typeof SchemaJsonIndexColumn>;

export const SchemaJsonIndex = Vts.object({
    unid: Vts.string(),
    name: Vts.string(),
    type: Vts.or([Vts.enum(JsonIndexType), Vts.string()]),
    columns: Vts.array(SchemaJsonIndexColumn),
    /** Optional WHERE for partial indexes (postgres / sqlite). */
    where: Vts.optional(Vts.string()),
    comment: Vts.optional(Vts.string()),
    wbPassthrough: Vts.optional(SchemaWbPassthrough)
});
export type JsonIndex = ExtractSchemaResultType<typeof SchemaJsonIndex>;

/*
 * ---------------------------------------------------------------------------
 * Foreign key
 * ---------------------------------------------------------------------------
 */

export enum JsonForeignKeyAction {
    no_action = 'NO ACTION',
    restrict = 'RESTRICT',
    cascade = 'CASCADE',
    set_null = 'SET NULL',
    set_default = 'SET DEFAULT'
}

export const SchemaJsonForeignKeyColumn = Vts.object({
    columnUnid: Vts.string(),
    refColumnUnid: Vts.string()
});
export type JsonForeignKeyColumn = ExtractSchemaResultType<typeof SchemaJsonForeignKeyColumn>;

export const SchemaJsonForeignKey = Vts.object({
    unid: Vts.string(),
    name: Vts.string(),
    /** unid of the referenced table (in any database in this project). */
    refTableUnid: Vts.string(),
    columns: Vts.array(SchemaJsonForeignKeyColumn),
    onDelete: Vts.optional(Vts.or([Vts.enum(JsonForeignKeyAction), Vts.string()])),
    onUpdate: Vts.optional(Vts.or([Vts.enum(JsonForeignKeyAction), Vts.string()])),
    comment: Vts.optional(Vts.string()),
    wbPassthrough: Vts.optional(SchemaWbPassthrough)
});
export type JsonForeignKey = ExtractSchemaResultType<typeof SchemaJsonForeignKey>;

/*
 * ---------------------------------------------------------------------------
 * Table options (storage / engine / charset / etc.)
 * ---------------------------------------------------------------------------
 */

export const SchemaJsonTableOptions = Vts.object({
    /** MySQL/MariaDB engine (InnoDB, MyISAM, ...) */
    engine: Vts.optional(Vts.string()),
    /** Default charset. */
    charset: Vts.optional(Vts.string()),
    /** Default collation. */
    collation: Vts.optional(Vts.string()),
    /** Postgres tablespace, or generic schema/namespace name. */
    tablespace: Vts.optional(Vts.string()),
    /** Postgres only — declare as UNLOGGED or TEMPORARY. */
    persistence: Vts.optional(Vts.string()),
    comment: Vts.optional(Vts.string())
});
export type JsonTableOptions = ExtractSchemaResultType<typeof SchemaJsonTableOptions>;

/*
 * ---------------------------------------------------------------------------
 * Table
 * ---------------------------------------------------------------------------
 */

/**
 * One placement of a table inside a specific EER diagram.
 * Multi-diagram membership: a table can carry zero, one, or many of
 * these. Each entry says "in diagram X, render this card at this
 * position". The position is independent across diagrams — moving the
 * card while a diagram is active updates only the matching placement.
 *
 * Backward compat: `diagramUnid` + `pos` together act as an implicit
 * single placement. Code reading positions should consult
 * `diagramPlacements` first, then fall back to `pos`.
 */
export const SchemaJsonDiagramPlacement = Vts.object({
    diagramUnid: Vts.string(),
    pos: SchemaJsonPosition
});
export type JsonDiagramPlacement = ExtractSchemaResultType<typeof SchemaJsonDiagramPlacement>;

export const SchemaJsonTable = Vts.object({
    unid: Vts.string(),
    name: Vts.string(),
    pos: SchemaJsonPosition,
    columns: Vts.array(SchemaJsonColumn),
    indexes: Vts.array(SchemaJsonIndex),
    foreignKeys: Vts.array(SchemaJsonForeignKey),
    options: Vts.optional(SchemaJsonTableOptions),
    description: Vts.optional(Vts.string()),
    /**
     * Primary EER diagram (single-membership). Optional. If
     * `diagramPlacements` is empty and `diagramUnid` is set, the
     * table is in exactly that one diagram, rendered at the top-
     * level `pos`.
     */
    diagramUnid: Vts.optional(Vts.string()),
    /**
     * Per-diagram placements for multi-membership. A table is "in"
     * an EER diagram if `diagramUnid` matches OR a placement
     * exists with that diagramUnid. Positions are per-diagram; the
     * top-level `pos` is the home position used outside diagram
     * scope.
     */
    diagramPlacements: Vts.optional(Vts.array(SchemaJsonDiagramPlacement)),
    wbPassthrough: Vts.optional(SchemaWbPassthrough)
});
export type JsonTable = ExtractSchemaResultType<typeof SchemaJsonTable>;

/*
 * ---------------------------------------------------------------------------
 * Diagram — logical EER diagram (Workbench's `workbench.physical.Diagram`)
 *
 * Pure logical container: a named "EER tab" that holds a set of
 * tables (and views) at per-diagram positions. NOT a drawable
 * rectangle — when the diagram is the active scope, the canvas
 * just shows its member cards. Visual grouping rectangles within
 * a diagram (the Workbench "Group" / `workbench.physical.Layer`)
 * are a separate concept and not modelled in this iteration.
 * ---------------------------------------------------------------------------
 */

export const SchemaJsonDiagram = Vts.object({
    unid: Vts.string(),
    name: Vts.string(),
    description: Vts.optional(Vts.string())
});
export type JsonDiagram = ExtractSchemaResultType<typeof SchemaJsonDiagram>;

/*
 * ---------------------------------------------------------------------------
 * View
 * ---------------------------------------------------------------------------
 */

export const SchemaJsonView = Vts.object({
    unid: Vts.string(),
    name: Vts.string(),
    pos: SchemaJsonPosition,
    /** Raw SELECT body (without the leading `CREATE VIEW name AS`). */
    select: Vts.string(),
    materialized: Vts.optional(Vts.boolean()),
    description: Vts.optional(Vts.string()),
    /**
     * Primary EER-diagram membership. Same semantics as
     * `JsonTable.diagramUnid` — the home diagram whose `pos` the
     * view inherits. Additional diagrams go in `diagramPlacements`,
     * each with their own per-diagram position.
     */
    diagramUnid: Vts.optional(Vts.string()),
    diagramPlacements: Vts.optional(Vts.array(SchemaJsonDiagramPlacement)),
    wbPassthrough: Vts.optional(SchemaWbPassthrough)
});
export type JsonView = ExtractSchemaResultType<typeof SchemaJsonView>;

/*
 * ---------------------------------------------------------------------------
 * Enum (Postgres CREATE TYPE / MySQL ENUM column type alias)
 * ---------------------------------------------------------------------------
 */

export const SchemaJsonEnumValue = Vts.object({
    unid: Vts.string(),
    value: Vts.string()
});
export type JsonEnumValue = ExtractSchemaResultType<typeof SchemaJsonEnumValue>;

export const SchemaJsonEnum = Vts.object({
    unid: Vts.string(),
    name: Vts.string(),
    pos: SchemaJsonPosition,
    values: Vts.array(SchemaJsonEnumValue),
    description: Vts.optional(Vts.string())
});
export type JsonEnum = ExtractSchemaResultType<typeof SchemaJsonEnum>;

/*
 * ---------------------------------------------------------------------------
 * Routine — stored procedures, functions, triggers
 *
 * Modelled as an opaque body. The user pastes the full SQL definition
 * (everything from `CREATE PROCEDURE foo(...)` through `END`) and the
 * generator emits it verbatim. We don't parse parameters or return types
 * — Workbench-parity for the modeling half doesn't require it, and
 * trying to round-trip dialect-specific routine syntax is a quagmire.
 *
 * `kind` is the routine's category, used by the treeview icon and the
 * generator's emit (procedures and functions get different file names
 * and headers).
 */

export const SchemaJsonRoutine = Vts.object({
    unid: Vts.string(),
    name: Vts.string(),
    pos: SchemaJsonPosition,
    kind: Vts.or([Vts.enum(JsonRoutineKind), Vts.string()]),
    body: Vts.string(),
    description: Vts.optional(Vts.string()),
    wbPassthrough: Vts.optional(SchemaWbPassthrough)
});
export type JsonRoutine = ExtractSchemaResultType<typeof SchemaJsonRoutine>;

/*
 * ---------------------------------------------------------------------------
 * File-system tree node
 * ---------------------------------------------------------------------------
 */

/**
 * Recursive node. Each node has its own children list (`entrys`) plus
 * collections of typed siblings (`tables`, `views`, `enums`). We keep them
 * separate so a folder can mix subfolders and concrete objects without
 * polymorphic acrobatics.
 */
export const SchemaJsonDataDB = Vts.object({
    unid: Vts.string(),
    name: Vts.string(),
    type: Vts.or([Vts.enum(JsonDataDBType), Vts.string()]),
    istoggle: Vts.optional(Vts.boolean()),
    icon: Vts.optional(Vts.string()),
    entrys: Vts.array(Vts.unknown()),
    tables: Vts.array(SchemaJsonTable),
    views: Vts.array(SchemaJsonView),
    enums: Vts.array(SchemaJsonEnum),
    /*
     * Optional for backward compat: existing schema files written before
     * routines were a thing still validate without the field, and the
     * repo loader defaults to [] when reading them in.
     */
    routines: Vts.optional(Vts.array(SchemaJsonRoutine)),
    /*
     * EER diagrams (Workbench `workbench.physical.Diagram`). One
     * per "tab/view" the user works in. Tables/views opt into a
     * diagram via `diagramUnid` / `diagramPlacements`. Optional
     * for backward compat — older schema files lacked any
     * diagrams.
     */
    diagrams: Vts.optional(Vts.array(SchemaJsonDiagram)),
    /*
     * Database-level defaults inherited by every contained table.
     * Mirrors MySQL's DB → table → column inheritance. When a table's
     * `options.engine/charset/collation` is unset, it inherits from
     * the corresponding default. The renderer omits per-table CHARSET
     * / COLLATE when they match the database default, and the diff
     * treats inherited values as equivalent to missing ones — so a
     * `.mwb`-imported model whose tables don't carry charset can
     * round-trip cleanly against a live MariaDB that has the
     * default applied at the schema level.
     */
    defaultEngine: Vts.optional(Vts.string()),
    defaultCharset: Vts.optional(Vts.string()),
    defaultCollation: Vts.optional(Vts.string()),
    /**
     * Workbench `.mwb` passthrough on the schema (database) entity —
     * captures unknown children of `db.mysql.Schema` like vendor
     * extension fields. Only set on databases imported from `.mwb`.
     */
    wbPassthrough: Vts.optional(SchemaWbPassthrough)
});
export type JsonDataDB = ExtractSchemaResultType<typeof SchemaJsonDataDB>;

/*
 * ---------------------------------------------------------------------------
 * Editor UI state (persisted alongside the schema)
 * ---------------------------------------------------------------------------
 */

export const SchemaJsonEditorSettings = Vts.object({
    controls_width: Vts.optional(Vts.number()),
    active_entry_unid: Vts.optional(Vts.string()),
    /** Canvas zoom level, clamped to ZOOM_MIN..ZOOM_MAX. Persists between sessions. */
    zoom: Vts.optional(Vts.number())
});
export type JsonEditorSettings = ExtractSchemaResultType<typeof SchemaJsonEditorSettings>;

/*
 * ---------------------------------------------------------------------------
 * Sync-with-DB settings (persisted UI overrides)
 *
 * `project.sync` from `dbeditor.json` is the *default*. When present in the
 * schema file, this object replaces those defaults for this project — the
 * user edited them from the SyncDialog and we honour their last choice.
 * Both fields are optional so existing schema files without a `sync` key
 * keep validating after upgrade.
 * ---------------------------------------------------------------------------
 */

export const SchemaJsonSyncSettings = Vts.object({
    ignoreTables: Vts.optional(Vts.array(Vts.string())),
    ignoreColumnAttributes: Vts.optional(Vts.array(Vts.string()))
});
export type JsonSyncSettings = ExtractSchemaResultType<typeof SchemaJsonSyncSettings>;

/*
 * ---------------------------------------------------------------------------
 * Output settings (persisted UI overrides)
 *
 * Same shape as `project.output` in `dbeditor.json` but every field is
 * optional — when present, it overrides the corresponding default. Lets
 * the user tweak output preferences from the topbar Settings dialog
 * without editing `dbeditor.json`. Per-project (schema file scoped).
 * ---------------------------------------------------------------------------
 */

export const SchemaJsonOutputSettings = Vts.object({
    mode: Vts.optional(Vts.string()),
    destinationPath: Vts.optional(Vts.string()),
    destinationClear: Vts.optional(Vts.boolean()),
    sqlComment: Vts.optional(Vts.boolean()),
    sqlIndent: Vts.optional(Vts.string()),
    statementTerminator: Vts.optional(Vts.string()),
    migrationFilenamePattern: Vts.optional(Vts.string())
});
export type JsonOutputSettings = ExtractSchemaResultType<typeof SchemaJsonOutputSettings>;

/*
 * ---------------------------------------------------------------------------
 * Top-level on-disk file
 * ---------------------------------------------------------------------------
 */

export const SchemaJsonData = Vts.object({
    fs: SchemaJsonDataDB,
    editor: SchemaJsonEditorSettings,
    sync: Vts.optional(SchemaJsonSyncSettings),
    output: Vts.optional(SchemaJsonOutputSettings)
});
export type JsonData = ExtractSchemaResultType<typeof SchemaJsonData>;