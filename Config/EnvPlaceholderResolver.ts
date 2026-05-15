/**
 * Substitutes `${VAR}` / `${VAR:-default}` placeholders in config strings
 * from `process.env`. Used after VTS validation so the schema itself stays
 * shape-only — placeholders are valid string values from VTS's perspective.
 *
 * Syntax:
 *   ${FOO}           — required; throws if FOO is unset or empty
 *   ${FOO:-bar}      — falls back to "bar" if FOO is unset or empty
 *   $${FOO}          — literal "${FOO}" (escape via doubled dollar sign)
 *
 * Multiple placeholders per string are supported; a placeholder cannot
 * itself contain `}`.
 */
export class EnvPlaceholderError extends Error {

    public constructor(message: string) {
        super(message);
        this.name = 'EnvPlaceholderError';
    }

}

export type EnvMap = Record<string, string | undefined>;

const PLACEHOLDER_RE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu;

const substituteString = (input: string, env: EnvMap, path: string): string => {
    return input.replace(PLACEHOLDER_RE, (match, name?: string, fallback?: string) => {
        if (match === '$$') {return '$';}
        const raw = env[name!];
        const value = raw !== undefined && raw !== '' ? raw : fallback;
        if (value === undefined) {
            const dollar = String.fromCharCode(36);
            const hint = `(define it in your shell, your .env file, or supply a fallback like "${dollar}{NAME:-default}")`;
            throw new EnvPlaceholderError(
                `env variable ${dollar}{${name}} required by config at "${path}" is not set ${hint}`
            );
        }
        return value;
    });
};

const walk = (node: unknown, env: EnvMap, path: string): unknown => {
    if (typeof node === 'string') {
        return substituteString(node, env, path);
    }
    if (Array.isArray(node)) {
        return node.map((child, idx) => walk(child, env, `${path}[${idx}]`));
    }
    if (node !== null && typeof node === 'object') {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            result[k] = walk(v, env, path ? `${path}.${k}` : k);
        }
        return result;
    }
    return node;
};

/**
 * Recursively substitutes placeholders in every string field of `config`.
 * Returns a deep copy — the input object is not mutated.
 */
export const resolveEnvPlaceholders = <T>(config: T, env: EnvMap = process.env): T => {
    return walk(config, env, '') as T;
};