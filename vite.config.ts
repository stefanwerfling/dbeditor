import dotenv from 'dotenv';
import express, {Request, Response} from 'express';
import * as fs from 'fs';
import * as path from 'path';
import {randomUUID} from 'crypto';
import {defineConfig, Plugin} from 'vite';
import {SchemaErrors} from 'vts';
import {ConfigDialect, ConfigOutputMode, SchemaConfig} from './Config/Config.js';
import {EnvPlaceholderError, resolveEnvPlaceholders} from './Config/EnvPlaceholderResolver.js';
import {DbProject, DbProjectConnection} from './DbProject/DbProject.js';
import {DbFsRepository} from './DbRepository/DbFsRepository.js';
import {DbRepositoryRegistry} from './DbRepository/DbRepositoryRegistry.js';
import {DbLiveRepository} from './DbRepository/DbLiveRepository.js';
import {DbLiveRepositoryRegistry} from './DbRepository/DbLiveRepositoryRegistry.js';
import {DbRepositoryEvent} from './DbRepository/DbRepositoryEventTypes.js';
import {registerDbApiRoutes} from './DbApi/DbApiRoutes.js';
import {DbGenerator, GeneratedFile} from './DbGenerator/DbGenerator.js';

function expressMiddleware(): Plugin {
    return {
        name: 'vite-express-middleware',
        configureServer(server) {
            const app = express();
            app.use(express.json({ limit: '50mb' }));
            app.use(express.urlencoded({ limit: '50mb', extended: true }));

            const configFile = process.env.DBEDITOR_CONFIG_FILE;
            const projectRoot = process.env.DBEDITOR_PROJECT_ROOT ?? process.cwd();

            // load .env if present
            const envPath = path.resolve(projectRoot, '.env');
            if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

            const repositories = new DbRepositoryRegistry();
            const liveRepositories = new DbLiveRepositoryRegistry();
            // unid -> projectName, used for /api/load-schema response
            const unidByName = new Map<string, string>();

            if (configFile && fs.existsSync(configFile)) {
                const rawConfig = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
                const errors: SchemaErrors = [];
                if (!SchemaConfig.validate(rawConfig, errors)) {
                    console.error('[dbeditor] dbeditor.json failed validation:');
                    console.error(errors);
                    return;
                }
                let config: typeof rawConfig;
                try {
                    config = resolveEnvPlaceholders(rawConfig);
                } catch (err) {
                    if (err instanceof EnvPlaceholderError) {
                        console.error(`[dbeditor] ${err.message}`);
                        return;
                    }
                    throw err;
                }
                if (config.server?.limit) {
                    app.use(express.json({ limit: config.server.limit }));
                    app.use(express.urlencoded({ limit: config.server.limit, extended: true }));
                }

                for (const cp of config.projects) {
                    const connections: DbProjectConnection[] = (cp.connections ?? []).map((c: any) => ({
                        databaseUnid: c.databaseUnid,
                        host: c.host,
                        port: c.port ?? 3306,
                        user: c.user,
                        password: c.password ?? '',
                        database: c.database,
                        schema: c.schema ?? 'public',
                        ssl: c.ssl ?? false,
                        readOnly: c.readOnly ?? false
                    }));

                    const project: DbProject = {
                        name: cp.name ?? 'MyDatabase',
                        schemaPath: path.resolve(projectRoot, cp.schemaPath),
                        dialect: cp.dialect ?? ConfigDialect.mysql,
                        output: {
                            mode: cp.output.mode ?? ConfigOutputMode.ddl_files,
                            destinationPath: path.resolve(projectRoot, cp.output.destinationPath),
                            destinationClear: cp.output.destinationClear ?? false,
                            sqlComment: cp.output.sqlComment ?? true,
                            sqlIndent: cp.output.sqlIndent ?? '    ',
                            statementTerminator: cp.output.statementTerminator ?? ';',
                            migrationFilenamePattern: cp.output.migrationFilenamePattern ?? '{timestamp}__{name}'
                        },
                        autoGenerate: cp.autoGenerate ?? false,
                        scripts_before_generate: cp.scripts?.before_generate ?? [],
                        scripts_after_generate: cp.scripts?.after_generate ?? [],
                        connections: connections,
                        sync: {
                            ignoreTables: cp.sync?.ignoreTables ?? [],
                            ignoreColumnAttributes: cp.sync?.ignoreColumnAttributes ?? []
                        }
                    };

                    const repo = new DbFsRepository(project);
                    const liveRepo = new DbLiveRepository(project);
                    const unid = randomUUID();
                    repositories.register(unid, repo);
                    liveRepositories.register(unid, liveRepo);
                    unidByName.set(unid, project.name);

                    if (project.autoGenerate) {
                        repo.setAfterFlush(async (r) => { await runGenerate(r); });
                    }

                    console.log(`[dbeditor] Project: ${project.name}`);
                    console.log(`           dialect: ${project.dialect}`);
                    console.log(`           schema:  ${project.schemaPath}`);
                    console.log(`           output:  ${project.output.destinationPath} (${project.output.mode})`);
                    console.log(`           auto:    ${project.autoGenerate}`);
                }
            } else {
                console.warn('[dbeditor] no config file found, /api/load-schema will return empty');
            }

            // -------- shutdown flushes --------
            const flushOnExit = (): void => { void repositories.flushAll(); };
            process.once('SIGINT', flushOnExit);
            process.once('SIGTERM', flushOnExit);
            process.once('beforeExit', flushOnExit);

            // -------- generator --------
            const generator = new DbGenerator();
            const runGenerate = async (repo: DbFsRepository): Promise<GeneratedFile[]> => {
                try {
                    const files = await generator.generate(repo.effectiveProject, repo.data);
                    console.log(`[dbeditor] generated SQL for ${repo.project.name} (${files.length} files)`);
                    return files;
                } catch (err) {
                    console.error(`[dbeditor] generate failed for ${repo.project.name}:`, err);
                    throw err;
                }
            };

            // -------- /api/load-schema --------
            app.get('/api/load-schema', (_req: Request, res: Response) => {
                const projects = [] as any[];
                for (const [unid, repo] of repositories.entries()) {
                    /*
                     * Surface only which database containers have a live
                     * connection configured — never the credentials. The
                     * frontend uses this flag to decide whether to render
                     * the "Sync with DB" affordance.
                     */
                    const connectableDatabaseUnids = repo.project.connections.map(c => c.databaseUnid);
                    projects.push({
                        unid,
                        name: repo.project.name,
                        dialect: String(repo.project.dialect),
                        outputMode: String(repo.effectiveProject.output.mode),
                        autoGenerate: repo.project.autoGenerate,
                        connectableDatabaseUnids: connectableDatabaseUnids,
                        rev: repo.rev,
                        data: repo.data.fs,
                        editor: repo.data.editor,
                        canUndo: repo.canUndo,
                        canRedo: repo.canRedo
                    });
                }
                res.json({ projects });
            });

            // -------- SSE stream of mutations --------
            app.get('/api/projects/:pid/events', (req: Request, res: Response) => {
                const repo = repositories.get(String(req.params.pid));
                if (!repo) { res.status(404).end(); return; }
                res.set({
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no'
                });
                res.flushHeaders();

                const lastEventId = Number(req.header('Last-Event-ID') ?? req.query.last_event_id ?? '0') || 0;
                for (const ev of repo.bus.replayFrom(lastEventId)) sendEvent(res, ev);

                const unsub = repo.bus.subscribe((ev) => sendEvent(res, ev));
                const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
                req.on('close', () => { unsub(); clearInterval(ping); });
            });

            // -------- SSE stream of live-DB events --------
            app.get('/api/projects/:pid/live/events', (req: Request, res: Response) => {
                const live = liveRepositories.get(String(req.params.pid));
                if (!live) { res.status(404).end(); return; }
                res.set({
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no'
                });
                res.flushHeaders();

                const lastEventId = Number(req.header('Last-Event-ID') ?? req.query.last_event_id ?? '0') || 0;
                for (const ev of live.bus.replayFrom(lastEventId)) sendEvent(res, ev);

                const unsub = live.bus.subscribe((ev) => sendEvent(res, ev));
                const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
                req.on('close', () => { unsub(); clearInterval(ping); });
            });

            // -------- granular CRUD --------
            registerDbApiRoutes(app, {
                repositories: repositories,
                liveRepositories: liveRepositories,
                runGenerate: runGenerate,
                /*
                 * Vite's `server.restart()` re-creates the dev server,
                 * which re-runs `configureServer` from scratch — i.e.
                 * the entire boot path above re-executes. The Vite
                 * client in the browser receives the restart signal
                 * and full-page-reloads, picking up the new project
                 * unids on the next /api/load-schema. Single-call
                 * cleanup of in-memory state without bespoke reload
                 * logic.
                 */
                restartServer: (): Promise<void> => server.restart(),
                configFilePath: configFile
            });

            server.middlewares.use(app);
        }
    };
}

