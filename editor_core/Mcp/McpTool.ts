import {ExtractSchemaResultType, Schema} from 'vts';

/**
 * What an MCP tool returns. Mirrors the `CallToolResult` shape from
 * `@modelcontextprotocol/sdk` so the actual server wiring (added once
 * the SDK is installed and stdio/HTTP transport is selected) can use
 * these values verbatim.
 *
 * `content[]` carries text/image/resource blocks; for our read-only
 * tools every result is a single `text` block holding pretty-printed
 * JSON of the underlying model payload.
 */
export type McpToolResult = {
    content: {type: 'text'; text: string;}[];
    isError?: boolean;
};

/**
 * A tool's runtime handler. Receives the already-validated arguments
 * (shape matches the tool's VTS `inputSchema`) and returns an MCP
 * tool result, synchronously or asynchronously.
 */
export type McpToolHandler<T> = (args: T) => Promise<McpToolResult> | McpToolResult;

/**
 * A registered MCP tool. The arg type is erased to `unknown` at the
 * registry boundary; `McpToolBuilder.define()` keeps it tight in user
 * code via generic inference so handlers see properly-typed args.
 */
export type McpTool = {
    name: string;
    description: string;
    inputSchema: Schema<unknown>;
    handler: McpToolHandler<unknown>;
};

/**
 * Static helpers around the {@link McpTool} type — a type-preserving
 * builder plus result formatters that tool handlers call.
 */
export class McpToolBuilder {

    /**
     * Type-preserving tool builder. Infers the argument type from the
     * VTS input schema so the handler receives properly-typed args
     * without manual casts.
     */
    public static define<S extends Schema<unknown>>(
        config: {
            name: string;
            description: string;
            inputSchema: S;
            handler: McpToolHandler<ExtractSchemaResultType<S>>;
        }
    ): McpTool {
        return {
            name: config.name,
            description: config.description,
            inputSchema: config.inputSchema,
            handler: config.handler as McpToolHandler<unknown>
        };
    }

    /**
     * Wrap an arbitrary JSON-serialisable value as a single-`text`
     * MCP tool result.
     */
    public static json(value: unknown): McpToolResult {
        return {
            content: [{type: 'text', text: JSON.stringify(value, null, 2)}]
        };
    }

    /**
     * Build an error result with a single text message. The MCP client
     * surfaces the message to the model.
     */
    public static error(message: string): McpToolResult {
        return {
            content: [{type: 'text', text: message}],
            isError: true
        };
    }

}