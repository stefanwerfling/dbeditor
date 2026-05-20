import {Vts} from 'vts';
import {SchemaJsonPosition, SchemaJsonIndexColumn, SchemaJsonForeignKeyColumn, SchemaJsonTableOptions, SchemaJsonDataDB, SchemaJsonDiagramPlacement} from '../../editor_schemas/JsonData.js';

export const SchemaCreateContainerBody = Vts.object({
    parentUnid: Vts.string(),
    name: Vts.string(),
    type: Vts.string()
});

export const SchemaUpdateContainerBody = Vts.object({
    name: Vts.optional(Vts.string()),
    icon: Vts.optional(Vts.string()),
    istoggle: Vts.optional(Vts.boolean())
});

/**
 * Body for the database-defaults PATCH route. Every field is optional;
 * omitted = keep current, empty string = clear that default, value =
 * set/replace.
 */
export const SchemaUpdateDatabaseDefaultsBody = Vts.object({
    defaultEngine: Vts.optional(Vts.string()),
    defaultCharset: Vts.optional(Vts.string()),
    defaultCollation: Vts.optional(Vts.string())
});

export const SchemaCreateTableBody = Vts.object({
    containerUnid: Vts.string(),
    name: Vts.string(),
    pos: Vts.optional(SchemaJsonPosition)
});

export const SchemaUpdateTableBody = Vts.object({
    name: Vts.optional(Vts.string()),
    pos: Vts.optional(SchemaJsonPosition),
    options: Vts.optional(SchemaJsonTableOptions),
    description: Vts.optional(Vts.string()),
    /**
     * Reassign the table to a diagram. Empty string = unassign (clear
     * the property entirely). Non-empty = set to that JsonDiagram unid.
     */
    diagramUnid: Vts.optional(Vts.string()),
    /**
     * Full replacement of the placements list (used by the multi-
     * diagram picker UI). Passing `[]` clears every non-primary
     * membership while leaving `diagramUnid` alone.
     */
    diagramPlacements: Vts.optional(Vts.array(SchemaJsonDiagramPlacement))
});

const ColumnFields = {
    name: Vts.string(),
    type: Vts.string(),
    length: Vts.optional(Vts.string()),
    enumRef: Vts.optional(Vts.string()),
    notNull: Vts.optional(Vts.boolean()),
    primaryKey: Vts.optional(Vts.boolean()),
    autoIncrement: Vts.optional(Vts.boolean()),
    unique: Vts.optional(Vts.boolean()),
    unsigned: Vts.optional(Vts.boolean()),
    defaultValue: Vts.optional(Vts.string()),
    generatedExpression: Vts.optional(Vts.string()),
    generatedStored: Vts.optional(Vts.boolean()),
    collation: Vts.optional(Vts.string()),
    charset: Vts.optional(Vts.string()),
    comment: Vts.optional(Vts.string())
};

export const SchemaAddColumnBody = Vts.object(ColumnFields);

export const SchemaUpdateColumnBody = Vts.object({
    name: Vts.optional(Vts.string()),
    type: Vts.optional(Vts.string()),
    length: Vts.optional(Vts.string()),
    enumRef: Vts.optional(Vts.string()),
    notNull: Vts.optional(Vts.boolean()),
    primaryKey: Vts.optional(Vts.boolean()),
    autoIncrement: Vts.optional(Vts.boolean()),
    unique: Vts.optional(Vts.boolean()),
    unsigned: Vts.optional(Vts.boolean()),
    defaultValue: Vts.optional(Vts.string()),
    generatedExpression: Vts.optional(Vts.string()),
    generatedStored: Vts.optional(Vts.boolean()),
    collation: Vts.optional(Vts.string()),
    charset: Vts.optional(Vts.string()),
    comment: Vts.optional(Vts.string())
});

export const SchemaReorderColumnsBody = Vts.object({
    order: Vts.array(Vts.string())
});

export const SchemaAddIndexBody = Vts.object({
    name: Vts.string(),
    type: Vts.string(),
    columns: Vts.array(SchemaJsonIndexColumn),
    where: Vts.optional(Vts.string()),
    comment: Vts.optional(Vts.string())
});

export const SchemaUpdateIndexBody = Vts.object({
    name: Vts.optional(Vts.string()),
    type: Vts.optional(Vts.string()),
    columns: Vts.optional(Vts.array(SchemaJsonIndexColumn)),
    where: Vts.optional(Vts.string()),
    comment: Vts.optional(Vts.string())
});

export const SchemaAddForeignKeyBody = Vts.object({
    name: Vts.string(),
    refTableUnid: Vts.string(),
    columns: Vts.array(SchemaJsonForeignKeyColumn),
    onDelete: Vts.optional(Vts.string()),
    onUpdate: Vts.optional(Vts.string()),
    comment: Vts.optional(Vts.string())
});

