import {ExtractSchemaResultType, SchemaErrors, Vts} from 'vts';
import {Config, ConfigProjectConnection, SchemaConfig} from './Config.js';

/**
 * Body accepted by the "add connection to project" route.
 *
 * Mirrors `SchemaConfigProjectConnection` (the on-disk shape) but
 * keeps `port`/`password`/`ssl`/`readOnly` optional so the caller can
 * omit fields and let defaults apply at boot. The string fields still
 * support `${VAR}` and `${VAR:-default}` env placeholders — exactly
 * like the original schema — so a UI-entered "${MARIADB_PASSWORD}"
 * persists verbatim and resolves correctly on next restart.
 */
export const SchemaAddConnectionInput = Vts.object({
    databaseUnid: Vts.string(),
    host: Vts.string(),
    port: Vts.optional(Vts.number()),
    user: Vts.string(),
    password: Vts.optional(Vts.string()),
    database: Vts.string(),
    ssl: Vts.optional(Vts.boolean()),
    readOnly: Vts.optional(Vts.boolean())
});

export type AddConnectionInput = ExtractSchemaResultType<typeof SchemaAddConnectionInput>;

/**
 * Body accepted by the "edit existing connection" route.
 *
 * Every field is optional — omitted fields keep their current value
 * on disk. `databaseUnid` is not patchable; moving a connection to a
 * different model database means deleting and re-adding (the route
 * uses it as a path parameter so this constraint is structural).
 *
 * Password semantics:
 *   - field omitted entirely      → keep current value
 *   - field present, empty string → clear the password
 *   - field present, non-empty    → replace
 *
 * Same env-placeholder rules as add: `${VAR}` and `${VAR:-default}`
 * persist verbatim and resolve at server boot.
 */
export const SchemaUpdateConnectionInput = Vts.object({
    host: Vts.optional(Vts.string()),
    port: Vts.optional(Vts.number()),
    user: Vts.optional(Vts.string()),
    password: Vts.optional(Vts.string()),
    database: Vts.optional(Vts.string()),
    ssl: Vts.optional(Vts.boolean()),
    readOnly: Vts.optional(Vts.boolean())
});

export type UpdateConnectionInput = ExtractSchemaResultType<typeof SchemaUpdateConnectionInput>;

/**
 * Body accepted by the "rebind connection to other database" route.
 * Only the target `databaseUnid` travels in the body — the source is
 * a path parameter (same shape as the edit/delete routes).
 */
export const SchemaRebindConnectionInput = Vts.object({
    newDatabaseUnid: Vts.string()
});

export type RebindConnectionInput = ExtractSchemaResultType<typeof SchemaRebindConnectionInput>;

export type ConnectionConfigErrorCode =
    | 'invalid-config'
    | 'invalid-input'
    | 'unknown-project'
    | 'duplicate-connection'
    | 'unknown-connection';

export class ConnectionConfigError extends Error {

    public readonly code: ConnectionConfigErrorCode;
    public readonly details: string[];

    public constructor(code: ConnectionConfigErrorCode, message: string, details: string[] = []) {
        super(message);
        this.name = 'ConnectionConfigError';
        this.code = code;
        this.details = details;
    }

}

/*
 * Project lookup is by name because the runtime project unid changes
 * across restarts (it's a randomUUID minted at boot), and the file
 * doesn't store that unid. Names are constrained to be unique by
 * `addProjectToConfig`, so the lookup is unambiguous.
 */
const findProjectIndex = (config: Config, projectName: string): number => {
    const lower = projectName.toLowerCase();
    for (let i = 0; i < config.projects.length; i++) {
        if ((config.projects[i].name ?? '').toLowerCase() === lower) {
            return i;
        }
    }
    return -1;
};

