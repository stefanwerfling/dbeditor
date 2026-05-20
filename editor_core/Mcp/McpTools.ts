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
 * Initial dbeditor MCP tool surface — read-only. Lets an MCP client
 * (Claude Code, Cursor, …) enumerate projects, walk a project's tree,
 * inspect tables, and look up a single table's schema. No mutations:
 * those land in a follow-up iteration once the policy / approval gate
 * is wired (mirrors vtseditor's `ask`/`allow`/`deny` model).
 *
 * Tools are exposed as a class with a single `build()` static that
 * returns the array of {@link McpTool}s. Closing over `ctx` happens
 * inside `build()`; nothing in the registry depends on construction
 * order.
 */
export class McpTools {

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