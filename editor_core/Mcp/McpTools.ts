import {Vts} from 'vts';
import {JsonDataDBType} from '../../editor_frontend/DbEditor/JsonData.js';
import {DbFsRepository} from '../../editor_backend/DbRepository/DbFsRepository.js';
import {DbFsTreeWalker} from '../../editor_backend/DbRepository/DbFsTreeWalker.js';
import {DbRepositoryRegistry} from '../../editor_backend/DbRepository/DbRepositoryRegistry.js';
import {McpTool, McpToolBuilder} from './McpTool.js';

/**
 * External state MCP tools need. The full server eventually also takes
 * a `runGenerate` closure (parallel to the web API's context) — for the
 * read-only first iteration the registry alone is enough.
 */
export type McpContext = {
    repositories: DbRepositoryRegistry;
};

/**
 * dbeditor MCP tool surface. Mostly read-only with one mutation tool
 * (`db_create_table`) as the pattern-establishing first write-tool.
 * Lets an MCP client (Claude Code, Cursor, …) enumerate projects,
 * walk a project's tree, inspect tables, look up a single table's
 * schema, and create new tables with columns.
 *
 * Mutation tools rely on the registry's policy gate — by default a
 * write tool is "ask" (rejected without an explicit approval
 * handler), so the user must opt them in via `mcp.policy` in
 * `dbeditor.json` (mirrors vtseditor's `ask`/`allow`/`deny` model).
 *
 * Tools are exposed as a class with a single `build()` static that
 * returns the array of {@link McpTool}s. Closing over `ctx` happens
 * inside `build()`; nothing in the registry depends on construction
 * order.
 */
export class McpTools {

    /**
     * VTS schema for one column entry on the mutation tools. Shared
     * between `db_create_table.columns[i]` and `db_add_column.column`
     * so the input contract stays in lockstep.
     */
    private static _columnInputSchema = Vts.object({
        name: Vts.string(),
        type: Vts.string({description: 'Logical type: int / bigint / varchar / text / decimal / bool / datetime / date / time / timestamp / json / uuid / enum'}),
        length: Vts.optional(Vts.string({description: 'Optional length / precision / scale, e.g. "255" or "10,2"'})),
        enumRef: Vts.optional(Vts.string({description: 'For type="enum": the unid of the JsonEnum to use'})),
        notNull: Vts.optional(Vts.boolean()),
        primaryKey: Vts.optional(Vts.boolean()),
        autoIncrement: Vts.optional(Vts.boolean()),
        unique: Vts.optional(Vts.boolean()),
        unsigned: Vts.optional(Vts.boolean()),
        defaultValue: Vts.optional(Vts.string({description: 'Default expression as raw SQL (e.g. "CURRENT_TIMESTAMP", "0", "\'foo\'")'})),
        comment: Vts.optional(Vts.string())
    });

    /**
     * Patch shape for `db_update_column` — every field optional so the
     * caller can update one or many at a time without re-sending the
     * whole column.
     */
    private static _columnPatchSchema = Vts.object({
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
        comment: Vts.optional(Vts.string())
    });

    /** One column reference on `db_add_index` / `db_update_index`. */
    private static _indexColumnSchema = Vts.object({
        columnUnid: Vts.string(),
        order: Vts.optional(Vts.string({description: 'ASC | DESC; default ASC'})),
        length: Vts.optional(Vts.number({description: 'Prefix length (mysql only)'}))
    });

    /** Full input shape for `db_add_index`. */
    private static _indexInputSchema = Vts.object({
        name: Vts.string(),
        type: Vts.optional(Vts.string({description: 'index | unique | fulltext | spatial; default `index`'})),
        columns: Vts.array(Vts.object({
            columnUnid: Vts.string(),
            order: Vts.optional(Vts.string()),
            length: Vts.optional(Vts.number())
        })),
        where: Vts.optional(Vts.string({description: 'Partial-index predicate (postgres / sqlite only)'})),
        comment: Vts.optional(Vts.string())
    });

    /** Partial-update shape for `db_update_index`. */
    private static _indexPatchSchema = Vts.object({
        name: Vts.optional(Vts.string()),
        type: Vts.optional(Vts.string()),
        columns: Vts.optional(Vts.array(Vts.object({
            columnUnid: Vts.string(),
            order: Vts.optional(Vts.string()),
            length: Vts.optional(Vts.number())
        }))),
        where: Vts.optional(Vts.string()),
        comment: Vts.optional(Vts.string())
    });