export const SchemaUpdateForeignKeyBody = Vts.object({
    name: Vts.optional(Vts.string()),
    refTableUnid: Vts.optional(Vts.string()),
    columns: Vts.optional(Vts.array(SchemaJsonForeignKeyColumn)),
    onDelete: Vts.optional(Vts.string()),
    onUpdate: Vts.optional(Vts.string()),
    comment: Vts.optional(Vts.string())
});

export const SchemaCreateEnumBody = Vts.object({
    containerUnid: Vts.string(),
    name: Vts.string(),
    pos: Vts.optional(SchemaJsonPosition)
});

export const SchemaUpdateEnumBody = Vts.object({
    name: Vts.optional(Vts.string()),
    pos: Vts.optional(SchemaJsonPosition),
    description: Vts.optional(Vts.string())
});

export const SchemaAddEnumValueBody = Vts.object({
    value: Vts.string()
});

export const SchemaUpdateEnumValueBody = Vts.object({
    value: Vts.string()
});

export const SchemaCreateViewBody = Vts.object({
    containerUnid: Vts.string(),
    name: Vts.string(),
    pos: Vts.optional(SchemaJsonPosition)
});

export const SchemaUpdateViewBody = Vts.object({
    name: Vts.optional(Vts.string()),
    pos: Vts.optional(SchemaJsonPosition),
    select: Vts.optional(Vts.string()),
    materialized: Vts.optional(Vts.boolean()),
    description: Vts.optional(Vts.string()),
    /** Primary EER-diagram membership. Empty string clears the assignment. */
    diagramUnid: Vts.optional(Vts.string()),
    diagramPlacements: Vts.optional(Vts.array(SchemaJsonDiagramPlacement))
});

export const SchemaCreateRoutineBody = Vts.object({
    containerUnid: Vts.string(),
    name: Vts.string(),
    kind: Vts.string(),
    pos: Vts.optional(SchemaJsonPosition)
});

export const SchemaUpdateRoutineBody = Vts.object({
    name: Vts.optional(Vts.string()),
    pos: Vts.optional(SchemaJsonPosition),
    kind: Vts.optional(Vts.string()),
    body: Vts.optional(Vts.string()),
    description: Vts.optional(Vts.string())
});

export const SchemaUpdateDiagramBody = Vts.object({
    name: Vts.optional(Vts.string()),
    description: Vts.optional(Vts.string())
});

export const SchemaCreateDiagramBody = Vts.object({
    containerUnid: Vts.string(),
    name: Vts.string()
});

export const SchemaCreateLayerBody = Vts.object({
    containerUnid: Vts.string(),
    diagramUnid: Vts.string(),
    name: Vts.string(),
    pos: Vts.optional(SchemaJsonPosition),
    width: Vts.optional(Vts.number()),
    height: Vts.optional(Vts.number()),
    color: Vts.optional(Vts.string())
});

export const SchemaUpdateLayerBody = Vts.object({
    name: Vts.optional(Vts.string()),
    pos: Vts.optional(SchemaJsonPosition),
    width: Vts.optional(Vts.number()),
    height: Vts.optional(Vts.number()),
    color: Vts.optional(Vts.string()),
    description: Vts.optional(Vts.string())
});

export const SchemaUpdateEditorSettingsBody = Vts.object({
    controls_width: Vts.optional(Vts.number()),
    active_entry_unid: Vts.optional(Vts.string()),
    zoom: Vts.optional(Vts.number())
});

/**
 * User-paired rename hints for the diff. Each entry collapses a
 * matching tableDropped+tableAdded (or columnDropped+columnAdded
 * within the same table) into a single tableRenamed/columnRenamed
 * change. Hints with no matching pair are silently ignored so the
 * UI doesn't have to keep perfectly stale-free state.
 */
export const SchemaRenameHintsBody = Vts.object({
    tables: Vts.optional(Vts.array(Vts.object({
        from: Vts.string(),
        to: Vts.string()
    }))),
    columns: Vts.optional(Vts.array(Vts.object({
        tableName: Vts.string(),
        from: Vts.string(),
        to: Vts.string()
    })))
});

export const SchemaSyncPreviewBody = Vts.object({
    databaseUnid: Vts.string(),
    /** Optional: scope the diff to tables tagged with this diagram unid. */
    diagramUnid: Vts.optional(Vts.string()),
    renames: Vts.optional(SchemaRenameHintsBody)
});

