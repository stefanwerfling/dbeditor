import {Vts} from 'vts';
import {DbFsRepository} from '../../DbRepository/DbFsRepository.js';
import {DbFsTreeWalker} from '../../DbRepository/DbFsTreeWalker.js';
import {DbRepositoryRegistry} from '../../DbRepository/DbRepositoryRegistry.js';
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