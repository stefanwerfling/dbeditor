import {spawn} from 'child_process';
import * as fs from 'fs';
import {DbProjectConnection} from '../../DbProject/DbProject.js';
import {DumpAdapter, DumpRestoreResult} from '../../DbSyncExecutor/DumpAdapters/DumpAdapter.js';

/**
 * Spawn the binary and resolve with the captured stderr + exit code.
 * Resolves rather than rejecting so callers can branch on outcomes
 * without try/catch noise.
 *
 * `stdoutTo`: optional writable stream that receives the binary's
 * stdout. Used for the dump path (stdout → file). For restore we
 * read stdin from the dump file and let stdout fall on the floor.
 */
type ProcessEnv = Record<string, string | undefined>;

const runBinary = (
    binary: string,
    args: string[],
    env: ProcessEnv,
    stdoutTo?: fs.WriteStream,
    stdinFrom?: fs.ReadStream
): Promise<{code: number | null; signal: string | null; stderr: string; spawnError?: Error;}> => {
    return new Promise(resolve => {
        const child = spawn(binary, args, {
            env: env,
            stdio: [
                stdinFrom ? 'pipe' : 'ignore',
                stdoutTo ? 'pipe' : 'ignore',
                'pipe'
            ]
        });
        let stderr = '';
        child.stderr?.on('data', chunk => { stderr += String(chunk); });
        if (stdoutTo && child.stdout) {child.stdout.pipe(stdoutTo);}
        if (stdinFrom && child.stdin) {stdinFrom.pipe(child.stdin);}
        let spawnError: Error | undefined;
        child.on('error', err => { spawnError = err; });
        child.on('close', (code, signal) => {
            resolve({code: code, signal: signal, stderr: stderr, spawnError: spawnError});
        });
    });
};

/**
 * MySQL/MariaDB adapter that shells out to the native `mysqldump` and
 * `mysql` binaries.
 *
 * Dump strategy: `mysqldump --single-transaction --quick --routines
 * --triggers --events --add-drop-database --databases <DB>`. The
 * `--databases` flag is the key piece — without it `mysqldump` emits a
 * bare-tables dump and the restore can leave behind tables that the
 * test-run created. With `--databases --add-drop-database` the dump
 * starts with `DROP DATABASE IF EXISTS <name>; CREATE DATABASE
 * <name>;` so replaying it returns the schema to the exact pre-dump
 * state — including any new tables the test created.
 *
 * Permission requirement: the connection user needs `RELOAD`,
 * `LOCK TABLES`, `SELECT` for the dump and `DROP`, `CREATE`,
 * `ALTER`, `INDEX`, `REFERENCES`, `INSERT` for the restore. For
 * a development root account this is trivially satisfied; for
 * production-grade least-privilege users this needs documenting.
 *
 * Password handling: passed via `MYSQL_PWD` env var instead of
 * `-p<value>` so it doesn't show up in the process list. Empty
 * passwords are passed as empty string (mysqldump tolerates that).
 */
export class MysqlDumpAdapter implements DumpAdapter {

    private readonly _dumpBinary: string;
    private readonly _restoreBinary: string;

    public constructor(dumpBinary = 'mysqldump', restoreBinary = 'mysql') {
        this._dumpBinary = dumpBinary;
        this._restoreBinary = restoreBinary;
    }

    public async dump(cfg: DbProjectConnection, dumpPath: string): Promise<DumpRestoreResult> {
        const startedAt = Date.now();
        const args = [
            `-h${cfg.host}`,
            `-P${cfg.port}`,
            `-u${cfg.user}`,
            '--single-transaction',
            '--quick',
            '--routines',
            '--triggers',
            '--events',
            '--add-drop-database',
            '--databases',
            cfg.database
        ];
        if (cfg.ssl) {args.push('--ssl');}
        const out = fs.createWriteStream(dumpPath);
        const finished = new Promise<void>((resolve, reject) => {
            out.on('finish', () => resolve());
            out.on('error', reject);
        });
        const env = {...process.env, MYSQL_PWD: cfg.password};
        const result = await runBinary(this._dumpBinary, args, env, out);
        out.end();
        await finished.catch(() => undefined);
        const durationMs = Date.now() - startedAt;
        if (result.spawnError) {
            return {
                ok: false,
                error: `failed to spawn ${this._dumpBinary}: ${result.spawnError.message} (is it on PATH?)`,
                stderr: result.stderr,
                durationMs: durationMs
            };
        }
        if (result.code !== 0) {
            return {
                ok: false,
                error: `${this._dumpBinary} exited with code ${result.code ?? '?'}${result.signal ? ` (signal ${result.signal})` : ''}`,
                stderr: result.stderr,
                durationMs: durationMs
            };
        }
        return {ok: true, durationMs: durationMs, stderr: result.stderr};
    }

    public async restore(cfg: DbProjectConnection, dumpPath: string): Promise<DumpRestoreResult> {
        const startedAt = Date.now();
        if (!fs.existsSync(dumpPath)) {
            return {
                ok: false,
                error: `dump file does not exist: ${dumpPath}`,
                durationMs: Date.now() - startedAt
            };
        }
        const args = [
            `-h${cfg.host}`,
            `-P${cfg.port}`,
            `-u${cfg.user}`
            /*
             * Deliberately NO database arg: the dump itself contains
             * `CREATE DATABASE` + `USE` statements thanks to
             * `--databases --add-drop-database`. Passing one here
             * would cause mysql to switch INTO it before the dump
             * recreates it — a recipe for "unknown database" errors.
             */
        ];
        if (cfg.ssl) {args.push('--ssl');}
        const inp = fs.createReadStream(dumpPath);
        const env = {...process.env, MYSQL_PWD: cfg.password};
        const result = await runBinary(this._restoreBinary, args, env, undefined, inp);
        const durationMs = Date.now() - startedAt;
        if (result.spawnError) {
            return {
                ok: false,
                error: `failed to spawn ${this._restoreBinary}: ${result.spawnError.message} (is it on PATH?)`,
                stderr: result.stderr,
                durationMs: durationMs
            };
        }
        if (result.code !== 0) {
            return {
                ok: false,
                error: `${this._restoreBinary} exited with code ${result.code ?? '?'}${result.signal ? ` (signal ${result.signal})` : ''}`,
                stderr: result.stderr,
                durationMs: durationMs
            };
        }
        return {ok: true, durationMs: durationMs, stderr: result.stderr};
    }

}