import {Server} from '@modelcontextprotocol/sdk/server/index.js';
// eslint-disable-next-line import/extensions
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {McpToolRegistry} from './McpToolRegistry.js';

/**
 * Build instructions block returned in the MCP `initialize` response.
 * MCP clients (Claude Code, Cursor, …) surface this to the model as
 * "how to use this server". We use it to steer clients away from
 * editing the on-disk schema JSON directly — direct file edits bypass
 * the repository layer, the event bus, autoGenerate, and the policy
 * gate.
 */
export type McpInstructionsContext = {
    /** Absolute paths of every project schema file currently loaded. */
    schemaPaths: readonly string[];
};

/**
 * Thin wrapper around the MCP SDK's `Server` that delegates `tools/list`
 * and `tools/call` to an {@link McpToolRegistry}. Keeps the SDK surface
 * area localised in one file so the rest of `editor_core/Mcp/` stays
 * SDK-free and unit-testable.
 */
export class McpServer {

    public static buildInstructions(ctx: McpInstructionsContext): string {
        const fileLines = ctx.schemaPaths.length > 0
            ? ctx.schemaPaths.map(p => `  - ${p}`).join('\n')
            : '  (no projects loaded yet)';

        return [
            'This server owns the dbeditor schema state for this project.',
            '',
            'The schema JSON file(s):',
            fileLines,
            '',
            'RULES:',
            '1. Treat the schema JSON file(s) above as READ-ONLY from your side.',
            '   Do NOT edit them with Edit / Write / shell redirects.',
            '   Direct edits bypass this server and break:',
            '   - live editor sessions (they will not see your change),',
            '   - the DbGenerator (`autoGenerate` will not rerun),',
            '   - the policy gate and user-approval flow.',
            '2. To INSPECT the schema, prefer `db_get_tree` over reading the file.',
            '   The tool returns a structured view with the current revision number.',
            '3. To MUTATE the schema, always use the `db_*` tools on this server.',
            '   Some tools are gated by `⚠ Requires user approval` — expect a',
            '   short blocking wait when you call them.'
        ].join('\n');
    }

    /**
     * Build a fully-configured MCP SDK server with all `tools/list` and
     * `tools/call` handlers wired to `registry`. The caller attaches a
     * transport (e.g. `StreamableHTTPServerTransport`) and calls
     * `connect()`.
     */
    public static create(registry: McpToolRegistry, ctx: McpInstructionsContext): Server {
        const server = new Server(
            {name: 'dbeditor', version: '1.0.0'},
            {capabilities: {tools: {listChanged: false}}, instructions: McpServer.buildInstructions(ctx)}
        );

        server.setRequestHandler(ListToolsRequestSchema, async() => {
            return {tools: registry.list()};
        });

        server.setRequestHandler(CallToolRequestSchema, async(request) => {
            return registry.call(request.params.name, request.params.arguments);
        });

        return server;
    }

}