import {ConfigDialect, ConfigOutputMode} from '../Config/Config.js';

/**
 * Resolved live-DB connection. Placeholder values from `dbeditor.json` have
 * already been substituted from `process.env`.
 */
export type DbProjectConnection = {
    databaseUnid: string;
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    /** Postgres schema name (defaults to `'public'`). Other dialects ignore. */
    schema: string;
    ssl: boolean;
    readOnly: boolean;
};

/**
 * Runtime sync-with-database settings.
 */
export type DbProjectSync = {
    ignoreTables: string[];
    ignoreColumnAttributes: string[];
};

/**
 * Runtime representation of one project from dbeditor.json.
 * Paths are absolute (resolved against the project root).
 */
export type DbProject = {
    name: string;
    schemaPath: string;
    dialect: ConfigDialect | string;
    output: {
        mode: ConfigOutputMode | string;
        destinationPath: string;
        destinationClear: boolean;
        sqlComment: boolean;
        sqlIndent: string;
        statementTerminator: string;
        migrationFilenamePattern: string;
    };
    autoGenerate: boolean;
    scripts_before_generate: { script: string; path: string; }[];
    scripts_after_generate: { script: string; path: string; }[];
    connections: DbProjectConnection[];
    sync: DbProjectSync;
};