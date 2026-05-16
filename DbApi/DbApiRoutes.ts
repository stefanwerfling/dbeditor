import * as fs from 'fs';
import * as path from 'path';
import express, {Express, Request, Response, NextFunction} from 'express';
import {SchemaErrors} from 'vts';
import {SchemaConfig} from '../Config/Config.js';
import {EnvPlaceholderError, resolveEnvPlaceholders} from '../Config/EnvPlaceholderResolver.js';
import {
    addProjectToConfig,
    updateProjectInConfig,
    removeProjectFromConfig,
    AddProjectError,
    AddProjectInput,
    UpdateProjectInput
} from '../Config/AddProject.js';
import {
    addConnectionToConfig,
    rebindConnectionInConfig,
    removeConnectionFromConfig,
    updateConnectionInConfig,
    AddConnectionInput,
    UpdateConnectionInput,
    ConnectionConfigError
} from '../Config/UpdateConnections.js';
import {DbRepositoryRegistry} from '../DbRepository/DbRepositoryRegistry.js';
import {DbFsRepository} from '../DbRepository/DbFsRepository.js';
import {DbLiveRepository} from '../DbRepository/DbLiveRepository.js';
import {DbLiveRepositoryRegistry} from '../DbRepository/DbLiveRepositoryRegistry.js';
import {RepoError} from '../DbRepository/DbRepositoryErrors.js';
import {DbFsTreeWalker} from '../DbRepository/DbFsTreeWalker.js';
import {JsonDataDB, JsonDataDBType} from '../DbEditor/JsonData.js';
import {DbGenerator, GeneratedFile} from '../DbGenerator/DbGenerator.js';
import {SchemaDiff} from '../DbDiff/SchemaDiff.js';
import {SchemaRenameHints} from '../DbDiff/ChangeTypes.js';
import {SyncGenerator} from '../DbGenerator/Sync/SyncGenerator.js';
import {pickDialect} from '../DbGenerator/DialectFactory.js';
import {buildDialectContextFromModel} from '../DbGenerator/DialectContextBuilder.js';
import {pickDriver} from '../DbConnection/DriverFactory.js';
import {SyncExecutor} from '../DbSyncExecutor/SyncExecutor.js';
import {SyncTestRunner} from '../DbSyncExecutor/SyncTestRunner.js';
import {pickDumpAdapter} from '../DbSyncExecutor/DumpAdapters/DumpAdapterFactory.js';
import {MigrationPairWriter} from '../DbSyncExecutor/MigrationPairWriter.js';
import {appendEntry, historyPathFor, loadHistory, summariseChanges} from '../DbSyncExecutor/SyncHistoryRepo.js';
import {narrowDataForScope} from '../DbGenerator/ScopeNarrow.js';
import {parseMwb} from '../DbMwbImport/MwbReader.js';
import {writeMwb} from '../DbMwbImport/MwbWriter.js';
import {generateMarkdownDocs} from '../DbDoc/MarkdownDocGenerator.js';
import * as Bodies from './DbApiRequests.js';

type RouteDeps = {
    repositories: DbRepositoryRegistry;
    liveRepositories: DbLiveRepositoryRegistry;
    runGenerate: (repo: DbFsRepository) => Promise<GeneratedFile[]>;
    /**
     * Optional restart hook. When present, the `/api/restart-server`
     * route is registered and re-runs the dev server's boot path
     * (re-reads `dbeditor.json`, re-resolves env vars, rebuilds repos).
     * The browser auto-reloads via the Vite client. Left undefined in
     * tests / non-Vite host setups.
     */
    restartServer?: () => Promise<void>;
    /**
     * Path to the resolved `dbeditor.json`. Used by the restart route
     * to revalidate the file on disk before triggering the restart, so
     * we don't kick the server into a state where it fails to boot.
     */
    configFilePath?: string;
};

const getRepo = (req: Request, res: Response, deps: RouteDeps): DbFsRepository | null => {
    const repo = deps.repositories.get(String(req.params.pid));
    if (!repo) {
        res.status(404).json({error: 'unknown project'});
        return null;
    }
    return repo;
};

const clientId = (req: Request): string | null => {
    const v = req.header('X-Client-Id');
    return v && v.length ? v : null;
};

const validate = (schema: any, body: unknown, res: Response): boolean => {
    const errors: any[] = [];
    if (!schema.validate(body, errors)) {
        res.status(400).json({error: 'invalid body', details: errors.map((e: any): string => String(e))});
        return false;
    }
    return true;
};

const handleRepoError = (err: unknown, res: Response): void => {
    if (err instanceof RepoError) {
        res.status(err.httpStatus).json({error: err.message});
        return;
    }
    console.error('[DbApi]', err);
    res.status(500).json({error: 'internal error'});
};

