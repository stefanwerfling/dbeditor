import {ExtractSchemaResultType, Vts} from 'vts';

/**
 * SQL dialect for code generation.
 */
export enum ConfigDialect {
    mysql = 'mysql',
    mariadb = 'mariadb',
    postgres = 'postgres',
    sqlite = 'sqlite'
}

/**
 * How generated SQL is laid out on disk.
 *  - ddl-files:  one .sql file per table (idempotent CREATE TABLE statements)
 *  - migrations: numbered up/down migration pairs
 */
export enum ConfigOutputMode {
    ddl_files = 'ddl-files',
    migrations = 'migrations'
}

/**
 * Per-script hook (run before/after generation).
 */
export const SchemaConfigProjectScriptsScript = Vts.object({
    script: Vts.string(),
    path: Vts.string()
});

export type ConfigProjectScriptsScript = ExtractSchemaResultType<typeof SchemaConfigProjectScriptsScript>;

export const SchemaConfigProjectScripts = Vts.object({
    before_generate: Vts.optional(Vts.array(SchemaConfigProjectScriptsScript)),
    after_generate: Vts.optional(Vts.array(SchemaConfigProjectScriptsScript))
});

/**
 * SQL output options for one project.
 */
export const SchemaConfigProjectOutput = Vts.object({
    mode: Vts.or([Vts.enum(ConfigOutputMode), Vts.string()]),
    destinationPath: Vts.string(),
    destinationClear: Vts.optional(Vts.boolean()),
    sqlComment: Vts.optional(Vts.boolean()),
    sqlIndent: Vts.optional(Vts.string()),
    statementTerminator: Vts.optional(Vts.string()),
    /**
     * For migrations mode only — file pattern for new migration pairs.
     * Defaults to `{timestamp}__{name}.up.sql` / `{timestamp}__{name}.down.sql`.
     */
    migrationFilenamePattern: Vts.optional(Vts.string())
});

export type ConfigProjectOutput = ExtractSchemaResultType<typeof SchemaConfigProjectOutput>;

/**
 * Live-DB connection for one database container in the project. The string
 * fields support `${VAR}` and `${VAR:-default}` placeholders which are
 * substituted from `process.env` after VTS validation. Passwords belong in
 * `.env` and must be referenced via placeholder — never inlined.
 *
 * `databaseUnid` references the `unid` of a `database` node in the
 * project's schema-file tree. There is at most one connection per database
 * container.
 */
export const SchemaConfigProjectConnection = Vts.object({
    databaseUnid: Vts.string(),
    host: Vts.string(),
    port: Vts.optional(Vts.number()),
    user: Vts.string(),
    password: Vts.optional(Vts.string()),
    database: Vts.string(),
    /**
     * Postgres-only: schema name to introspect against. Defaults to
     * `'public'` when unset. MySQL/MariaDB use the `database` field
     * for the same purpose (schema = database in MySQL); SQLite
     * ignores this entirely. Multi-schema-per-connection isn't
     * supported — one JsonDataDB models one Postgres schema.
     */
    schema: Vts.optional(Vts.string()),
    ssl: Vts.optional(Vts.boolean()),
    /** If true, the sync dialog hides the Apply button for this connection. */
    readOnly: Vts.optional(Vts.boolean())
});

export type ConfigProjectConnection = ExtractSchemaResultType<typeof SchemaConfigProjectConnection>;

/**
 * Sync-with-database settings.
 */
export const SchemaConfigProjectSync = Vts.object({
    /** Tables whose name matches an entry here are excluded from the diff. */
    ignoreTables: Vts.optional(Vts.array(Vts.string())),
    /** Column attributes ignored when comparing (e.g. `collation`, `charset`). */
    ignoreColumnAttributes: Vts.optional(Vts.array(Vts.string()))
});

export type ConfigProjectSync = ExtractSchemaResultType<typeof SchemaConfigProjectSync>;

/**
 * Schema for one project entry.
 */
export const SchemaConfigProject = Vts.object({
    name: Vts.optional(Vts.string()),
    schemaPath: Vts.string(),
    dialect: Vts.or([Vts.enum(ConfigDialect), Vts.string()]),
    output: SchemaConfigProjectOutput,
    scripts: Vts.optional(SchemaConfigProjectScripts),
    autoGenerate: Vts.optional(Vts.boolean()),
    /** Per-database live-connection configs. Used by the Sync-with-DB feature. */
    connections: Vts.optional(Vts.array(SchemaConfigProjectConnection)),
    /** Behaviour of the Sync-with-DB feature. */
    sync: Vts.optional(SchemaConfigProjectSync)
});