export const SchemaSyncApplyBody = Vts.object({
    databaseUnid: Vts.string(),
    changeIds: Vts.array(Vts.string()),
    dryRun: Vts.optional(Vts.boolean()),
    diagramUnid: Vts.optional(Vts.string()),
    renames: Vts.optional(SchemaRenameHintsBody)
});

export const SchemaSyncReverseApplyBody = Vts.object({
    databaseUnid: Vts.string(),
    changeIds: Vts.array(Vts.string()),
    diagramUnid: Vts.optional(Vts.string()),
    renames: Vts.optional(SchemaRenameHintsBody)
});

/**
 * Test-run: dumps the live DB, runs the selected statements for real,
 * then ALWAYS restores from the dump. Body shape mirrors
 * `SchemaSyncApplyBody` minus `dryRun` (the test-run mode has its own
 * semantics — there's no dry-run-within-a-test-run).
 *
 * `purgeOnSuccess` defaults to true server-side. When the user wants
 * to keep the dump even on success (e.g. for archival), they can set
 * it false.
 */
export const SchemaSyncTestRunBody = Vts.object({
    databaseUnid: Vts.string(),
    changeIds: Vts.array(Vts.string()),
    diagramUnid: Vts.optional(Vts.string()),
    renames: Vts.optional(SchemaRenameHintsBody),
    purgeOnSuccess: Vts.optional(Vts.boolean())
});

export const SchemaUpdateSyncSettingsBody = Vts.object({
    ignoreTables: Vts.optional(Vts.array(Vts.string())),
    ignoreColumnAttributes: Vts.optional(Vts.array(Vts.string()))
});

/**
 * Whole-schema replace, used by Import. We only validate `fs` and keep
 * `editor`/`sync` untouched on the server side — the user's layout
 * preferences and ignore patterns travel with the project, not with the
 * imported schema.
 */
export const SchemaReplaceFsBody = Vts.object({
    fs: SchemaJsonDataDB
});

export const SchemaGenerateScopedBody = Vts.object({
    databaseUnid: Vts.optional(Vts.string()),
    tableUnid: Vts.optional(Vts.string()),
    tableUnids: Vts.optional(Vts.array(Vts.string()))
});

export const SchemaUpdateOutputSettingsBody = Vts.object({
    mode: Vts.optional(Vts.string()),
    destinationPath: Vts.optional(Vts.string()),
    destinationClear: Vts.optional(Vts.boolean()),
    sqlComment: Vts.optional(Vts.boolean()),
    sqlIndent: Vts.optional(Vts.string()),
    statementTerminator: Vts.optional(Vts.string()),
    migrationFilenamePattern: Vts.optional(Vts.string())
});

export const SchemaLiveRefreshBody = Vts.object({
    databaseUnid: Vts.string()
});

export const SchemaConnectionTestBody = Vts.object({
    databaseUnid: Vts.string(),
    /**
     * Optional override fields. When present, each field overrides
     * the saved-on-disk value for THIS test call only — nothing is
     * persisted. Use case: the EditConnectionDialog wants to test
     * a host/port change while keeping the stored password (which
     * the server never sends back to the client and can't be
     * re-supplied from the form).
     */
    patch: Vts.optional(Vts.object({
        host: Vts.optional(Vts.string()),
        port: Vts.optional(Vts.number()),
        user: Vts.optional(Vts.string()),
        password: Vts.optional(Vts.string()),
        database: Vts.optional(Vts.string()),
        ssl: Vts.optional(Vts.boolean())
    }))
});

/**
 * Body for the ad-hoc connection-test endpoint. Lets the user verify
 * credentials from the AddConnectionDialog / EditConnectionDialog
 * before saving (which would trigger a server restart). String fields
 * support the same `${VAR}` and `${VAR:-default}` env-placeholder
 * syntax as dbeditor.json — resolved server-side before connecting.
 */
export const SchemaConnectionTestAdHocBody = Vts.object({
    dialect: Vts.string(),
    host: Vts.string(),
    port: Vts.optional(Vts.number()),
    user: Vts.string(),
    password: Vts.optional(Vts.string()),
    database: Vts.string(),
    ssl: Vts.optional(Vts.boolean())
});

/**
 * Bodies for the project-config routes.
 * Re-exported from {@link ../Config/AddProject.ts} so request validators
 * stay co-located with the rest of the API schemas.
 */
export {SchemaAddProjectInput, SchemaUpdateProjectInput} from '../Config/AddProject.js';

/**
 * Bodies for the connection-management routes.
 * Re-exported from {@link ../Config/UpdateConnections.ts}.
 */
export {SchemaAddConnectionInput, SchemaUpdateConnectionInput, SchemaRebindConnectionInput} from '../Config/UpdateConnections.js';