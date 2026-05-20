import {SchemaErrors} from 'vts';
import {ConfigMcpPolicyAction} from '../../editor_backend/Config/Config.js';
import {McpPolicyDecision} from './McpPolicy.js';
import {McpTool, McpToolResult} from './McpTool.js';
import {JsonSchemaNode, VtsJsonSchema} from './VtsJsonSchema.js';

/**
 * The advertised shape of a tool — what an MCP client sees on
 * `tools/list`. Built from {@link McpTool}'s VTS `inputSchema` via
 * {@link VtsJsonSchema.convert}. Tools the policy resolves to `ask`
 * get a `⚠ Requires user approval — ` prefix on the description so
 * the model knows the call may block.
 */
export type McpToolListing = {
    name: string;
    description: string;
    inputSchema: JsonSchemaNode;
};

/**
 * Hook called when the policy resolves a tool call to `ask`. Returns
 * `true` to let the call through, `false` to deny it. The dev-server
 * wires this to a per-request blocking UI; tests pass a synchronous
 * stub.
 */
export type McpApprovalHandler = (toolName: string, args: unknown) => Promise<boolean> | boolean;

/**
 * Options for the registry. All optional — an `McpToolRegistry`
 * constructed without options behaves as if every tool is `allow`,
 * which matches the pre-policy default of the SDK.
 */
export type McpToolRegistryOptions = {
    decide?: McpPolicyDecision;
    onApprovalRequest?: McpApprovalHandler;
};

/**
 * Transport-agnostic registry of MCP tools. Owns the byName lookup, the
 * advertised tool list (with JSON-Schema'd input shapes), and the
 * call-dispatch path that walks: policy gate → args validation →
 * handler invocation → result. Errors at every step turn into MCP
 * tool error results — the caller never sees a thrown exception out
 * of `call`.
 *
 * Decoupled from `@modelcontextprotocol/sdk` so it's unit-testable
 * without a transport. The actual SDK wiring (a future `McpServer.ts`)
 * will delegate `tools/list` and `tools/call` to a registry instance.
 */
export class McpToolRegistry {

    private readonly _byName: Map<string, McpTool> = new Map();
    private readonly _listings: McpToolListing[] = [];
    private readonly _decide: McpPolicyDecision;
    private readonly _onApprovalRequest: McpApprovalHandler | undefined;

    public constructor(tools: readonly McpTool[], options: McpToolRegistryOptions = {}) {
        this._decide = options.decide ?? ((): ConfigMcpPolicyAction => ConfigMcpPolicyAction.allow);
        this._onApprovalRequest = options.onApprovalRequest;
        for (const tool of tools) {
            if (this._byName.has(tool.name)) {
                throw new Error(`Duplicate MCP tool name: ${tool.name}`);
            }
            const action = this._decide(tool.name);
            if (action === ConfigMcpPolicyAction.deny) {
                /*
                 * Denied tools are hidden from `tools/list` — the model
                 * sees only what it could legitimately call. The call
                 * gate still rejects them if the model somehow knew the
                 * name (defense in depth).
                 */
                this._byName.set(tool.name, tool);
                continue;
            }
            const description = action === ConfigMcpPolicyAction.ask
                ? `⚠ Requires user approval — ${tool.description}`
                : tool.description;
            this._byName.set(tool.name, tool);
            this._listings.push({
                name: tool.name,
                description: description,
                inputSchema: VtsJsonSchema.convert(tool.inputSchema.describe() as never)
            });
        }
    }

    /** Snapshot of advertised tools for `tools/list`. Excludes denied tools. */
    public list(): readonly McpToolListing[] {
        return this._listings;
    }

    /**
     * Dispatch a `tools/call`. Resolves the policy, validates `args`
     * against the tool's VTS schema, invokes the handler, and reports
     * errors uniformly. Never throws.
     */
    public async call(name: string, args: unknown): Promise<McpToolResult> {
        const tool = this._byName.get(name);
        if (tool === undefined) {
            return {
                content: [{type: 'text', text: `Unknown tool: ${name}`}],
                isError: true
            };
        }

        const action = this._decide(name);
        if (action === ConfigMcpPolicyAction.deny) {
            return {
                content: [{type: 'text', text: `Tool '${name}' denied by policy.`}],
                isError: true
            };
        }

        const errors: SchemaErrors = [];
        if (!tool.inputSchema.validate(args ?? {}, errors)) {
            return {
                content: [{type: 'text', text: `Invalid arguments for ${name}: ${JSON.stringify(errors)}`}],
                isError: true
            };
        }

        if (action === ConfigMcpPolicyAction.ask) {
            const approved = this._onApprovalRequest
                ? await this._onApprovalRequest(name, args)
                : false;
            if (!approved) {
                return {
                    content: [{type: 'text', text: `Tool '${name}' requires user approval and was not confirmed.`}],
                    isError: true
                };
            }
        }

        try {
            return await tool.handler(args ?? {});
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                content: [{type: 'text', text: message}],
                isError: true
            };
        }
    }

}