function sendEvent(res: Response, ev: DbRepositoryEvent): void {
    res.write(`id: ${ev.rev}\n`);
    res.write(`event: ${ev.op}\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

/*
 * Read the configured listen port out of `dbeditor.json` at config-
 * resolution time so it survives `server.restart()`. Without this,
 * Vite re-creates its HTTP server on its built-in default port
 * (5173) after every restart — `cli/dev.js` only calls
 * `server.listen(serverPort)` once on the initial boot, so reloads
 * triggered by add-project / add-connection / reload-config bounced
 * the dev server to a new port each time.
 *
 * `DBEDITOR_CONFIG_FILE` is set by `cli/dev.js` before `createServer`,
 * so it's available here. Failures fall back to the legacy 5174 default
 * (no throw — `expressMiddleware` already handles the missing-config
 * case with a console warning).
 */
const resolveListenPort = (): number => {
    const cfgPath = process.env.DBEDITOR_CONFIG_FILE;
    if (!cfgPath) {return 5174;}
    try {
        const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        const port = raw?.server?.port;
        return typeof port === 'number' && Number.isFinite(port) ? port : 5174;
    } catch {
        return 5174;
    }
};

export default defineConfig(() => ({
    plugins: [expressMiddleware()],
    server: {
        port: resolveListenPort(),
        /*
         * Refuse to silently pick a different port — the user's
         * browser bookmark, .env, and any docker-compose mapping all
         * encode the configured port. If it's already taken, fail
         * loudly instead of moving to 5274+1.
         */
        strictPort: true
    }
}));