    /** Full input shape for `db_add_foreign_key`. */
    private static _fkInputSchema = Vts.object({
        name: Vts.string(),
        refTableUnid: Vts.string({description: 'unid of the referenced table (in any database in this project)'}),
        columns: Vts.array(Vts.object({
            columnUnid: Vts.string(),
            refColumnUnid: Vts.string()
        })),
        onDelete: Vts.optional(Vts.string({description: 'NO ACTION | RESTRICT | CASCADE | SET NULL | SET DEFAULT'})),
        onUpdate: Vts.optional(Vts.string({description: 'NO ACTION | RESTRICT | CASCADE | SET NULL | SET DEFAULT'})),
        comment: Vts.optional(Vts.string())
    });

    /** Partial-update shape for `db_update_foreign_key`. */
    private static _fkPatchSchema = Vts.object({
        name: Vts.optional(Vts.string()),
        refTableUnid: Vts.optional(Vts.string()),
        columns: Vts.optional(Vts.array(Vts.object({
            columnUnid: Vts.string(),
            refColumnUnid: Vts.string()
        }))),
        onDelete: Vts.optional(Vts.string()),
        onUpdate: Vts.optional(Vts.string()),
        comment: Vts.optional(Vts.string())
    });

    public static build(ctx: McpContext): McpTool[] {
        return [
            McpToolBuilder.define({
                name: 'db_list_projects',
                description: 'List loaded dbeditor projects with their current revision numbers, dialect, and schema-file path. Call this first to obtain the projectUnid every other tool needs.',
                inputSchema: Vts.object({}),
                handler: async() => {
                    const entries = Array.from(ctx.repositories.entries()).map(([unid, repo]) => ({
                        unid: unid,
                        name: repo.project.name,
                        schemaPath: repo.project.schemaPath,
                        dialect: repo.project.dialect,
                        rev: repo.rev
                    }));
                    return McpToolBuilder.json({projects: entries});
                }
            }),

            McpToolBuilder.define({
                name: 'db_get_tree',
                description: 'Return the full JsonDataDB tree (root → databases → folders → tables/views/enums/routines) for a project. Use this to discover existing unids before further queries.',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'})
                }),
                handler: async({projectUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    return McpToolBuilder.json({rev: repo.rev, fs: repo.data.fs});
                }
            }),

            McpToolBuilder.define({
                name: 'db_list_tables',
                description: 'Flat list of every table in a project: name, unid, container path, column count, diagram membership. Cheaper than db_get_tree when you only need the table inventory.',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'})
                }),
                handler: async({projectUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    const tables = [];
                    for (const {container, table} of DbFsTreeWalker.allTables(repo.data.fs)) {
                        tables.push({
                            unid: table.unid,
                            name: table.name,
                            containerUnid: container.unid,
                            containerName: container.name,
                            columnCount: table.columns.length,
                            indexCount: table.indexes.length,
                            foreignKeyCount: table.foreignKeys.length,
                            diagramUnid: table.diagramUnid
                        });
                    }
                    return McpToolBuilder.json({rev: repo.rev, tables: tables});
                }
            }),