const validateConfig = (rawConfig: unknown): Config => {
    const errors: SchemaErrors = [];
    if (!SchemaConfig.validate(rawConfig, errors)) {
        throw new ConnectionConfigError(
            'invalid-config',
            'dbeditor.json failed validation',
            errors.map(e => String(e))
        );
    }
    return rawConfig as Config;
};

const revalidateMerged = (nextConfig: Config): void => {
    const merged: SchemaErrors = [];
    if (!SchemaConfig.validate(nextConfig, merged)) {
        throw new ConnectionConfigError(
            'invalid-config',
            'merged dbeditor.json failed validation',
            merged.map(e => String(e))
        );
    }
};

/**
 * Pure logic for appending a new connection entry to a project.
 *
 * Caller hands in a parsed-but-unvalidated config object plus a
 * shape-validated input. Returns the merged config with the new
 * connection on the named project's `connections[]`. Throws on any
 * structural problem so the calling route can map to an HTTP status.
 *
 * Uniqueness within a project is enforced by `databaseUnid` — each
 * model database can have at most one connection (mirrors the
 * one-connection-per-database semantics throughout the rest of the
 * codebase).
 */
export const addConnectionToConfig = (
    rawConfig: unknown,
    projectName: string,
    input: AddConnectionInput
): Config => {
    const config = validateConfig(rawConfig);
    const idx = findProjectIndex(config, projectName);
    if (idx < 0) {
        throw new ConnectionConfigError('unknown-project', `no project named "${projectName}" in dbeditor.json`);
    }

    const databaseUnid = input.databaseUnid.trim();
    if (databaseUnid === '') {
        throw new ConnectionConfigError('invalid-input', 'databaseUnid is required');
    }
    const host = input.host.trim();
    if (host === '') {
        throw new ConnectionConfigError('invalid-input', 'host is required');
    }
    const user = input.user.trim();
    if (user === '') {
        throw new ConnectionConfigError('invalid-input', 'user is required');
    }
    const database = input.database.trim();
    if (database === '') {
        throw new ConnectionConfigError('invalid-input', 'database is required');
    }
    if (input.port !== undefined && !Number.isFinite(input.port)) {
        throw new ConnectionConfigError('invalid-input', 'port must be a finite number');
    }

    const existing = config.projects[idx].connections ?? [];
    for (const c of existing) {
        if (c.databaseUnid === databaseUnid) {
            throw new ConnectionConfigError(
                'duplicate-connection',
                `databaseUnid "${databaseUnid}" already has a connection on project "${projectName}"`
            );
        }
    }

    /*
     * Build the new entry only with the keys the caller actually
     * provided — leaving `port`/`password`/`ssl`/`readOnly` out when
     * unset keeps the file tidy and matches how hand-written
     * connections look.
     */
    const newConn: ConfigProjectConnection = {
        databaseUnid: databaseUnid,
        host: host,
        user: user,
        database: database
    };
    if (input.port !== undefined) {newConn.port = input.port;}
    if (input.password !== undefined && input.password !== '') {newConn.password = input.password;}
    if (input.ssl === true) {newConn.ssl = true;}
    if (input.readOnly === true) {newConn.readOnly = true;}

    const nextProjects = config.projects.map((p, i) => {
        if (i !== idx) {return p;}
        return {...p, connections: [...existing, newConn]};
    });
    const nextConfig: Config = {...config, projects: nextProjects};
    revalidateMerged(nextConfig);
    return nextConfig;
};

/**
 * Pure logic for patching an existing connection on a project.
 *
 * Caller hands in the parsed config, the project name (resolved by
 * the route from `repo.project.name`), the connection identifier
 * `databaseUnid`, and a partial patch. Returns the merged config.
 *
 * Patch field rules:
 *   - String fields (host/user/database) — if the *key is present*,
 *     the new value must be non-empty after trim. Omit the key
 *     entirely to keep the existing value.
 *   - `port` — if present and not finite, rejected. Use `undefined`
 *     (i.e. omit the key) to keep the existing port. (We deliberately
 *     don't support "clearing" port since `SchemaConfigProjectConnection`
 *     marks it optional but the runtime defaults to 3306 — clearing
 *     would surprise the user.)
 *   - `password` — three states (see SchemaUpdateConnectionInput docs).
 *   - `ssl` / `readOnly` — `false` removes the key from the on-disk
 *     entry (matches add-side "false-equals-omit" tidiness); `true`
 *     persists `true`; `undefined` keeps the existing value.
 */