export type ConfigProject = ExtractSchemaResultType<typeof SchemaConfigProject>;

/**
 * HTTP server config.
 */
export const SchemaConfigServer = Vts.object({
    port: Vts.number(),
    limit: Vts.optional(Vts.string())
});

/**
 * Browser auto-open behaviour.
 */
export const SchemaConfigBrowser = Vts.object({
    open: Vts.boolean()
});

/**
 * Action a policy rule can prescribe for an MCP tool call.
 */
export enum ConfigMcpPolicyAction {
    allow = 'allow',
    ask = 'ask',
    deny = 'deny'
}

/**
 * One MCP policy rule. `match` is a wildcard pattern matched against the
 * tool name (`*` matches any run of name characters, e.g. `db_delete_*`);
 * `action` is what to do on match.
 */
export const SchemaConfigMcpPolicyRule = Vts.object({
    match: Vts.string(),
    action: Vts.enum(ConfigMcpPolicyAction)
});

export type ConfigMcpPolicyRule = ExtractSchemaResultType<typeof SchemaConfigMcpPolicyRule>;

/**
 * Client-agnostic permission policy for MCP tool calls. Rules are
 * evaluated in order against the tool name; first match wins. If no
 * rule matches, `default` applies (fallback `ask`).
 */
export const SchemaConfigMcpPolicy = Vts.object({
    default: Vts.optional(Vts.enum(ConfigMcpPolicyAction)),
    rules: Vts.optional(Vts.array(SchemaConfigMcpPolicyRule))
});

export type ConfigMcpPolicy = ExtractSchemaResultType<typeof SchemaConfigMcpPolicy>;

/**
 * Logging for the MCP endpoint. When `enabled` is true every tool call,
 * policy decision, approval request, and session event is recorded as a
 * JSON line. If `file` is set the line is appended to that file
 * (resolved against the project root); otherwise it is written to stdout
 * with an `[mcp]` prefix.
 */
export const SchemaConfigMcpLogging = Vts.object({
    enabled: Vts.boolean(),
    file: Vts.optional(Vts.string())
});

export type ConfigMcpLogging = ExtractSchemaResultType<typeof SchemaConfigMcpLogging>;

/**
 * MCP-server settings. When `enabled` is true the Vite dev server will
 * (once the `@modelcontextprotocol/sdk` is installed) expose a Model
 * Context Protocol endpoint at `path` (default `/mcp`) so Claude CLI and
 * other MCP clients can read/mutate the schema tree through the same
 * repository the web editor uses.
 *
 * The dbeditor scaffold under `editor_core/Mcp/` validates against this
 * schema today; the actual transport ships once the SDK lands.
 */
export const SchemaConfigMcp = Vts.object({
    enabled: Vts.boolean(),
    path: Vts.optional(Vts.string()),
    policy: Vts.optional(SchemaConfigMcpPolicy),
    logging: Vts.optional(SchemaConfigMcpLogging)
});

export type ConfigMcp = ExtractSchemaResultType<typeof SchemaConfigMcp>;

/**
 * Top-level config schema.
 *
 * `plugins` is the activation list for npm-installed editor plugins:
 * each entry names a package that must be `npm install`-ed into the
 * project (resolved from `<projectRoot>/node_modules/<name>`). Mere
 * installation does nothing — only entries listed here are loaded.
 * The bundled dialects + MWB plugin ship with the editor and are
 * always active without an entry here.
 *
 * `mcp` opts into the Model Context Protocol endpoint — see
 * `SchemaConfigMcp` above. Omitted ⇒ no MCP endpoint exposed.
 */
export const SchemaConfig = Vts.object({
    projects: Vts.array(SchemaConfigProject),
    server: Vts.optional(SchemaConfigServer),
    browser: Vts.optional(SchemaConfigBrowser),
    plugins: Vts.optional(Vts.array(Vts.string())),
    mcp: Vts.optional(SchemaConfigMcp)
});

export type Config = ExtractSchemaResultType<typeof SchemaConfig>;