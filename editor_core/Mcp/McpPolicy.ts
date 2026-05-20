import {ConfigMcp, ConfigMcpPolicy, ConfigMcpPolicyAction, ConfigMcpPolicyRule} from '../../Config/Config.js';

/**
 * Compiled policy decision for one tool name. Pure data — the registry
 * (and any future approval UI) reads the resolved action; the policy
 * itself stays declarative in `dbeditor.json`.
 */
export type McpPolicyDecision = (toolName: string) => ConfigMcpPolicyAction;

/**
 * Compiles an `mcp.policy` block from `dbeditor.json` into a fast
 * lookup function. Rule patterns are wildcard globs against the tool
 * name (`*` matches any run of name characters). Rules are evaluated
 * in declared order; first match wins. If no rule matches, the
 * policy `default` applies; if no default is configured, the global
 * fallback is `allow` for an absent policy block (i.e. MCP enabled
 * without policy means "trust all clients") and `ask` for a present
 * policy block that lacks a default.
 *
 * Distinguishing those two cases matters: "no policy at all" reads
 * naturally as "unrestricted" (mirrors the SDK's pre-policy default);
 * "policy authored but default unset" almost always means the user
 * has rules but wasn't sure what to put in `default` and wanted the
 * server to prompt instead of silently letting things through.
 */
export class McpPolicy {

    public static compile(mcp: ConfigMcp | undefined): McpPolicyDecision {
        if (mcp === undefined || mcp.policy === undefined) {
            return () => ConfigMcpPolicyAction.allow;
        }
        const policy = mcp.policy;
        const fallback = policy.default ?? ConfigMcpPolicyAction.ask;
        const rules = policy.rules ?? [];
        const compiled = rules.map(r => ({
            test: McpPolicy._patternToRegex(r.match),
            action: r.action
        }));
        return (toolName: string): ConfigMcpPolicyAction => {
            for (const r of compiled) {
                if (r.test.test(toolName)) {return r.action;}
            }
            return fallback;
        };
    }

    /**
     * Evaluate a single rule against a tool name — exposed so the
     * server can answer a "what would this rule do" query without
     * building a full decision function.
     */
    public static ruleMatches(rule: ConfigMcpPolicyRule, toolName: string): boolean {
        return McpPolicy._patternToRegex(rule.match).test(toolName);
    }

    /**
     * Convert a user-authored glob pattern to a regex. Only `*` is
     * special — it matches any run of characters legal in a tool name.
     * Everything else is escaped so a pattern like `db_delete_table`
     * matches that one tool literally (no accidental regex semantics
     * from `.` / `(` / `[` in user input).
     */
    private static _patternToRegex(pattern: string): RegExp {
        const escaped = pattern.replace(/[\\^$+?.()|[\]{}]/gu, '\\$&').replace(/\*/gu, '.*');
        return new RegExp(`^${escaped}$`, 'u');
    }

}

export {ConfigMcpPolicy};