export const updateConnectionInConfig = (
    rawConfig: unknown,
    projectName: string,
    databaseUnid: string,
    patch: UpdateConnectionInput
): Config => {
    const config = validateConfig(rawConfig);
    const idx = findProjectIndex(config, projectName);
    if (idx < 0) {
        throw new ConnectionConfigError('unknown-project', `no project named "${projectName}" in dbeditor.json`);
    }

    const existing = config.projects[idx].connections ?? [];
    const connIdx = existing.findIndex(c => c.databaseUnid === databaseUnid);
    if (connIdx < 0) {
        throw new ConnectionConfigError(
            'unknown-connection',
            `no connection for databaseUnid "${databaseUnid}" on project "${projectName}"`
        );
    }
    const current = existing[connIdx];

    /*
     * Build the patched connection field-by-field. The `key in patch`
     * check distinguishes "field omitted entirely" from "field
     * explicitly set to undefined / null" since VTS-validated bodies
     * carry the latter through.
     */
    const merged: ConfigProjectConnection = {
        databaseUnid: current.databaseUnid,
        host: current.host,
        user: current.user,
        database: current.database
    };
    if (current.port !== undefined) {merged.port = current.port;}
    if (current.password !== undefined) {merged.password = current.password;}
    if (current.ssl !== undefined) {merged.ssl = current.ssl;}
    if (current.readOnly !== undefined) {merged.readOnly = current.readOnly;}

    if (patch.host !== undefined) {
        const trimmed = patch.host.trim();
        if (trimmed === '') {
            throw new ConnectionConfigError('invalid-input', 'host cannot be cleared — supply a non-empty value or omit the key');
        }
        merged.host = trimmed;
    }
    if (patch.user !== undefined) {
        const trimmed = patch.user.trim();
        if (trimmed === '') {
            throw new ConnectionConfigError('invalid-input', 'user cannot be cleared — supply a non-empty value or omit the key');
        }
        merged.user = trimmed;
    }
    if (patch.database !== undefined) {
        const trimmed = patch.database.trim();
        if (trimmed === '') {
            throw new ConnectionConfigError('invalid-input', 'database cannot be cleared — supply a non-empty value or omit the key');
        }
        merged.database = trimmed;
    }
    if (patch.port !== undefined) {
        if (!Number.isFinite(patch.port)) {
            throw new ConnectionConfigError('invalid-input', 'port must be a finite number');
        }
        merged.port = patch.port;
    }
    if (patch.password !== undefined) {
        if (patch.password === '') {
            delete merged.password;
        } else {
            merged.password = patch.password;
        }
    }
    if (patch.ssl !== undefined) {
        if (patch.ssl) {
            merged.ssl = true;
        } else {
            delete merged.ssl;
        }
    }
    if (patch.readOnly !== undefined) {
        if (patch.readOnly) {
            merged.readOnly = true;
        } else {
            delete merged.readOnly;
        }
    }

    const nextConnections = existing.map((c, i) => i === connIdx ? merged : c);
    const nextProjects = config.projects.map((p, i) => {
        if (i !== idx) {return p;}
        return {...p, connections: nextConnections};
    });
    const nextConfig: Config = {...config, projects: nextProjects};
    revalidateMerged(nextConfig);
    return nextConfig;
};