export const registerDbApiRoutes = (app: Express, deps: RouteDeps): void => {

    // ---------------- containers ----------------
    app.post('/api/projects/:pid/containers', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaCreateContainerBody, req.body, res)) {return;}
        try {
            const r = repo.createContainer(req.body.parentUnid, req.body.name, req.body.type as JsonDataDBType, clientId(req));
            res.json({ success: true, rev: r.rev, data: r.entry });
        } catch (err) { handleRepoError(err, res); }
    });

    app.patch('/api/projects/:pid/containers/:unid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaUpdateContainerBody, req.body, res)) {return;}
        try {
            const rev = repo.updateContainer(req.params.unid, req.body, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    app.delete('/api/projects/:pid/containers/:unid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        try {
            const rev = repo.deleteContainer(req.params.unid, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    /*
     * ---------------- database-level defaults ----------------
     * Engine / charset / collation defaults inherited by every
     * contained table. Mirrors MySQL's DB → table → column charset
     * inheritance — setting these once on the database means the
     * model side stays clean (no per-table override needed) and the
     * diff against a live DB doesn't false-positive on inherited
     * collation. See `updateDatabaseDefaults` in DbFsRepository for
     * the empty-string-clears / undefined-keeps semantics.
     */
    app.patch('/api/projects/:pid/databases/:unid/defaults', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaUpdateDatabaseDefaultsBody, req.body, res)) {return;}
        try {
            const rev = repo.updateDatabaseDefaults(req.params.unid, req.body, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    // ---------------- tables ----------------
    app.post('/api/projects/:pid/tables', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaCreateTableBody, req.body, res)) {return;}
        try {
            const r = repo.createTable(req.body.containerUnid, req.body.name, req.body.pos || null, clientId(req));
            res.json({ success: true, rev: r.rev, data: r.table });
        } catch (err) { handleRepoError(err, res); }
    });

    app.patch('/api/projects/:pid/tables/:unid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaUpdateTableBody, req.body, res)) {return;}
        try {
            const rev = repo.updateTable(req.params.unid, req.body, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    app.delete('/api/projects/:pid/tables/:unid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        try {
            const rev = repo.deleteTable(req.params.unid, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    app.post('/api/projects/:pid/tables/:unid/duplicate', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        try {
            const r = repo.duplicateTable(req.params.unid, clientId(req));
            res.json({ success: true, rev: r.rev, data: r.table });
        } catch (err) { handleRepoError(err, res); }
    });

    // ---------------- columns ----------------
    app.post('/api/projects/:pid/tables/:tid/columns', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaAddColumnBody, req.body, res)) {return;}
        try {
            const r = repo.addColumn(req.params.tid, req.body, clientId(req));
            res.json({ success: true, rev: r.rev, data: r.column });
        } catch (err) { handleRepoError(err, res); }
    });

    app.patch('/api/projects/:pid/tables/:tid/columns/:cid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaUpdateColumnBody, req.body, res)) {return;}
        try {
            const rev = repo.updateColumn(req.params.tid, req.params.cid, req.body, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    app.delete('/api/projects/:pid/tables/:tid/columns/:cid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        try {
            const rev = repo.removeColumn(req.params.tid, req.params.cid, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    app.put('/api/projects/:pid/tables/:tid/columns/order', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaReorderColumnsBody, req.body, res)) {return;}
        try {
            const rev = repo.reorderColumns(req.params.tid, req.body.order, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    // ---------------- indexes ----------------
    app.post('/api/projects/:pid/tables/:tid/indexes', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaAddIndexBody, req.body, res)) {return;}
        try {
            const r = repo.addIndex(req.params.tid, req.body, clientId(req));
            res.json({ success: true, rev: r.rev, data: r.index });
        } catch (err) { handleRepoError(err, res); }
    });

    app.patch('/api/projects/:pid/tables/:tid/indexes/:iid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaUpdateIndexBody, req.body, res)) {return;}
        try {
            const rev = repo.updateIndex(req.params.tid, req.params.iid, req.body, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    app.delete('/api/projects/:pid/tables/:tid/indexes/:iid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        try {
            const rev = repo.removeIndex(req.params.tid, req.params.iid, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    // ---------------- foreign keys ----------------
    app.post('/api/projects/:pid/tables/:tid/foreignkeys', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaAddForeignKeyBody, req.body, res)) {return;}
        try {
            const r = repo.addForeignKey(req.params.tid, req.body, clientId(req));
            res.json({ success: true, rev: r.rev, data: r.fk });
        } catch (err) { handleRepoError(err, res); }
    });

    app.patch('/api/projects/:pid/tables/:tid/foreignkeys/:fid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaUpdateForeignKeyBody, req.body, res)) {return;}
        try {
            const rev = repo.updateForeignKey(req.params.tid, req.params.fid, req.body, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    app.delete('/api/projects/:pid/tables/:tid/foreignkeys/:fid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        try {
            const rev = repo.removeForeignKey(req.params.tid, req.params.fid, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    // ---------------- enums ----------------
    app.post('/api/projects/:pid/enums', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaCreateEnumBody, req.body, res)) {return;}
        try {
            const r = repo.createEnum(req.body.containerUnid, req.body.name, req.body.pos || null, clientId(req));
            res.json({ success: true, rev: r.rev, data: r.enumNode });
        } catch (err) { handleRepoError(err, res); }
    });

    app.patch('/api/projects/:pid/enums/:unid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaUpdateEnumBody, req.body, res)) {return;}
        try {
            const rev = repo.updateEnum(req.params.unid, req.body, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    app.delete('/api/projects/:pid/enums/:unid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        try {
            const rev = repo.deleteEnum(req.params.unid, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    app.post('/api/projects/:pid/enums/:unid/values', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaAddEnumValueBody, req.body, res)) {return;}
        try {
            const r = repo.addEnumValue(req.params.unid, req.body.value, clientId(req));
            res.json({ success: true, rev: r.rev, data: r.value });
        } catch (err) { handleRepoError(err, res); }
    });

    app.patch('/api/projects/:pid/enums/:unid/values/:vid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaUpdateEnumValueBody, req.body, res)) {return;}
        try {
            const rev = repo.updateEnumValue(req.params.unid, req.params.vid, req.body.value, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    app.delete('/api/projects/:pid/enums/:unid/values/:vid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        try {
            const rev = repo.removeEnumValue(req.params.unid, req.params.vid, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    // ---------------- views ----------------
    app.post('/api/projects/:pid/views', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaCreateViewBody, req.body, res)) {return;}
        try {
            const r = repo.createView(req.body.containerUnid, req.body.name, req.body.pos || null, clientId(req));
            res.json({ success: true, rev: r.rev, data: r.view });
        } catch (err) { handleRepoError(err, res); }
    });

    app.patch('/api/projects/:pid/views/:unid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaUpdateViewBody, req.body, res)) {return;}
        try {
            const rev = repo.updateView(req.params.unid, req.body, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    app.delete('/api/projects/:pid/views/:unid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        try {
            const rev = repo.deleteView(req.params.unid, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    // ---------------- layers (visual grouping rectangles) ----------------
    app.post('/api/projects/:pid/layers', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaCreateLayerBody, req.body, res)) {return;}
        try {
            const {containerUnid, name, pos, width, height, color} = req.body;
            const result = repo.createLayer(
                containerUnid,
                name,
                pos ?? null,
                typeof width === 'number' ? width : null,
                typeof height === 'number' ? height : null,
                typeof color === 'string' ? color : null,
                clientId(req)
            );
            res.json({ success: true, rev: result.rev, layer: result.layer });
        } catch (err) { handleRepoError(err, res); }
    });

    app.patch('/api/projects/:pid/layers/:unid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaUpdateLayerBody, req.body, res)) {return;}
        try {
            const rev = repo.updateLayer(req.params.unid, req.body, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    app.delete('/api/projects/:pid/layers/:unid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        try {
            const rev = repo.deleteLayer(req.params.unid, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    // ---------------- routines (procedures / functions / triggers) ----------------
    app.post('/api/projects/:pid/routines', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaCreateRoutineBody, req.body, res)) {return;}
        try {
            const r = repo.createRoutine(req.body.containerUnid, req.body.name, req.body.kind, req.body.pos || null, clientId(req));
            res.json({ success: true, rev: r.rev, data: r.routine });
        } catch (err) { handleRepoError(err, res); }
    });

    app.patch('/api/projects/:pid/routines/:unid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaUpdateRoutineBody, req.body, res)) {return;}
        try {
            const rev = repo.updateRoutine(req.params.unid, req.body, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    app.delete('/api/projects/:pid/routines/:unid', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        try {
            const rev = repo.deleteRoutine(req.params.unid, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    /*
     * ---------------- mwb import (Workbench Phase A) ----------------
     * Accepts a raw `.mwb` file (binary ZIP); parses it server-side; on
     * success, REPLACES `data.fs` with the imported schema. The user
     * confirms in the UI; undo (Ctrl+Z) reverts the entire import since
     * replaceFs goes through `_commit` and pushes an undo snapshot.
     *
     * Body comes in via `express.raw` with the right MIME — we register
     * the parser per-route so we don't compete with the JSON parser on
     * every endpoint. Max size matches the schema-write `server.limit`
     * config (default 10mb).
     */
    app.post(
        '/api/projects/:pid/import-mwb',
        express.raw({type: 'application/octet-stream', limit: '50mb'}),
        (req, res) => {
            const repo = getRepo(req, res, deps); if (!repo) {return;}
            const buf = req.body as Buffer | undefined;
            if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
                res.status(400).json({error: 'empty body — POST the raw .mwb bytes with Content-Type: application/octet-stream'});
                return;
            }
            try {
                const result = parseMwb(buf);
                /*
                 * `mode=append` adds the imported databases to the
                 * current schema as new top-level entries; default
                 * `replace` keeps existing behaviour (clobber).
                 * Anything else returns 400 — typo-safe.
                 */
                const mode = String(req.query.mode ?? 'replace');
                let rev: number;
                if (mode === 'append') {
                    rev = repo.appendDatabases(result.databases as any, clientId(req));
                } else if (mode === 'replace') {
                    const fsRoot = {
                        unid: 'root',
                        name: 'root',
                        type: JsonDataDBType.root,
                        entrys: result.databases,
                        tables: [],
                        views: [],
                        enums: [],
                        routines: []
                    };
                    rev = repo.replaceFs(fsRoot as any, clientId(req));
                } else {
                    res.status(400).json({error: `unknown mode "${mode}" — must be "replace" or "append"`});
                    return;
                }
                res.json({
                    success: true,
                    rev: rev,
                    mode: mode,
                    stats: {
                        schemaCount: result.schemaCount,
                        tableCount: result.tableCount,
                        columnCount: result.columnCount,
                        indexCount: result.indexCount,
                        foreignKeyCount: result.foreignKeyCount,
                        positionedTableCount: result.positionedTableCount,
                        positionedViewCount: result.positionedViewCount,
                        viewCount: result.viewCount,
                        routineCount: result.routineCount,
                        triggerCount: result.triggerCount,
                        layerCount: result.layerCount
                    }
                });
            } catch (err) {
                console.error('[DbApi] import-mwb failed:', err);
                res.status(400).json({error: `import failed: ${(err as Error).message}`});
            }
        }
    );

    /*
     * ---------------- export .mwb ----------------
     * Inverse of import: serialise the project's current schema tree
     * to a Workbench-compatible `.mwb` archive and stream it back as
     * `application/octet-stream`. Lossy — only what we model survives;
     * Workbench-specific fields we don't track are emitted as empty
     * placeholders. See `DbMwbImport/MwbWriter.ts` for the full
     * description of what's preserved vs dropped.
     */
    app.post('/api/projects/:pid/export-mwb', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        try {
            const buf = writeMwb(repo.data.fs);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', String(buf.length));
            res.end(buf);
        } catch (err) {
            console.error('[DbApi] export-mwb failed:', err);
            res.status(500).json({error: `export failed: ${(err as Error).message}`});
        }
    });

    /*
     * ---------------- restart server (reload dbeditor.json) ----------------
     * Re-runs the entire dev server boot path so that edits to
     * `dbeditor.json` (new connections, new projects, env var
     * changes) take effect without the user having to ctrl-c the
     * `npm run dev` process. Pre-validates the file on disk first so
     * we don't kick the server into an unbootable state. The browser
     * full-page-reloads via the Vite client and re-fetches
     * `/api/load-schema` on the next page load (project unids will
     * have changed — `randomUUID()` per project per boot).
     *
     * Only registered when the host has supplied a `restartServer`
     * hook (Vite-as-backend setups). Tests omit it to avoid
     * accidentally tearing down the suite.
     */
    if (deps.restartServer && deps.configFilePath) {
        const restart = deps.restartServer;
        const cfgPath = deps.configFilePath;

        /*
         * ---------------- add project to dbeditor.json ----------------
         * Appends a new entry to `projects[]` and restarts the dev
         * server so the new project becomes addressable on the next
         * `/api/load-schema` call. The pure-logic merge + validation
         * lives in `Config/AddProject.ts` (unit-tested in isolation);
         * this route just handles the IO + restart side-effects.
         *
         * Only registered when the host has supplied a restartServer
         * hook — without it, the new project would be persisted to
         * disk but never loaded, which would silently confuse the
         * user. Tests omit the hook and so won't see this route.
         */
        app.post('/api/config/projects', (req, res) => {
            if (!validate(Bodies.SchemaAddProjectInput, req.body, res)) {return;}
            if (!fs.existsSync(cfgPath)) {
                res.status(400).json({error: `dbeditor.json not found at ${cfgPath}`});
                return;
            }
            let raw: unknown;
            try {
                raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            } catch (err) {
                res.status(400).json({error: `dbeditor.json is not valid JSON: ${(err as Error).message}`});
                return;
            }
            let nextConfig;
            try {
                nextConfig = addProjectToConfig(raw, req.body as AddProjectInput);
            } catch (err) {
                if (err instanceof AddProjectError) {
                    const status = err.code === 'duplicate-name' || err.code === 'duplicate-schema-path' ? 409 : 400;
                    res.status(status).json({error: err.message, code: err.code, details: err.details});
                    return;
                }
                throw err;
            }
            /*
             * Atomic write: stringify with 2-space indent (matching
             * `cli/dev.js` so a hand-edited file and a UI-written file
             * look identical), tmp+rename to avoid a partial-write
             * window if the disk dies mid-write.
             */
            const tmp = `${cfgPath}.tmp`;
            try {
                fs.writeFileSync(tmp, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf-8');
                fs.renameSync(tmp, cfgPath);
            } catch (err) {
                res.status(500).json({error: `failed to write dbeditor.json: ${(err as Error).message}`});
                return;
            }
            /*
             * Respond BEFORE the restart fires for the same reason
             * `/api/restart-server` does — `server.restart()` tears
             * down the middleware mid-flight.
             */
            res.json({success: true, project: nextConfig.projects[nextConfig.projects.length - 1]});
            restart().catch(err => console.error('[DbApi] config/projects restart failed:', err));
        });

        /*
         * ---------------- read dbeditor.json off disk ----------------
         * Shared between the connection-add and connection-remove
         * routes below. Returns `null` and writes an error response if
         * the file is missing / unparseable. The pure-logic mergers
         * each do their own VTS validation downstream, so the parse
         * step here just guarantees JSON well-formedness.
         */
        const readConfigOrFail = (res: Response): unknown | null => {
            if (!fs.existsSync(cfgPath)) {
                res.status(400).json({error: `dbeditor.json not found at ${cfgPath}`});
                return null;
            }
            try {
                return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            } catch (err) {
                res.status(400).json({error: `dbeditor.json is not valid JSON: ${(err as Error).message}`});
                return null;
            }
        };

        const writeConfigAndRestart = (nextConfig: unknown, res: Response, payload: Record<string, unknown>): void => {
            const tmp = `${cfgPath}.tmp`;
            try {
                fs.writeFileSync(tmp, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf-8');
                fs.renameSync(tmp, cfgPath);
            } catch (err) {
                res.status(500).json({error: `failed to write dbeditor.json: ${(err as Error).message}`});
                return;
            }
            res.json({success: true, ...payload});
            restart().catch(err => console.error('[DbApi] config write restart failed:', err));
        };

        const connectionErrorStatus = (code: ConnectionConfigError['code']): number => {
            switch (code) {
                case 'duplicate-connection': return 409;
                case 'unknown-project':
                case 'unknown-connection':
                    return 404;
                default: return 400;
            }
        };

        const projectErrorStatus = (code: AddProjectError['code']): number => {
            switch (code) {
                case 'duplicate-name':
                case 'duplicate-schema-path':
                    return 409;
                case 'unknown-project': return 404;
                default: return 400;
            }
        };

        /*
         * ---------------- edit project in dbeditor.json ----------------
         * Patches the active project's fields in-place. Project lookup
         * resolves the runtime `repo.project.name` (stable across the
         * config-restart cycle), so the URL is pid-keyed for
         * consistency with the rest of the per-project API surface.
         *
         * Renames and schemaPath changes are first-class — the repo's
         * `_loadFromDisk` will seed an empty schema at the new path if
         * it doesn't exist, so re-pointing is non-destructive (the
         * original file stays on disk).
         */
        app.patch('/api/projects/:pid/config', (req, res) => {
            const repo = getRepo(req, res, deps); if (!repo) {return;}
            if (!validate(Bodies.SchemaUpdateProjectInput, req.body, res)) {return;}
            const raw = readConfigOrFail(res);
            if (raw === null) {return;}
            let nextConfig;
            try {
                nextConfig = updateProjectInConfig(raw, repo.project.name, req.body as UpdateProjectInput);
            } catch (err) {
                if (err instanceof AddProjectError) {
                    res.status(projectErrorStatus(err.code)).json({error: err.message, code: err.code, details: err.details});
                    return;
                }
                throw err;
            }
            writeConfigAndRestart(nextConfig, res, {});
        });

        /*
         * ---------------- remove project from dbeditor.json ----------------
         * Drops the matching project entry. The on-disk schema file
         * (`schemaPath`) is intentionally NOT touched — removing a
         * project doesn't blow away its modelled tables; the user can
         * re-add later by pointing at the same path. Generated SQL
         * files under `output.destinationPath` are likewise left in
         * place. The UI's confirm dialog surfaces this so the user
         * understands the operation is non-destructive on disk.
         *
         * After write+restart, if this was the only project, the
         * server boots into the "no projects" state which the rest of
         * the app already handles (`/api/load-schema` returns empty
         * projects[]; the frontend renders an empty canvas).
         */
        app.delete('/api/projects/:pid/config', (req, res) => {
            const repo = getRepo(req, res, deps); if (!repo) {return;}
            const raw = readConfigOrFail(res);
            if (raw === null) {return;}
            let nextConfig;
            try {
                nextConfig = removeProjectFromConfig(raw, repo.project.name);
            } catch (err) {
                if (err instanceof AddProjectError) {
                    res.status(projectErrorStatus(err.code)).json({error: err.message, code: err.code, details: err.details});
                    return;
                }
                throw err;
            }
            writeConfigAndRestart(nextConfig, res, {});
        });

        /*
         * ---------------- add connection to project ----------------
         * Appends a new entry to the active project's `connections[]`
         * in dbeditor.json. Project lookup is by name (stable across
         * restarts) — we read `repo.project.name` off the same pid the
         * frontend already uses for all per-project routes.
         *
         * Mirrors the AddProject route: writes the file, responds,
         * then fires server.restart() so the new connection becomes
         * a real `DbProjectConnection` on the next boot. The user's
         * dialog is on the Project info screen and will be replaced
         * by the post-restart full-page reload.
         */
        app.post('/api/projects/:pid/config/connections', (req, res) => {
            const repo = getRepo(req, res, deps); if (!repo) {return;}
            if (!validate(Bodies.SchemaAddConnectionInput, req.body, res)) {return;}
            const raw = readConfigOrFail(res);
            if (raw === null) {return;}
            let nextConfig;
            try {
                nextConfig = addConnectionToConfig(raw, repo.project.name, req.body as AddConnectionInput);
            } catch (err) {
                if (err instanceof ConnectionConfigError) {
                    res.status(connectionErrorStatus(err.code)).json({error: err.message, code: err.code, details: err.details});
                    return;
                }
                throw err;
            }
            writeConfigAndRestart(nextConfig, res, {});
        });

        /*
         * ---------------- edit connection on a project ----------------
         * Patches the named connection's fields in-place. Sees the
         * same env-placeholder semantics as add: string values
         * persist verbatim. The model database the connection is
         * attached to is NOT patchable — to change it the caller
         * must delete-then-add. Restart fires on success so the
         * patched fields take effect.
         */
        app.patch('/api/projects/:pid/config/connections/:databaseUnid', (req, res) => {
            const repo = getRepo(req, res, deps); if (!repo) {return;}
            if (!validate(Bodies.SchemaUpdateConnectionInput, req.body, res)) {return;}
            const raw = readConfigOrFail(res);
            if (raw === null) {return;}
            let nextConfig;
            try {
                nextConfig = updateConnectionInConfig(
                    raw,
                    repo.project.name,
                    req.params.databaseUnid,
                    req.body as UpdateConnectionInput
                );
            } catch (err) {
                if (err instanceof ConnectionConfigError) {
                    res.status(connectionErrorStatus(err.code)).json({error: err.message, code: err.code, details: err.details});
                    return;
                }
                throw err;
            }
            writeConfigAndRestart(nextConfig, res, {});
        });

        /*
         * ---------------- rebind connection to other database ----------------
         * Swaps the connection's `databaseUnid` to a different model
         * database — preserves host/port/user/password/database/ssl/
         * readOnly. Solves the "stale databaseUnid after schema reload"
         * friction without forcing remove + re-add.
         */
        app.patch('/api/projects/:pid/config/connections/:databaseUnid/rebind', (req, res) => {
            const repo = getRepo(req, res, deps); if (!repo) {return;}
            if (!validate(Bodies.SchemaRebindConnectionInput, req.body, res)) {return;}
            const newDatabaseUnid = String((req.body as {newDatabaseUnid: string;}).newDatabaseUnid);
            /*
             * Sanity-check the target exists in the loaded model. The
             * pure-logic helper doesn't know about the schema tree —
             * only about config-file shape — so this guard goes here.
             */
            const targetNode = DbFsTreeWalker.findContainer(repo.data.fs, newDatabaseUnid);
            if (!targetNode || targetNode.type !== JsonDataDBType.database) {
                res.status(404).json({
                    error: `target databaseUnid "${newDatabaseUnid}" is not a known database in this project's schema`
                });
                return;
            }
            const raw = readConfigOrFail(res);
            if (raw === null) {return;}
            let nextConfig;
            try {
                nextConfig = rebindConnectionInConfig(
                    raw,
                    repo.project.name,
                    req.params.databaseUnid,
                    newDatabaseUnid
                );
            } catch (err) {
                if (err instanceof ConnectionConfigError) {
                    res.status(connectionErrorStatus(err.code)).json({error: err.message, code: err.code, details: err.details});
                    return;
                }
                throw err;
            }
            writeConfigAndRestart(nextConfig, res, {});
        });

        /*
         * ---------------- remove connection from project ----------------
         * Drops the connection on `:databaseUnid` and restarts.
         */
        app.delete('/api/projects/:pid/config/connections/:databaseUnid', (req, res) => {
            const repo = getRepo(req, res, deps); if (!repo) {return;}
            const raw = readConfigOrFail(res);
            if (raw === null) {return;}
            let nextConfig;
            try {
                nextConfig = removeConnectionFromConfig(raw, repo.project.name, req.params.databaseUnid);
            } catch (err) {
                if (err instanceof ConnectionConfigError) {
                    res.status(connectionErrorStatus(err.code)).json({error: err.message, code: err.code, details: err.details});
                    return;
                }
                throw err;
            }
            writeConfigAndRestart(nextConfig, res, {});
        });

        app.post('/api/restart-server', async(_req, res) => {
            if (!fs.existsSync(cfgPath)) {
                res.status(400).json({error: `dbeditor.json not found at ${cfgPath}`});
                return;
            }
            let raw: unknown;
            try {
                raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            } catch (err) {
                res.status(400).json({error: `dbeditor.json is not valid JSON: ${(err as Error).message}`});
                return;
            }
            const errors: SchemaErrors = [];
            if (!SchemaConfig.validate(raw, errors)) {
                res.status(400).json({error: 'dbeditor.json failed validation', details: errors.map(e => String(e))});
                return;
            }
            try {
                resolveEnvPlaceholders(raw);
            } catch (err) {
                if (err instanceof EnvPlaceholderError) {
                    res.status(400).json({error: err.message});
                    return;
                }
                throw err;
            }
            /*
             * Send the response BEFORE triggering restart — once
             * `server.restart()` runs, the middleware is torn down
             * and `res.json()` would race with the shutdown.
             */
            res.json({success: true});
            /*
             * Fire-and-forget: any error during restart shows up in
             * the server logs. The browser sees the connection drop
             * and reloads via the Vite client; that's the only
             * feedback path we need.
             */
            restart().catch(err => console.error('[DbApi] restart-server failed:', err));
        });
    }

    // ---------------- schema replace (import) ----------------
    app.put('/api/projects/:pid/schema', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaReplaceFsBody, req.body, res)) {return;}
        try {
            const rev = repo.replaceFs(req.body.fs, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    // ---------------- undo / redo ----------------
    app.post('/api/projects/:pid/undo', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        const r = repo.undo(clientId(req));
        res.json({ success: true, applied: r.applied, rev: r.rev, canUndo: repo.canUndo, canRedo: repo.canRedo });
    });

    app.post('/api/projects/:pid/redo', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        const r = repo.redo(clientId(req));
        res.json({ success: true, applied: r.applied, rev: r.rev, canUndo: repo.canUndo, canRedo: repo.canRedo });
    });

    // ---------------- editor settings ----------------
    app.put('/api/projects/:pid/editor-settings', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaUpdateEditorSettingsBody, req.body, res)) {return;}
        try {
            const rev = repo.updateEditorSettings(req.body, clientId(req));
            res.json({ success: true, rev: rev });
        } catch (err) { handleRepoError(err, res); }
    });

    /*
     * ---------------- sync settings ----------------
     * Returns the *effective* sync config (dbeditor.json defaults overlaid
     * with persisted UI overrides) on GET, persists overrides on PUT.
     * Routes that consume it (preview / apply / reverse-apply) all read
     * via `repo.effectiveSync()` so this is the single source of truth.
     */
    app.get('/api/projects/:pid/sync-settings', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        res.json({ success: true, sync: repo.effectiveSync() });
    });

    /*
     * ---------------- project info (read-only) ----------------
     * Aggregates everything the server resolved from `dbeditor.json` +
     * env vars + the schema file's override layers into one read-only
     * payload. Passwords are masked — the response is safe to render
     * verbatim in the UI. Used by the "Project info" dialog so the user
     * doesn't have to read `dbeditor.json` and mentally resolve env vars
     * to verify their config.
     */
    app.get('/api/projects/:pid/info', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        const p = repo.project;
        /*
         * Resolve each connection's `databaseUnid` to the human-readable
         * model database name. The user sees the raw UUID in
         * `dbeditor.json` and can't easily tell which database it maps
         * to; surfacing the name here eliminates that lookup step.
         * Returns `null` when the UUID doesn't resolve (stale config) —
         * the UI renders that as a "— missing —" badge.
         */
        const modelRoot = repo.data.fs;
        res.json({
            success: true,
            info: {
                name: p.name,
                dialect: String(p.dialect),
                schemaPath: p.schemaPath,
                autoGenerate: p.autoGenerate,
                output: repo.effectiveOutput(),
                sync: repo.effectiveSync(),
                connections: p.connections.map(c => {
                    const db = DbFsTreeWalker.findContainer(modelRoot, c.databaseUnid);
                    return {
                        databaseUnid: c.databaseUnid,
                        databaseName: db ? db.name : null,
                        host: c.host,
                        port: c.port,
                        user: c.user,
                        database: c.database,
                        ssl: c.ssl,
                        readOnly: c.readOnly,
                        /*
                         * Three states: null = no password configured, '***' =
                         * password is set (length omitted on purpose so the
                         * UI can't infer entropy), '' shouldn't happen.
                         */
                        passwordSet: Boolean(c.password)
                    };
                }),
                scriptsBeforeGenerate: p.scripts_before_generate.map(s => ({path: s.path, script: s.script})),
                scriptsAfterGenerate: p.scripts_after_generate.map(s => ({path: s.path, script: s.script}))
            }
        });
    });

    app.put('/api/projects/:pid/sync-settings', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaUpdateSyncSettingsBody, req.body, res)) {return;}
        try {
            const rev = repo.updateSyncSettings(req.body, clientId(req));
            res.json({ success: true, rev: rev, sync: repo.effectiveSync() });
        } catch (err) { handleRepoError(err, res); }
    });

    /*
     * ---------------- output settings ----------------
     * Same pattern as sync-settings: dbeditor.json defaults + per-project
     * UI overrides persisted in the schema file. The route returns the
     * *effective* output (merged) so the dialog can show the live config
     * even when no overrides are set.
     */
    app.get('/api/projects/:pid/output-settings', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        res.json({ success: true, output: repo.effectiveOutput() });
    });

    app.put('/api/projects/:pid/output-settings', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaUpdateOutputSettingsBody, req.body, res)) {return;}
        try {
            const rev = repo.updateOutputSettings(req.body, clientId(req));
            res.json({ success: true, rev: rev, output: repo.effectiveOutput() });
        } catch (err) { handleRepoError(err, res); }
    });

    /*
     * ---------------- live introspection ----------------
     * Lightweight wrappers around DbLiveRepository. Connection-config
     * lookups happen inside the repo — routes just route.
     */
    const getLiveRepo = (req: Request, res: Response): DbLiveRepository | null => {
        const repo = deps.liveRepositories.get(String(req.params.pid));
        if (!repo) {
            res.status(404).json({error: 'unknown project'});
            return null;
        }
        return repo;
    };

    app.get('/api/projects/:pid/live/snapshot', (req, res) => {
        const live = getLiveRepo(req, res); if (!live) {return;}
        res.json({success: true, snapshot: live.snapshot()});
    });

    app.post('/api/projects/:pid/live/refresh', async(req, res) => {
        const live = getLiveRepo(req, res); if (!live) {return;}
        if (!validate(Bodies.SchemaLiveRefreshBody, req.body, res)) {return;}
        try {
            const tree = await live.refresh(req.body.databaseUnid);
            res.json({success: true, rev: live.rev, data: tree});
        } catch (err) {
            res.status(500).json({error: (err as Error).message});
        }
    });

    app.post('/api/projects/:pid/connection/test', async(req, res) => {
        const live = getLiveRepo(req, res); if (!live) {return;}
        if (!validate(Bodies.SchemaConnectionTestBody, req.body, res)) {return;}
        try {
            await live.testConnection(req.body.databaseUnid, req.body.patch);
            res.json({success: true});
        } catch (err) {
            res.status(500).json({error: (err as Error).message});
        }
    });

    /*
     * ---------------- ad-hoc connection test ----------------
     * Verifies arbitrary credentials WITHOUT touching the
     * project's saved `connections[]`. Used by the
     * Add/EditConnectionDialog so the user can iterate on host /
     * port / password before committing — saving currently
     * triggers a server restart, so testing in-dialog saves the
     * delete+re-add loop on bad credentials.
     *
     * Env-placeholder resolution mirrors what happens at boot:
     * `${VAR}` and `${VAR:-default}` substitutions run against
     * `process.env` before we hand the config to the driver, so
     * "Test" behaves the same as a saved-and-restarted
     * connection. Resolution failures (undefined var, no default)
     * surface as a 400 with the variable name so the user knows
     * what to set in `.env`.
     */
    app.post('/api/connection/test-ad-hoc', async(req, res) => {
        if (!validate(Bodies.SchemaConnectionTestAdHocBody, req.body, res)) {return;}
        let resolved: any;
        try {
            resolved = resolveEnvPlaceholders(req.body);
        } catch (err) {
            if (err instanceof EnvPlaceholderError) {
                res.status(400).json({error: err.message});
                return;
            }
            throw err;
        }
        const dialect: string = String(resolved.dialect);
        let driver;
        try {
            driver = pickDriver(dialect);
        } catch (err) {
            res.status(400).json({error: (err as Error).message});
            return;
        }
        const cfg = {
            databaseUnid: '__ad-hoc__',
            host: String(resolved.host),
            port: typeof resolved.port === 'number' ? resolved.port : 3306,
            user: String(resolved.user),
            password: typeof resolved.password === 'string' ? resolved.password : '',
            database: String(resolved.database),
            ssl: resolved.ssl === true,
            readOnly: false
        };
        try {
            const conn = await driver.connect(cfg);
            try {
                await conn.query('SELECT 1');
            } finally {
                await conn.close().catch((err: unknown): void => console.error('[DbApi] test-ad-hoc close failed:', err));
            }
            res.json({success: true});
        } catch (err) {
            res.status(500).json({error: (err as Error).message});
        }
    });

    /*
     * ---------------- sync ----------------
     * Preview: introspect → diff → render SQL. The change-set returned has
     * every change's `sql[]` array filled by the SyncGenerator.
     */
    app.post('/api/projects/:pid/sync/preview', async(req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        const live = getLiveRepo(req, res); if (!live) {return;}
        if (!validate(Bodies.SchemaSyncPreviewBody, req.body, res)) {return;}
        try {
            const databaseUnid = String(req.body.databaseUnid);
            const tree = await live.refresh(databaseUnid);
            const modelRoot = repo.data.fs;
            const modelDb = DbFsTreeWalker.findContainer(modelRoot, databaseUnid);
            if (!modelDb || modelDb.type !== JsonDataDBType.database) {
                res.status(404).json({error: `model database "${databaseUnid}" not found`});
                return;
            }
            const layerUnid = typeof req.body.layerUnid === 'string' && req.body.layerUnid !== '' ? req.body.layerUnid : undefined;
            const renames = req.body.renames as SchemaRenameHints | undefined;
            const changeSet = SchemaDiff.diff(modelDb as JsonDataDB, tree, repo.effectiveSync(), modelRoot, layerUnid, renames);
            const dialect = pickDialect(repo.project.dialect);
            const ctx = buildDialectContextFromModel(modelRoot, repo.effectiveProject.output.sqlIndent, repo.effectiveProject.output.statementTerminator, repo.effectiveProject.output.sqlComment);
            const statements = SyncGenerator.generate(changeSet, modelDb as JsonDataDB, dialect, ctx);
            /*
             * Surface the model database's defaults alongside the
             * preview so the SyncDialog inspector can show effective
             * (per-table-options-with-fallback) values for engine /
             * charset / collation. Live-side defaults come from the
             * introspector's table-level + DB-level SCHEMATA query
             * which is already reflected in tree.tables[].options.
             */
            const modelDefaults = {
                engine: (modelDb as JsonDataDB).defaultEngine ?? '',
                charset: (modelDb as JsonDataDB).defaultCharset ?? '',
                collation: (modelDb as JsonDataDB).defaultCollation ?? ''
            };
            res.json({success: true, changeSet: changeSet, statements: statements, modelDefaults: modelDefaults});
        } catch (err) {
            console.error('[DbApi] sync/preview failed:', err);
            res.status(500).json({error: (err as Error).message});
        }
    });

    /*
     * Apply: re-runs the preview pipeline filtered to the user-picked change
     * IDs, executes statement-by-statement against the live DB, and on
     * non-dry-run success writes the migration pair to disk. The live repo
     * is refreshed afterwards so a subsequent preview shows zero changes.
     */
    app.post('/api/projects/:pid/sync/apply', async(req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        const live = getLiveRepo(req, res); if (!live) {return;}
        if (!validate(Bodies.SchemaSyncApplyBody, req.body, res)) {return;}
        const requestStartedAt = Date.now();
        try {
            const databaseUnid = String(req.body.databaseUnid);
            const changeIds = new Set<string>((req.body.changeIds as string[]).map(String));
            const dryRun = req.body.dryRun === true;
            if (changeIds.size === 0) {
                res.status(400).json({error: 'changeIds is empty — nothing to apply'});
                return;
            }
            const cfg = live.getConnectionConfig(databaseUnid);
            if (!cfg) {
                res.status(400).json({error: `no live connection configured for "${databaseUnid}"`});
                return;
            }
            if (cfg.readOnly && !dryRun) {
                res.status(403).json({error: 'connection is marked readOnly; apply rejected'});
                return;
            }

            const tree = await live.refresh(databaseUnid);
            const modelRoot = repo.data.fs;
            const modelDb = DbFsTreeWalker.findContainer(modelRoot, databaseUnid);
            if (!modelDb || modelDb.type !== JsonDataDBType.database) {
                res.status(404).json({error: `model database "${databaseUnid}" not found`});
                return;
            }
            const layerUnid = typeof req.body.layerUnid === 'string' && req.body.layerUnid !== '' ? req.body.layerUnid : undefined;
            const renames = req.body.renames as SchemaRenameHints | undefined;
            const fullChangeSet = SchemaDiff.diff(modelDb as JsonDataDB, tree, repo.effectiveSync(), modelRoot, layerUnid, renames);
            const selectedChanges = fullChangeSet.changes.filter(c => changeIds.has(c.id));
            if (selectedChanges.length === 0) {
                /*
                 * Either the user deselected everything, or the live state
                 * shifted between preview and apply and our change IDs are
                 * stale. Either way: stop and let the UI re-run preview.
                 */
                res.status(409).json({error: 'no matching changes — re-run preview and try again'});
                return;
            }
            const filteredSet = {...fullChangeSet, changes: selectedChanges};
            const dialect = pickDialect(repo.project.dialect);
            const ctx = buildDialectContextFromModel(modelRoot, repo.effectiveProject.output.sqlIndent, repo.effectiveProject.output.statementTerminator, repo.effectiveProject.output.sqlComment);
            const statements = SyncGenerator.generate(filteredSet, modelDb as JsonDataDB, dialect, ctx);

            const driver = pickDriver(repo.project.dialect);
            const conn = await driver.connect(cfg);
            let statementResults;
            try {
                statementResults = await SyncExecutor.run(conn, statements, {dryRun: dryRun});
            } finally {
                try { await conn.close(); } catch (e) { console.error('[DbApi] sync/apply close failed:', e); }
            }

            const allOk = statementResults.length === statements.length && statementResults.every(r => r.ok);

            let migrationFiles: {up: string; down: string;} | undefined;
            if (allOk && !dryRun) {
                migrationFiles = MigrationPairWriter.write(
                    repo.effectiveProject,
                    modelDb as JsonDataDB,
                    tree,
                    modelRoot,
                    selectedChanges,
                    statements,
                    dialect,
                    ctx
                );
                /*
                 * Refresh the live cache so the next preview reflects the
                 * post-apply state. We don't block on the result — surface
                 * apply success regardless and let the SSE event update the
                 * UI when the refresh lands.
                 */
                live.refresh(databaseUnid).catch((err: unknown): void => {
                    console.error('[DbApi] post-apply live refresh failed:', err);
                });
            }

            /*
             * Persist a history entry — best-effort, never throws.
             * Dry-runs aren't logged (they're preview-grade); only
             * real applies leave a trace.
             */
            if (!dryRun) {
                appendEntry(historyPathFor(repo.project.schemaPath), {
                    mode: 'apply',
                    dialect: repo.project.dialect,
                    databaseUnid: databaseUnid,
                    databaseName: (modelDb as JsonDataDB).name,
                    layerUnid: layerUnid,
                    selectedChangeIds: selectedChanges.map(c => c.id),
                    changeSetSummary: summariseChanges(selectedChanges),
                    statementResults: statementResults,
                    migrationFiles: migrationFiles,
                    success: allOk,
                    durationMs: Date.now() - requestStartedAt
                });
            }

            res.json({
                success: allOk,
                dryRun: dryRun,
                statementResults: statementResults,
                migrationFiles: migrationFiles
            });
        } catch (err) {
            console.error('[DbApi] sync/apply failed:', err);
            res.status(500).json({error: (err as Error).message});
        }
    });

    /*
     * Reverse-apply: instead of pushing model→live SQL, pull live→model
     * structurally. For each selected change we mutate the local model so
     * it adopts the live state (e.g. `columnAdded` in the diff becomes
     * "drop from model"; `columnChanged` copies live attrs into the model
     * column). No SQL is generated, no live DB write happens — this is a
     * pure model-side mutation.
     */
    app.post('/api/projects/:pid/sync/reverse-apply', async(req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        const live = getLiveRepo(req, res); if (!live) {return;}
        if (!validate(Bodies.SchemaSyncReverseApplyBody, req.body, res)) {return;}
        const requestStartedAt = Date.now();
        try {
            const databaseUnid = String(req.body.databaseUnid);
            const changeIds = new Set<string>((req.body.changeIds as string[]).map(String));
            if (changeIds.size === 0) {
                res.status(400).json({error: 'changeIds is empty — nothing to reverse-apply'});
                return;
            }

            const tree = await live.refresh(databaseUnid);
            const modelRoot = repo.data.fs;
            const modelDb = DbFsTreeWalker.findContainer(modelRoot, databaseUnid);
            if (!modelDb || modelDb.type !== JsonDataDBType.database) {
                res.status(404).json({error: `model database "${databaseUnid}" not found`});
                return;
            }
            const layerUnid = typeof req.body.layerUnid === 'string' && req.body.layerUnid !== '' ? req.body.layerUnid : undefined;
            const renames = req.body.renames as SchemaRenameHints | undefined;
            const fullChangeSet = SchemaDiff.diff(modelDb as JsonDataDB, tree, repo.effectiveSync(), modelRoot, layerUnid, renames);
            const selectedChanges = fullChangeSet.changes.filter(c => changeIds.has(c.id));
            if (selectedChanges.length === 0) {
                res.status(409).json({error: 'no matching changes — re-run preview and try again'});
                return;
            }
            const result = repo.applyReverseSync(databaseUnid, selectedChanges, tree, clientId(req));
            /*
             * History: reverse-apply doesn't run statements against
             * the live DB, so there's no statementResults. We still
             * persist the change-set summary + appliedChangeIds so
             * the user can trace "when did I adopt live state into
             * the model?" in the history view.
             */
            appendEntry(historyPathFor(repo.project.schemaPath), {
                mode: 'reverse-apply',
                dialect: repo.project.dialect,
                databaseUnid: databaseUnid,
                databaseName: (modelDb as JsonDataDB).name,
                layerUnid: layerUnid,
                selectedChangeIds: selectedChanges.map(c => c.id),
                changeSetSummary: summariseChanges(selectedChanges),
                statementResults: [],
                appliedChangeIds: result.appliedChangeIds,
                success: true,
                durationMs: Date.now() - requestStartedAt
            });
            res.json({
                success: true,
                rev: result.rev,
                appliedChangeIds: result.appliedChangeIds,
                requestedCount: selectedChanges.length
            });
        } catch (err) {
            console.error('[DbApi] sync/reverse-apply failed:', err);
            res.status(500).json({error: (err as Error).message});
        }
    });

    /*
     * ---------------- test-run (dump → apply → restore) ----------------
     * Dumps the live DB, runs the selected statements against it for
     * real, then ALWAYS restores from the dump. Returns a structured
     * result describing what happened — including a `critical` flag
     * when the restore itself failed and manual recovery is needed.
     *
     * MySQL/MariaDB only this iteration — Postgres/SQLite return 501.
     * The connection user needs RELOAD + LOCK TABLES + DROP +
     * CREATE permissions; for typical dev `root` accounts this is fine.
     */
    app.post('/api/projects/:pid/sync/test-run', async(req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        const live = getLiveRepo(req, res); if (!live) {return;}
        if (!validate(Bodies.SchemaSyncTestRunBody, req.body, res)) {return;}
        const requestStartedAt = Date.now();
        try {
            const databaseUnid = String(req.body.databaseUnid);
            const changeIds = new Set<string>((req.body.changeIds as string[]).map(String));
            if (changeIds.size === 0) {
                res.status(400).json({error: 'changeIds is empty — nothing to test'});
                return;
            }
            const cfg = live.getConnectionConfig(databaseUnid);
            if (!cfg) {
                res.status(400).json({error: `no live connection configured for "${databaseUnid}"`});
                return;
            }
            if (cfg.readOnly) {
                res.status(403).json({error: 'connection is marked readOnly; test-run rejected'});
                return;
            }

            let adapter;
            try {
                adapter = pickDumpAdapter(repo.project.dialect);
            } catch (err) {
                res.status(501).json({error: (err as Error).message});
                return;
            }

            const tree = await live.refresh(databaseUnid);
            const modelRoot = repo.data.fs;
            const modelDb = DbFsTreeWalker.findContainer(modelRoot, databaseUnid);
            if (!modelDb || modelDb.type !== JsonDataDBType.database) {
                res.status(404).json({error: `model database "${databaseUnid}" not found`});
                return;
            }
            const layerUnid = typeof req.body.layerUnid === 'string' && req.body.layerUnid !== '' ? req.body.layerUnid : undefined;
            const renames = req.body.renames as SchemaRenameHints | undefined;
            const fullChangeSet = SchemaDiff.diff(modelDb as JsonDataDB, tree, repo.effectiveSync(), modelRoot, layerUnid, renames);
            const selectedChanges = fullChangeSet.changes.filter(c => changeIds.has(c.id));
            if (selectedChanges.length === 0) {
                res.status(409).json({error: 'no matching changes — re-run preview and try again'});
                return;
            }
            const filteredSet = {...fullChangeSet, changes: selectedChanges};
            const dialect = pickDialect(repo.project.dialect);
            const ctx = buildDialectContextFromModel(modelRoot, repo.effectiveProject.output.sqlIndent, repo.effectiveProject.output.statementTerminator, repo.effectiveProject.output.sqlComment);
            const statements = SyncGenerator.generate(filteredSet, modelDb as JsonDataDB, dialect, ctx);

            /*
             * Dump path: `<destinationPath>/sync-tests/<ts>__<db>.sql`.
             * Timestamp first so the directory sorts chronologically.
             */
            const ts = new Date().toISOString().replace(/[:.]/gu, '-');
            const dumpDir = path.resolve(repo.effectiveProject.output.destinationPath, 'sync-tests');
            const dumpFile = `${ts}__${cfg.database}.sql`;
            const dumpPath = path.join(dumpDir, dumpFile);

            const purgeOnSuccess = req.body.purgeOnSuccess !== false;

            const driver = pickDriver(repo.project.dialect);
            const conn = await driver.connect(cfg);
            let result;
            try {
                result = await SyncTestRunner.run(adapter, cfg, conn, statements, dumpPath, {purgeOnSuccess: purgeOnSuccess});
            } finally {
                try { await conn.close(); } catch (e) { console.error('[DbApi] sync/test-run close failed:', e); }
            }
            /*
             * Refresh the live cache after every test-run (even
             * successful ones) — the dump/restore round-trip touches
             * the DB and the cache may have been computed against a
             * mid-test snapshot if something went wrong.
             */
            live.refresh(databaseUnid).catch((err: unknown): void => {
                console.error('[DbApi] post-test-run live refresh failed:', err);
            });

            /*
             * History entry — every test-run goes into the log,
             * including failed ones (especially failed ones — the
             * dump path and statement results are the diagnosis).
             */
            appendEntry(historyPathFor(repo.project.schemaPath), {
                mode: 'test-run',
                dialect: repo.project.dialect,
                databaseUnid: databaseUnid,
                databaseName: (modelDb as JsonDataDB).name,
                layerUnid: layerUnid,
                selectedChangeIds: selectedChanges.map(c => c.id),
                changeSetSummary: summariseChanges(selectedChanges),
                statementResults: result.statementResults,
                dumpPath: result.dumpPath,
                dumpKept: result.dumpKept,
                dumpSizeBytes: result.dumpSizeBytes,
                success: result.success,
                critical: result.critical,
                restoreOk: result.restoreOk,
                restoreError: result.restoreError,
                failedAtIndex: result.failedAtIndex,
                durationMs: Date.now() - requestStartedAt
            });

            res.json(result);
        } catch (err) {
            console.error('[DbApi] sync/test-run failed:', err);
            res.status(500).json({error: (err as Error).message});
        }
    });

    /*
     * ---------------- sync history list ----------------
     * Returns all persisted entries newest-first. Optional ?limit
     * caps the list — useful for the dialog's initial render when
     * the history file has grown large.
     */
    app.get('/api/projects/:pid/sync/history', (req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined;
        try {
            const all = loadHistory(historyPathFor(repo.project.schemaPath));
            const entries = limit ? all.slice(0, limit) : all;
            res.json({success: true, entries: entries, total: all.length});
        } catch (err) {
            console.error('[DbApi] sync/history list failed:', err);
            res.status(500).json({error: (err as Error).message});
        }
    });

    // ---------------- generate (scoped, preview-only) ----------------
    app.post('/api/projects/:pid/generate/scoped', async(req, res) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        if (!validate(Bodies.SchemaGenerateScopedBody, req.body, res)) {return;}
        const databaseUnid = req.body.databaseUnid as string | undefined;
        const tableUnid = req.body.tableUnid as string | undefined;
        const tableUnids = req.body.tableUnids as string[] | undefined;
        const hasAny = Boolean(databaseUnid) || Boolean(tableUnid) || (tableUnids && tableUnids.length > 0);
        if (!hasAny) {
            res.status(400).json({error: 'databaseUnid, tableUnid, or tableUnids required'});
            return;
        }
        try {
            await repo.flush();
            const narrowed = narrowDataForScope(repo.data, {
                databaseUnid: databaseUnid,
                tableUnid: tableUnid,
                tableUnids: tableUnids
            });
            const generator = new DbGenerator();
            const files = await generator.generate(repo.effectiveProject, narrowed, {dryRun: true});
            const root = repo.effectiveProject.output.destinationPath;
            const out = files.map(f => ({
                path: f.path,
                relativePath: path.relative(root, f.path) || path.basename(f.path),
                content: f.content
            }));
            res.json({
                success: true,
                root: root,
                files: out,
                scope: {databaseUnid: databaseUnid, tableUnid: tableUnid, tableUnids: tableUnids}
            });
        } catch (err) {
            console.error('[DbApi] generate/scoped failed:', err);
            res.status(500).json({error: (err as Error).message});
        }
    });

    /*
     * ---------------- generate Markdown docs ----------------
     * Pure-content render of the schema for human reading: one
     * `.md` document per database, with a TOC and per-table
     * sections (columns + indexes + outgoing/incoming FKs). No
     * dialect dependency — the generator works straight off the
     * `JsonDataDB` tree. We return a `GeneratedFile`-shaped payload
     * so the existing SqlPreviewDialog renders it without a new
     * preview component.
     *
     * Output dir is `<destinationPath>/docs` so SQL and docs live
     * side-by-side. Writes are atomic-ish per file (mkdir + plain
     * writeFileSync); pass `{dryRun: true}` to surface the preview
     * payload without touching disk — the SqlPreviewDialog handles
     * either case (it just renders what the response provides).
     */
    app.post('/api/projects/:pid/docs/generate', async(req, res, next: NextFunction) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        try {
            await repo.flush();
            const dryRun = req.body?.dryRun === true;
            const docs = generateMarkdownDocs(repo.data.fs);
            const docsRoot = path.join(repo.effectiveProject.output.destinationPath, 'docs');
            if (!dryRun && docs.length > 0) {
                if (!fs.existsSync(docsRoot)) {fs.mkdirSync(docsRoot, {recursive: true});}
                for (const d of docs) {
                    fs.writeFileSync(path.join(docsRoot, d.path), d.content);
                }
            }
            const out = docs.map(d => ({
                path: path.join(docsRoot, d.path),
                relativePath: path.join('docs', d.path),
                content: d.content
            }));
            res.json({success: true, root: docsRoot, files: out, dryRun: dryRun});
        } catch (err) { next(err); }
    });

    // ---------------- generate ----------------
    app.post('/api/projects/:pid/generate', async(req, res, next: NextFunction) => {
        const repo = getRepo(req, res, deps); if (!repo) {return;}
        try {
            await repo.flush();
            const files = await deps.runGenerate(repo);
            /*
             * Surface paths relative to the project's output dir when
             * possible so the preview dialog can show short labels
             * without leaking absolute filesystem paths from the host.
             */
            const root = repo.effectiveProject.output.destinationPath;
            const out = files.map(f => ({
                path: f.path,
                relativePath: path.relative(root, f.path) || path.basename(f.path),
                content: f.content
            }));
            res.json({ success: true, root: root, files: out });
        } catch (err) { next(err); }
    });
};