            McpToolBuilder.define({
                name: 'db_get_table',
                description: 'Return one table\'s full payload (columns, indexes, foreignKeys, options, pos, diagram membership). Use the unid from db_list_tables / db_get_tree.',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    tableUnid: Vts.string({description: 'Table unid (from db_list_tables or db_get_tree)'})
                }),
                handler: async({projectUnid, tableUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    const found = DbFsTreeWalker.findTable(repo.data.fs, tableUnid);
                    if (!found) {
                        return McpToolBuilder.error(`unknown table ${tableUnid} in project ${projectUnid}`);
                    }
                    return McpToolBuilder.json({
                        rev: repo.rev,
                        containerUnid: found.container.unid,
                        containerName: found.container.name,
                        table: found.table
                    });
                }
            }),

            McpToolBuilder.define({
                name: 'db_list_enums',
                description: 'Flat list of every enum in a project: name, unid, container path, value count. Cheaper than db_get_tree when you only need the enum inventory.',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'})
                }),
                handler: async({projectUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    const enums = [];
                    for (const {container, enum: e} of DbFsTreeWalker.allEnums(repo.data.fs)) {
                        enums.push({
                            unid: e.unid,
                            name: e.name,
                            containerUnid: container.unid,
                            containerName: container.name,
                            valueCount: e.values.length
                        });
                    }
                    return McpToolBuilder.json({rev: repo.rev, enums: enums});
                }
            }),

            McpToolBuilder.define({
                name: 'db_get_enum',
                description: 'Return one enum\'s full payload (name, description, values with unids). Use the unid from db_list_enums / db_get_tree.',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    enumUnid: Vts.string({description: 'Enum unid'})
                }),
                handler: async({projectUnid, enumUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    const found = DbFsTreeWalker.findEnum(repo.data.fs, enumUnid);
                    if (!found) {
                        return McpToolBuilder.error(`unknown enum ${enumUnid} in project ${projectUnid}`);
                    }
                    return McpToolBuilder.json({
                        rev: repo.rev,
                        containerUnid: found.container.unid,
                        containerName: found.container.name,
                        enum: found.enum
                    });
                }
            }),

            McpToolBuilder.define({
                name: 'db_list_views',
                description: 'Flat list of every view in a project: name, unid, container path, materialized flag, diagram membership. Cheaper than db_get_tree when you only need the view inventory.',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'})
                }),
                handler: async({projectUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    const views = [];
                    for (const {container, view} of DbFsTreeWalker.allViews(repo.data.fs)) {
                        views.push({
                            unid: view.unid,
                            name: view.name,
                            containerUnid: container.unid,
                            containerName: container.name,
                            materialized: view.materialized ?? false,
                            diagramUnid: view.diagramUnid
                        });
                    }
                    return McpToolBuilder.json({rev: repo.rev, views: views});
                }
            }),

            McpToolBuilder.define({
                name: 'db_get_view',
                description: 'Return one view\'s full payload (name, raw SELECT body, materialized flag, description). Use the unid from db_list_views / db_get_tree.',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    viewUnid: Vts.string({description: 'View unid'})
                }),
                handler: async({projectUnid, viewUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    const found = DbFsTreeWalker.findView(repo.data.fs, viewUnid);
                    if (!found) {
                        return McpToolBuilder.error(`unknown view ${viewUnid} in project ${projectUnid}`);
                    }
                    return McpToolBuilder.json({
                        rev: repo.rev,
                        containerUnid: found.container.unid,
                        containerName: found.container.name,
                        view: found.view
                    });
                }
            }),

            McpToolBuilder.define({
                name: 'db_list_routines',
                description: 'Flat list of every stored procedure, function, and trigger in a project: name, unid, kind, container path. Cheaper than db_get_tree when you only need the routine inventory.',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'})
                }),
                handler: async({projectUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    const routines = [];
                    for (const {container, routine} of DbFsTreeWalker.allRoutines(repo.data.fs)) {
                        routines.push({
                            unid: routine.unid,
                            name: routine.name,
                            kind: routine.kind,
                            containerUnid: container.unid,
                            containerName: container.name
                        });
                    }
                    return McpToolBuilder.json({rev: repo.rev, routines: routines});
                }
            }),

            McpToolBuilder.define({
                name: 'db_get_routine',
                description: 'Return one routine\'s full payload (name, kind, body, description). Use the unid from db_list_routines / db_get_tree.',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    routineUnid: Vts.string({description: 'Routine unid'})
                }),
                handler: async({projectUnid, routineUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    const found = DbFsTreeWalker.findRoutine(repo.data.fs, routineUnid);
                    if (!found) {
                        return McpToolBuilder.error(`unknown routine ${routineUnid} in project ${projectUnid}`);
                    }
                    return McpToolBuilder.json({
                        rev: repo.rev,
                        containerUnid: found.container.unid,
                        containerName: found.container.name,
                        routine: found.routine
                    });
                }
            }),

            McpToolBuilder.define({
                name: 'db_list_diagrams',
                description: 'Flat list of every EER diagram in a project: name, unid, container path, count of member tables / views. Diagrams are logical groupings; tables/views opt-in via their `diagramUnid` field.',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'})
                }),
                handler: async({projectUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    const diagrams = [];
                    for (const {container, diagram} of DbFsTreeWalker.allDiagrams(repo.data.fs)) {
                        let tableCount = 0;
                        let viewCount = 0;
                        for (const {table} of DbFsTreeWalker.allTables(repo.data.fs)) {
                            if (table.diagramUnid === diagram.unid) {tableCount++;}
                        }
                        for (const {view} of DbFsTreeWalker.allViews(repo.data.fs)) {
                            if (view.diagramUnid === diagram.unid) {viewCount++;}
                        }
                        diagrams.push({
                            unid: diagram.unid,
                            name: diagram.name,
                            containerUnid: container.unid,
                            containerName: container.name,
                            tableCount: tableCount,
                            viewCount: viewCount
                        });
                    }
                    return McpToolBuilder.json({rev: repo.rev, diagrams: diagrams});
                }
            }),

            McpToolBuilder.define({
                name: 'db_get_diagram',
                description: 'Return one diagram\'s payload plus its member table + view unids (resolved by walking the tree and matching diagramUnid). Use this to enumerate what\'s actually IN a diagram.',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    diagramUnid: Vts.string({description: 'Diagram unid'})
                }),
                handler: async({projectUnid, diagramUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    const found = DbFsTreeWalker.findDiagram(repo.data.fs, diagramUnid);
                    if (!found) {
                        return McpToolBuilder.error(`unknown diagram ${diagramUnid} in project ${projectUnid}`);
                    }
                    const tables: {unid: string; name: string;}[] = [];
                    const views: {unid: string; name: string;}[] = [];
                    for (const {table} of DbFsTreeWalker.allTables(repo.data.fs)) {
                        if (table.diagramUnid === diagramUnid) {tables.push({unid: table.unid, name: table.name});}
                    }
                    for (const {view} of DbFsTreeWalker.allViews(repo.data.fs)) {
                        if (view.diagramUnid === diagramUnid) {views.push({unid: view.unid, name: view.name});}
                    }
                    return McpToolBuilder.json({
                        rev: repo.rev,
                        containerUnid: found.container.unid,
                        containerName: found.container.name,
                        diagram: found.diagram,
                        tables: tables,
                        views: views
                    });
                }
            }),

            McpToolBuilder.define({
                name: 'db_create_table',
                description: 'Create a new table inside a database or folder container, optionally with an initial column set. Returns the new tableUnid plus per-column unids. The container must already exist (use db_get_tree to discover container unids). Column `type` is the logical type name (`int`, `bigint`, `varchar`, `text`, `decimal`, `bool`, `datetime`, `date`, `time`, `timestamp`, `json`, `uuid`, `enum`); the dialect resolver maps it to concrete SQL. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    containerUnid: Vts.string({description: 'Parent container unid — must be a database or folder node (from db_get_tree)'}),
                    name: Vts.string({description: 'Table name (must be unique within the container)'}),
                    columns: Vts.optional(Vts.array(McpTools._columnInputSchema)),
                    description: Vts.optional(Vts.string({description: 'Table-level description'})),
                    pos: Vts.optional(Vts.object({
                        x: Vts.number(),
                        y: Vts.number()
                    }, {description: 'Canvas position for the new table card. Omit for a default position.'}))
                }),
                handler: async({projectUnid, containerUnid, name, columns, description, pos}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const {table} = repo.createTable(containerUnid, name, pos ?? null, null);
                        const columnUnids: {name: string; unid: string;}[] = [];
                        for (const col of columns ?? []) {
                            const {column} = repo.addColumn(table.unid, col, null);
                            columnUnids.push({name: column.name, unid: column.unid});
                        }
                        if (description !== undefined && description.length > 0) {
                            repo.updateTable(table.unid, {description: description}, null);
                        }
                        return McpToolBuilder.json({
                            rev: repo.rev,
                            tableUnid: table.unid,
                            columns: columnUnids
                        });
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_update_table',
                description: 'Rename a table and/or change its description. Other patches (canvas pos, dialect-specific options, diagram membership) live in the visual editor — this tool focuses on the model-level fields. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    tableUnid: Vts.string({description: 'Table unid (from db_list_tables or db_get_tree)'}),
                    name: Vts.optional(Vts.string({description: 'New table name (omit to leave unchanged)'})),
                    description: Vts.optional(Vts.string({description: 'New description (omit to leave unchanged; empty string to clear)'}))
                }),
                handler: async({projectUnid, tableUnid, name, description}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const patch: {name?: string; description?: string;} = {};
                        if (name !== undefined) {patch.name = name;}
                        if (description !== undefined) {patch.description = description;}
                        if (Object.keys(patch).length === 0) {
                            return McpToolBuilder.error('db_update_table: at least one of `name` or `description` must be supplied');
                        }
                        const rev = repo.updateTable(tableUnid, patch, null);
                        return McpToolBuilder.json({rev: rev, tableUnid: tableUnid, patched: Object.keys(patch)});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_delete_table',
                description: 'Delete a table and strip every foreign key in OTHER tables that pointed at it (refTableUnid match). Irreversible. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    tableUnid: Vts.string({description: 'Table unid to delete'})
                }),
                handler: async({projectUnid, tableUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const rev = repo.deleteTable(tableUnid, null);
                        return McpToolBuilder.json({rev: rev, deleted: tableUnid});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_add_column',
                description: 'Append a column to an existing table. Use db_create_table when seeding a new table — this tool is for incrementally extending one that already exists. Returns the new columnUnid. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    tableUnid: Vts.string({description: 'Target table unid (from db_list_tables or db_get_tree)'}),
                    column: McpTools._columnInputSchema
                }),
                handler: async({projectUnid, tableUnid, column}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const {rev, column: created} = repo.addColumn(tableUnid, column, null);
                        return McpToolBuilder.json({rev: rev, tableUnid: tableUnid, columnUnid: created.unid, name: created.name});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_update_column',
                description: 'Patch one or more fields on an existing column (rename, retype, toggle flags, change default, …). Only the supplied keys are overwritten — fields you omit keep their current value. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    tableUnid: Vts.string({description: 'Table unid'}),
                    columnUnid: Vts.string({description: 'Column unid (from db_get_table)'}),
                    patch: McpTools._columnPatchSchema
                }),
                handler: async({projectUnid, tableUnid, columnUnid, patch}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        if (Object.keys(patch).length === 0) {
                            return McpToolBuilder.error('db_update_column: `patch` must contain at least one field');
                        }
                        const rev = repo.updateColumn(tableUnid, columnUnid, patch, null);
                        return McpToolBuilder.json({rev: rev, tableUnid: tableUnid, columnUnid: columnUnid, patched: Object.keys(patch)});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_delete_column',
                description: 'Remove a column from a table. Also strips every reference to it from indexes (and drops indexes that lose all columns) and from local foreign keys. Irreversible. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    tableUnid: Vts.string({description: 'Table unid'}),
                    columnUnid: Vts.string({description: 'Column unid to delete'})
                }),
                handler: async({projectUnid, tableUnid, columnUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const rev = repo.removeColumn(tableUnid, columnUnid, null);
                        return McpToolBuilder.json({rev: rev, tableUnid: tableUnid, deleted: columnUnid});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_add_index',
                description: 'Create an index on an existing table. `type` defaults to `index`; use `unique` for a uniqueness constraint, `fulltext` / `spatial` for the corresponding mysql index kinds, or a `where` predicate for a partial index (postgres / sqlite). Column entries reference columns by unid (from db_get_table). **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    tableUnid: Vts.string({description: 'Target table unid'}),
                    index: McpTools._indexInputSchema
                }),
                handler: async({projectUnid, tableUnid, index}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const {rev, index: created} = repo.addIndex(tableUnid, index, null);
                        return McpToolBuilder.json({rev: rev, tableUnid: tableUnid, indexUnid: created.unid, name: created.name});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_update_index',
                description: 'Patch one or more fields on an existing index (rename, retype, change column set / order, adjust WHERE predicate). Only supplied keys are overwritten. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    tableUnid: Vts.string({description: 'Table unid'}),
                    indexUnid: Vts.string({description: 'Index unid (from db_get_table)'}),
                    patch: McpTools._indexPatchSchema
                }),
                handler: async({projectUnid, tableUnid, indexUnid, patch}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        if (Object.keys(patch).length === 0) {
                            return McpToolBuilder.error('db_update_index: `patch` must contain at least one field');
                        }
                        const rev = repo.updateIndex(tableUnid, indexUnid, patch, null);
                        return McpToolBuilder.json({rev: rev, tableUnid: tableUnid, indexUnid: indexUnid, patched: Object.keys(patch)});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_delete_index',
                description: 'Drop an index from a table. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    tableUnid: Vts.string({description: 'Table unid'}),
                    indexUnid: Vts.string({description: 'Index unid to delete'})
                }),
                handler: async({projectUnid, tableUnid, indexUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const rev = repo.removeIndex(tableUnid, indexUnid, null);
                        return McpToolBuilder.json({rev: rev, tableUnid: tableUnid, deleted: indexUnid});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_add_foreign_key',
                description: 'Add a foreign-key constraint from one table to another. `refTableUnid` is the target table (in any database in this project; FKs can cross-reference between databases at the model level). Each column entry pairs a local columnUnid with the target refColumnUnid. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    tableUnid: Vts.string({description: 'Source table unid (where the FK lives)'}),
                    fk: McpTools._fkInputSchema
                }),
                handler: async({projectUnid, tableUnid, fk}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const {rev, fk: created} = repo.addForeignKey(tableUnid, fk, null);
                        return McpToolBuilder.json({rev: rev, tableUnid: tableUnid, fkUnid: created.unid, name: created.name});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_update_foreign_key',
                description: 'Patch one or more fields on an existing FK (rename, retarget refTableUnid, change column pairs, adjust onDelete / onUpdate). Only supplied keys are overwritten. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    tableUnid: Vts.string({description: 'Source table unid'}),
                    fkUnid: Vts.string({description: 'FK unid (from db_get_table)'}),
                    patch: McpTools._fkPatchSchema
                }),
                handler: async({projectUnid, tableUnid, fkUnid, patch}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        if (Object.keys(patch).length === 0) {
                            return McpToolBuilder.error('db_update_foreign_key: `patch` must contain at least one field');
                        }
                        const rev = repo.updateForeignKey(tableUnid, fkUnid, patch, null);
                        return McpToolBuilder.json({rev: rev, tableUnid: tableUnid, fkUnid: fkUnid, patched: Object.keys(patch)});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_delete_foreign_key',
                description: 'Drop a foreign-key constraint. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    tableUnid: Vts.string({description: 'Source table unid'}),
                    fkUnid: Vts.string({description: 'FK unid to delete'})
                }),
                handler: async({projectUnid, tableUnid, fkUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const rev = repo.removeForeignKey(tableUnid, fkUnid, null);
                        return McpToolBuilder.json({rev: rev, tableUnid: tableUnid, deleted: fkUnid});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_create_container',
                description: 'Create a new database or folder node. Databases sit at the top level (parent = root); folders nest inside databases or other folders to group tables/views/enums/routines. The data-tree root is the literal string "root". **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    parentUnid: Vts.string({description: 'Parent container unid — "root" for top-level databases, otherwise a database or folder unid'}),
                    name: Vts.string({description: 'New container name'}),
                    type: Vts.string({description: '"database" or "folder"'})
                }),
                handler: async({projectUnid, parentUnid, name, type}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const {rev, entry} = repo.createContainer(parentUnid, name, type as JsonDataDBType, null);
                        return McpToolBuilder.json({rev: rev, containerUnid: entry.unid, name: entry.name, type: entry.type});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_update_container',
                description: 'Rename a database or folder. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    containerUnid: Vts.string({description: 'Container unid to update'}),
                    name: Vts.optional(Vts.string({description: 'New name (omit to leave unchanged)'}))
                }),
                handler: async({projectUnid, containerUnid, name}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        if (name === undefined) {
                            return McpToolBuilder.error('db_update_container: at least `name` must be supplied');
                        }
                        const rev = repo.updateContainer(containerUnid, {name: name}, null);
                        return McpToolBuilder.json({rev: rev, containerUnid: containerUnid, patched: ['name']});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_delete_container',
                description: 'Delete a database or folder and everything inside it (tables, views, enums, routines, nested folders). Irreversible — verify with db_get_tree first. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    containerUnid: Vts.string({description: 'Container unid to delete'})
                }),
                handler: async({projectUnid, containerUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const rev = repo.deleteContainer(containerUnid, null);
                        return McpToolBuilder.json({rev: rev, deleted: containerUnid});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_create_enum',
                description: 'Create an enum type inside a database or folder, optionally with an initial set of string values. Postgres emits CREATE TYPE … AS ENUM; MySQL inlines values into the column type at use sites; SQLite falls back to TEXT CHECK (col IN (…)). Returns the new enumUnid plus per-value unids. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    containerUnid: Vts.string({description: 'Parent database or folder unid'}),
                    name: Vts.string(),
                    values: Vts.optional(Vts.array(Vts.string({description: 'Enum value (string literal)'}))),
                    description: Vts.optional(Vts.string()),
                    pos: Vts.optional(Vts.object({x: Vts.number(), y: Vts.number()}))
                }),
                handler: async({projectUnid, containerUnid, name, values, description, pos}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const {enumNode} = repo.createEnum(containerUnid, name, pos ?? null, null);
                        const valueUnids: {value: string; unid: string;}[] = [];
                        for (const v of values ?? []) {
                            const {value: created} = repo.addEnumValue(enumNode.unid, v, null);
                            valueUnids.push({value: created.value, unid: created.unid});
                        }
                        if (description !== undefined && description.length > 0) {
                            repo.updateEnum(enumNode.unid, {description: description}, null);
                        }
                        return McpToolBuilder.json({rev: repo.rev, enumUnid: enumNode.unid, values: valueUnids});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_update_enum',
                description: 'Rename an enum and/or update its description. Use db_add_enum_value / db_update_enum_value / db_delete_enum_value for the value list. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    enumUnid: Vts.string({description: 'Enum unid (from db_get_tree)'}),
                    name: Vts.optional(Vts.string()),
                    description: Vts.optional(Vts.string())
                }),
                handler: async({projectUnid, enumUnid, name, description}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const patch: {name?: string; description?: string;} = {};
                        if (name !== undefined) {patch.name = name;}
                        if (description !== undefined) {patch.description = description;}
                        if (Object.keys(patch).length === 0) {
                            return McpToolBuilder.error('db_update_enum: at least one of `name` or `description` must be supplied');
                        }
                        const rev = repo.updateEnum(enumUnid, patch, null);
                        return McpToolBuilder.json({rev: rev, enumUnid: enumUnid, patched: Object.keys(patch)});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_delete_enum',
                description: 'Delete an enum type. Columns that referenced it via enumRef keep their unid in place — the AI should patch those columns to a different type before/after deletion if it matters. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    enumUnid: Vts.string({description: 'Enum unid to delete'})
                }),
                handler: async({projectUnid, enumUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const rev = repo.deleteEnum(enumUnid, null);
                        return McpToolBuilder.json({rev: rev, deleted: enumUnid});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_add_enum_value',
                description: 'Append a value to an existing enum. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    enumUnid: Vts.string({description: 'Target enum unid'}),
                    value: Vts.string({description: 'Enum value (string literal)'})
                }),
                handler: async({projectUnid, enumUnid, value}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const {rev, value: created} = repo.addEnumValue(enumUnid, value, null);
                        return McpToolBuilder.json({rev: rev, enumUnid: enumUnid, valueUnid: created.unid, value: created.value});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_update_enum_value',
                description: 'Rename an enum value in place. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    enumUnid: Vts.string({description: 'Enum unid'}),
                    valueUnid: Vts.string({description: 'Value unid (from db_get_tree)'}),
                    value: Vts.string({description: 'New value literal'})
                }),
                handler: async({projectUnid, enumUnid, valueUnid, value}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const rev = repo.updateEnumValue(enumUnid, valueUnid, value, null);
                        return McpToolBuilder.json({rev: rev, enumUnid: enumUnid, valueUnid: valueUnid});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_delete_enum_value',
                description: 'Remove a single value from an enum. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    enumUnid: Vts.string({description: 'Enum unid'}),
                    valueUnid: Vts.string({description: 'Value unid to delete'})
                }),
                handler: async({projectUnid, enumUnid, valueUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const rev = repo.removeEnumValue(enumUnid, valueUnid, null);
                        return McpToolBuilder.json({rev: rev, enumUnid: enumUnid, deleted: valueUnid});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_create_view',
                description: 'Create a view inside a database or folder. `select` is the raw SELECT body (without the leading `CREATE VIEW name AS`). `materialized` is honoured by Postgres (emits `CREATE MATERIALIZED VIEW`); MySQL / MariaDB / SQLite ignore it. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    containerUnid: Vts.string({description: 'Parent database or folder unid'}),
                    name: Vts.string(),
                    select: Vts.optional(Vts.string({description: 'Raw SELECT body. Default empty — fill it in via db_update_view.'})),
                    materialized: Vts.optional(Vts.boolean()),
                    description: Vts.optional(Vts.string()),
                    pos: Vts.optional(Vts.object({x: Vts.number(), y: Vts.number()}))
                }),
                handler: async({projectUnid, containerUnid, name, select, materialized, description, pos}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const {view} = repo.createView(containerUnid, name, pos ?? null, null);
                        const patch: {select?: string; materialized?: boolean; description?: string;} = {};
                        if (select !== undefined) {patch.select = select;}
                        if (materialized !== undefined) {patch.materialized = materialized;}
                        if (description !== undefined) {patch.description = description;}
                        if (Object.keys(patch).length > 0) {
                            repo.updateView(view.unid, patch, null);
                        }
                        return McpToolBuilder.json({rev: repo.rev, viewUnid: view.unid});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_update_view',
                description: 'Patch one or more fields on an existing view (rename, change SELECT body, toggle materialized, update description). **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    viewUnid: Vts.string({description: 'View unid (from db_get_tree)'}),
                    name: Vts.optional(Vts.string()),
                    select: Vts.optional(Vts.string()),
                    materialized: Vts.optional(Vts.boolean()),
                    description: Vts.optional(Vts.string())
                }),
                handler: async({projectUnid, viewUnid, name, select, materialized, description}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const patch: {name?: string; select?: string; materialized?: boolean; description?: string;} = {};
                        if (name !== undefined) {patch.name = name;}
                        if (select !== undefined) {patch.select = select;}
                        if (materialized !== undefined) {patch.materialized = materialized;}
                        if (description !== undefined) {patch.description = description;}
                        if (Object.keys(patch).length === 0) {
                            return McpToolBuilder.error('db_update_view: at least one field must be supplied');
                        }
                        const rev = repo.updateView(viewUnid, patch, null);
                        return McpToolBuilder.json({rev: rev, viewUnid: viewUnid, patched: Object.keys(patch)});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_delete_view',
                description: 'Delete a view. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    viewUnid: Vts.string({description: 'View unid to delete'})
                }),
                handler: async({projectUnid, viewUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const rev = repo.deleteView(viewUnid, null);
                        return McpToolBuilder.json({rev: rev, deleted: viewUnid});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_create_routine',
                description: 'Create a stored procedure, function, or trigger inside a database or folder. `kind` is one of "procedure" / "function" / "trigger"; the generator emits separate files per kind. `body` is the raw routine body (everything inside the `BEGIN … END` block for procedures/functions, or the full trigger body). Returns the new routineUnid. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    containerUnid: Vts.string({description: 'Parent database or folder unid'}),
                    name: Vts.string(),
                    kind: Vts.string({description: '"procedure" | "function" | "trigger"'}),
                    body: Vts.optional(Vts.string({description: 'Raw routine body. Default empty — fill it in via db_update_routine.'})),
                    description: Vts.optional(Vts.string()),
                    pos: Vts.optional(Vts.object({x: Vts.number(), y: Vts.number()}))
                }),
                handler: async({projectUnid, containerUnid, name, kind, body, description, pos}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const {routine} = repo.createRoutine(containerUnid, name, kind, pos ?? null, null);
                        const patch: {body?: string; description?: string;} = {};
                        if (body !== undefined) {patch.body = body;}
                        if (description !== undefined) {patch.description = description;}
                        if (Object.keys(patch).length > 0) {
                            repo.updateRoutine(routine.unid, patch, null);
                        }
                        return McpToolBuilder.json({rev: repo.rev, routineUnid: routine.unid, kind: routine.kind});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_update_routine',
                description: 'Patch one or more fields on an existing routine (rename, change kind, rewrite body, update description). Only supplied keys are overwritten. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    routineUnid: Vts.string({description: 'Routine unid (from db_get_tree)'}),
                    name: Vts.optional(Vts.string()),
                    kind: Vts.optional(Vts.string({description: '"procedure" | "function" | "trigger"'})),
                    body: Vts.optional(Vts.string()),
                    description: Vts.optional(Vts.string())
                }),
                handler: async({projectUnid, routineUnid, name, kind, body, description}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const patch: {name?: string; kind?: string; body?: string; description?: string;} = {};
                        if (name !== undefined) {patch.name = name;}
                        if (kind !== undefined) {patch.kind = kind;}
                        if (body !== undefined) {patch.body = body;}
                        if (description !== undefined) {patch.description = description;}
                        if (Object.keys(patch).length === 0) {
                            return McpToolBuilder.error('db_update_routine: at least one field must be supplied');
                        }
                        const rev = repo.updateRoutine(routineUnid, patch, null);
                        return McpToolBuilder.json({rev: rev, routineUnid: routineUnid, patched: Object.keys(patch)});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }),

            McpToolBuilder.define({
                name: 'db_delete_routine',
                description: 'Delete a stored procedure, function, or trigger. **Mutation tool — gated by mcp.policy (default `ask`).**',
                inputSchema: Vts.object({
                    projectUnid: Vts.string({description: 'Runtime project unid (from db_list_projects)'}),
                    routineUnid: Vts.string({description: 'Routine unid to delete'})
                }),
                handler: async({projectUnid, routineUnid}) => {
                    const repo = McpTools._repoOf(ctx, projectUnid);
                    try {
                        const rev = repo.deleteRoutine(routineUnid, null);
                        return McpToolBuilder.json({rev: rev, deleted: routineUnid});
                    } catch (err) {
                        return McpToolBuilder.error(err instanceof Error ? err.message : String(err));
                    }
                }
            })
        ];
    }

    /**
     * Look up the repo for the supplied project unid or throw a
     * descriptive error that the registry's call-dispatch catches and
     * converts into an MCP error result.
     */
    private static _repoOf(ctx: McpContext, projectUnid: string): DbFsRepository {
        const repo = ctx.repositories.get(projectUnid);
        if (repo === undefined) {
            throw new Error(`unknown project ${projectUnid}`);
        }
        return repo;
    }

}