/**
 * Pure logic for rebinding an existing connection to a different
 * model database. The connection's host/port/user/password/database/
 * ssl/readOnly all carry through unchanged — only the `databaseUnid`
 * field is swapped.
 *
 * Position in the `connections[]` array is preserved (the entry is
 * mutated in place rather than appended) so the on-disk file diff
 * for a rebind is minimal.
 *
 * Errors:
 *   - `unknown-project`     — projectName not in config
 *   - `unknown-connection`  — oldDatabaseUnid has no connection entry
 *   - `duplicate-connection`— newDatabaseUnid already has a connection
 *   - `invalid-input`       — empty newDatabaseUnid
 */
export const rebindConnectionInConfig = (
    rawConfig: unknown,
    projectName: string,
    oldDatabaseUnid: string,
    newDatabaseUnid: string
): Config => {
    const config = validateConfig(rawConfig);
    const idx = findProjectIndex(config, projectName);
    if (idx < 0) {
        throw new ConnectionConfigError('unknown-project', `no project named "${projectName}" in dbeditor.json`);
    }

    const trimmedNew = newDatabaseUnid.trim();
    if (trimmedNew === '') {
        throw new ConnectionConfigError('invalid-input', 'newDatabaseUnid is required');
    }

    const existing = config.projects[idx].connections ?? [];
    const connIdx = existing.findIndex(c => c.databaseUnid === oldDatabaseUnid);
    if (connIdx < 0) {
        throw new ConnectionConfigError(
            'unknown-connection',
            `no connection for databaseUnid "${oldDatabaseUnid}" on project "${projectName}"`
        );
    }

    /*
     * No-op rebind (target equals source) is treated as success — the
     * caller probably wired the UI in a way that allowed picking the
     * current binding, and rejecting would force the UI to filter the
     * picker more aggressively for no real gain.
     */
    if (trimmedNew === oldDatabaseUnid) {
        return config;
    }

    for (const c of existing) {
        if (c.databaseUnid === trimmedNew) {
            throw new ConnectionConfigError(
                'duplicate-connection',
                `databaseUnid "${trimmedNew}" already has a connection on project "${projectName}"`
            );
        }
    }

    const rebound: ConfigProjectConnection = {
        ...existing[connIdx],
        databaseUnid: trimmedNew
    };
    const nextConnections = existing.map((c, i) => i === connIdx ? rebound : c);
    const nextProjects = config.projects.map((p, i) => {
        if (i !== idx) {return p;}
        return {...p, connections: nextConnections};
    });
    const nextConfig: Config = {...config, projects: nextProjects};
    revalidateMerged(nextConfig);
    return nextConfig;
};

/**
 * Pure logic for removing a connection from a project by databaseUnid.
 * Throws `unknown-project` / `unknown-connection` when the caller is
 * out of date. Returns the merged config on success.
 */
export const removeConnectionFromConfig = (
    rawConfig: unknown,
    projectName: string,
    databaseUnid: string
): Config => {
    const config = validateConfig(rawConfig);
    const idx = findProjectIndex(config, projectName);
    if (idx < 0) {
        throw new ConnectionConfigError('unknown-project', `no project named "${projectName}" in dbeditor.json`);
    }

    const existing = config.projects[idx].connections ?? [];
    const filtered = existing.filter(c => c.databaseUnid !== databaseUnid);
    if (filtered.length === existing.length) {
        throw new ConnectionConfigError(
            'unknown-connection',
            `no connection for databaseUnid "${databaseUnid}" on project "${projectName}"`
        );
    }

    const nextProjects = config.projects.map((p, i) => {
        if (i !== idx) {return p;}
        /*
         * Drop the `connections` key entirely when it becomes empty
         * — matches how hand-written configs without any connections
         * look (no `"connections": []` artifact).
         */
        if (filtered.length === 0) {
            const {connections: _omitted, ...rest} = p;
            return rest;
        }
        return {...p, connections: filtered};
    });
    const nextConfig: Config = {...config, projects: nextProjects};
    revalidateMerged(nextConfig);
    return nextConfig;
};