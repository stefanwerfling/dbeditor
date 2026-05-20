import {describe, expect, it} from 'vitest';
import {ConfigMcpPolicyAction} from '../../../Config/Config.js';
import {McpPolicy} from '../../../editor_core/Mcp/McpPolicy.js';

describe('McpPolicy.compile', () => {

    it('defaults to allow for every tool when no mcp config at all', () => {
        const decide = McpPolicy.compile(undefined);
        expect(decide('db_list_projects')).toBe(ConfigMcpPolicyAction.allow);
        expect(decide('db_delete_table')).toBe(ConfigMcpPolicyAction.allow);
    });

    it('defaults to allow when mcp is configured but no policy block', () => {
        const decide = McpPolicy.compile({enabled: true});
        expect(decide('db_list_projects')).toBe(ConfigMcpPolicyAction.allow);
    });

    it('defaults to ask when a policy block exists but no rules or default', () => {
        const decide = McpPolicy.compile({enabled: true, policy: {}});
        expect(decide('db_anything')).toBe(ConfigMcpPolicyAction.ask);
    });

    it('honors the explicit policy.default when no rule matches', () => {
        const decide = McpPolicy.compile({
            enabled: true,
            policy: {default: ConfigMcpPolicyAction.deny}
        });
        expect(decide('db_list_projects')).toBe(ConfigMcpPolicyAction.deny);
    });

    it('matches exact tool names via literal patterns', () => {
        const decide = McpPolicy.compile({
            enabled: true,
            policy: {
                default: ConfigMcpPolicyAction.deny,
                rules: [{match: 'db_list_projects', action: ConfigMcpPolicyAction.allow}]
            }
        });
        expect(decide('db_list_projects')).toBe(ConfigMcpPolicyAction.allow);
        expect(decide('db_list_projects_extra')).toBe(ConfigMcpPolicyAction.deny);
    });

    it('expands `*` to match any run of characters', () => {
        const decide = McpPolicy.compile({
            enabled: true,
            policy: {
                default: ConfigMcpPolicyAction.deny,
                rules: [
                    {match: 'db_list_*', action: ConfigMcpPolicyAction.allow},
                    {match: 'db_get_*', action: ConfigMcpPolicyAction.allow}
                ]
            }
        });
        expect(decide('db_list_projects')).toBe(ConfigMcpPolicyAction.allow);
        expect(decide('db_list_tables')).toBe(ConfigMcpPolicyAction.allow);
        expect(decide('db_get_table')).toBe(ConfigMcpPolicyAction.allow);
        expect(decide('db_delete_table')).toBe(ConfigMcpPolicyAction.deny);
    });

    it('first matching rule wins (later rules ignored on overlap)', () => {
        const decide = McpPolicy.compile({
            enabled: true,
            policy: {
                default: ConfigMcpPolicyAction.deny,
                rules: [
                    {match: 'db_*', action: ConfigMcpPolicyAction.allow},
                    {match: 'db_delete_*', action: ConfigMcpPolicyAction.deny}
                ]
            }
        });
        expect(decide('db_delete_table')).toBe(ConfigMcpPolicyAction.allow);
    });

    it('escapes regex metacharacters in user patterns so `.` is literal', () => {
        const decide = McpPolicy.compile({
            enabled: true,
            policy: {
                default: ConfigMcpPolicyAction.deny,
                rules: [{match: 'db.list', action: ConfigMcpPolicyAction.allow}]
            }
        });
        expect(decide('db.list')).toBe(ConfigMcpPolicyAction.allow);
        expect(decide('db_list')).toBe(ConfigMcpPolicyAction.deny);
    });

});

describe('McpPolicy.ruleMatches', () => {

    it('returns true when the tool name matches the rule pattern', () => {
        expect(McpPolicy.ruleMatches({match: 'db_*', action: ConfigMcpPolicyAction.allow}, 'db_list_tables')).toBe(true);
    });

    it('returns false when it does not', () => {
        expect(McpPolicy.ruleMatches({match: 'db_get_*', action: ConfigMcpPolicyAction.allow}, 'db_list_tables')).toBe(false);
    });

});