/**
 * Wire-format mirror of DbDiff/ChangeTypes.SchemaRenameHints. Pairings
 * the user has manually established in the SyncDialog (live name →
 * model name) — the diff collapses matching drop+add into a single
 * rename change. Hints with no match are silently skipped.
 */
export type RenameHints = {
    tables?: {from: string; to: string;}[];
    columns?: {tableName: string; from: string; to: string;}[];
};

/**
 * Wire-format mirror of `DbSyncExecutor/SyncHistoryRepo.SyncHistoryEntry`.
 * Persisted on disk under `<schema dir>/sync-history.json`, one record
 * per sync operation (apply / test-run / reverse-apply). Dry-runs are
 * not logged.
 */
export type SyncHistoryEntry = {
    id: string;
    ts: string;
    mode: 'apply' | 'test-run' | 'reverse-apply' | 'dry-run';
    dialect: string;
    databaseUnid: string;
    databaseName: string;
    diagramUnid?: string;
    layerName?: string;
    selectedChangeIds: string[];
    changeSetSummary: Record<string, number>;
    statementResults: {changeId: string; sql: string; ok: boolean; error?: string; durationMs: number;}[];
    migrationFiles?: {up: string; down: string;};
    dumpPath?: string;
    dumpKept?: boolean;
    dumpSizeBytes?: number;
    success: boolean;
    critical?: boolean;
    restoreOk?: boolean | null;
    restoreError?: string;
    failedAtIndex?: number;
    appliedChangeIds?: string[];
    durationMs: number;
};

const hasAnyRename = (r: RenameHints): boolean =>
    (r.tables !== undefined && r.tables.length > 0) ||
    (r.columns !== undefined && r.columns.length > 0);

export type AddProjectInput = {
    name: string;
    schemaPath: string;
    dialect: string;
    output: {
        mode: string;
        destinationPath: string;
    };
    autoGenerate?: boolean;
};

export type UpdateProjectInput = {
    name?: string;
    schemaPath?: string;
    dialect?: string;
    output?: {
        mode?: string;
        destinationPath?: string;
    };
    autoGenerate?: boolean;
};

export type AddConnectionInput = {
    databaseUnid: string;
    host: string;
    port?: number;
    user: string;
    password?: string;
    database: string;
    ssl?: boolean;
    readOnly?: boolean;
};

export type UpdateConnectionInput = {
    host?: string;
    port?: number;
    user?: string;
    /**
     * Three states:
     *   - omitted (key not present)  → keep current password
     *   - empty string `''`          → clear the password
     *   - non-empty value            → replace
     */
    password?: string;
    database?: string;
    ssl?: boolean;
    readOnly?: boolean;
};

export type GeneratedFileResult = {
    path: string;
    relativePath: string;
    content: string;
};

export type GenerateResult = {
    success: boolean;
    root: string;
    files: GeneratedFileResult[];
};

export type RequestEvent =
    | { kind: 'start';   method: string; path: string; }
    | { kind: 'success'; method: string; path: string; }
    | { kind: 'error';   method: string; path: string; error: string; };

export type RequestListener = (ev: RequestEvent) => void;

/**
 * HTTP client for granular CRUD endpoints. Every mutation sends an
 * `X-Client-Id` header — the SSE listener uses it to suppress echoes
 * of mutations it dispatched itself (the optimistic update already
 * applied them locally).
 *
 * Subscribers can register via `onRequest()` to receive a lifecycle
 * event for every non-GET call. The auto-save indicator uses this to
 * show saving / saved / failed states without each mutation site
 * having to opt in. GETs are intentionally not announced — the most
 * common one is `/api/load-schema`, which fires after every mutation
 * and would make the indicator flicker.
 */
export class DbApiClient {

    public readonly clientId: string;

    private _listeners: RequestListener[] = [];

    public constructor() {
        this.clientId = crypto.randomUUID();
    }

    /** Subscribe to non-GET request lifecycle events. Returns an unsubscribe function. */
    public onRequest(fn: RequestListener): () => void {
        this._listeners.push(fn);
        return (): void => {
            const i = this._listeners.indexOf(fn);
            if (i >= 0) {this._listeners.splice(i, 1);}
        };
    }

    private _emit(ev: RequestEvent): void {
        for (const l of this._listeners) {
            try { l(ev); }
            catch (err) { console.error('[DbApiClient] listener threw', err); }
        }
    }

    private async _request(method: string, path: string, body?: unknown): Promise<any> {
        const headers: Record<string, string> = {
            'Accept': 'application/json',
            'X-Client-Id': this.clientId
        };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }
        const announce = method !== 'GET';
        if (announce) {this._emit({ kind: 'start', method: method, path: path });}
        try {
            const res = await fetch(path, {
                method: method,
                headers: headers,
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            const text = await res.text();
            const data = text ? JSON.parse(text) : null;
            if (!res.ok) {
                const msg = (data && data.error) || res.statusText || `HTTP ${res.status}`;
                throw new Error(`${method} ${path}: ${msg}`);
            }
            if (announce) {this._emit({ kind: 'success', method: method, path: path });}
            return data;
        } catch (err) {
            if (announce) {this._emit({ kind: 'error', method: method, path: path, error: String(err) });}
            throw err;
        }
    }

    public loadSchema(): Promise<{projects: any[];}> {
        return this._request('GET', '/api/load-schema');
    }

    /* containers */

    public createContainer(pid: string, parentUnid: string, name: string, type: string): Promise<any> {
        return this._request('POST', `/api/projects/${pid}/containers`, {parentUnid: parentUnid, name: name, type: type});
    }

    public updateContainer(pid: string, unid: string, patch: {name?: string; icon?: string; istoggle?: boolean;}): Promise<any> {
        return this._request('PATCH', `/api/projects/${pid}/containers/${unid}`, patch);
    }

    public deleteContainer(pid: string, unid: string): Promise<any> {
        return this._request('DELETE', `/api/projects/${pid}/containers/${unid}`);
    }

    /**
     * Patch the database-level defaults (engine / charset / collation)
     * inherited by every contained table. Empty-string clears a
     * default; omitted keys are kept untouched. Server-side validates
     * that `unid` actually points at a database container.
     */
    public updateDatabaseDefaults(pid: string, unid: string, patch: {
        defaultEngine?: string;
        defaultCharset?: string;
        defaultCollation?: string;
    }): Promise<any> {
        return this._request('PATCH', `/api/projects/${pid}/databases/${unid}/defaults`, patch);
    }

    /* tables */

    public createTable(pid: string, containerUnid: string, name: string, pos?: {x: number; y: number;}): Promise<any> {
        return this._request('POST', `/api/projects/${pid}/tables`, {containerUnid: containerUnid, name: name, pos: pos});
    }

    public updateTable(pid: string, unid: string, patch: any): Promise<any> {
        return this._request('PATCH', `/api/projects/${pid}/tables/${unid}`, patch);
    }

    public deleteTable(pid: string, unid: string): Promise<any> {
        return this._request('DELETE', `/api/projects/${pid}/tables/${unid}`);
    }

    public duplicateTable(pid: string, unid: string): Promise<{success: boolean; rev: number; data: any;}> {
        return this._request('POST', `/api/projects/${pid}/tables/${unid}/duplicate`);
    }

    /* columns */

    public addColumn(pid: string, tableUnid: string, column: any): Promise<any> {
        return this._request('POST', `/api/projects/${pid}/tables/${tableUnid}/columns`, column);
    }

    public updateColumn(pid: string, tableUnid: string, columnUnid: string, patch: any): Promise<any> {
        return this._request('PATCH', `/api/projects/${pid}/tables/${tableUnid}/columns/${columnUnid}`, patch);
    }

    public removeColumn(pid: string, tableUnid: string, columnUnid: string): Promise<any> {
        return this._request('DELETE', `/api/projects/${pid}/tables/${tableUnid}/columns/${columnUnid}`);
    }

    public reorderColumns(pid: string, tableUnid: string, order: string[]): Promise<any> {
        return this._request('PUT', `/api/projects/${pid}/tables/${tableUnid}/columns/order`, {order: order});
    }

    /* indexes */

    public addIndex(pid: string, tableUnid: string, index: any): Promise<any> {
        return this._request('POST', `/api/projects/${pid}/tables/${tableUnid}/indexes`, index);
    }

    public updateIndex(pid: string, tableUnid: string, indexUnid: string, patch: any): Promise<any> {
        return this._request('PATCH', `/api/projects/${pid}/tables/${tableUnid}/indexes/${indexUnid}`, patch);
    }

    public removeIndex(pid: string, tableUnid: string, indexUnid: string): Promise<any> {
        return this._request('DELETE', `/api/projects/${pid}/tables/${tableUnid}/indexes/${indexUnid}`);
    }

    /* foreign keys */

    public addForeignKey(pid: string, tableUnid: string, fk: any): Promise<any> {
        return this._request('POST', `/api/projects/${pid}/tables/${tableUnid}/foreignkeys`, fk);
    }

    public updateForeignKey(pid: string, tableUnid: string, fkUnid: string, patch: any): Promise<any> {
        return this._request('PATCH', `/api/projects/${pid}/tables/${tableUnid}/foreignkeys/${fkUnid}`, patch);
    }

    public removeForeignKey(pid: string, tableUnid: string, fkUnid: string): Promise<any> {
        return this._request('DELETE', `/api/projects/${pid}/tables/${tableUnid}/foreignkeys/${fkUnid}`);
    }

    /* enums */

    public createEnum(pid: string, containerUnid: string, name: string, pos?: {x: number; y: number;}): Promise<any> {
        return this._request('POST', `/api/projects/${pid}/enums`, {containerUnid: containerUnid, name: name, pos: pos});
    }

    public updateEnum(pid: string, unid: string, patch: any): Promise<any> {
        return this._request('PATCH', `/api/projects/${pid}/enums/${unid}`, patch);
    }

    public deleteEnum(pid: string, unid: string): Promise<any> {
        return this._request('DELETE', `/api/projects/${pid}/enums/${unid}`);
    }

    public addEnumValue(pid: string, enumUnid: string, value: string): Promise<any> {
        return this._request('POST', `/api/projects/${pid}/enums/${enumUnid}/values`, {value: value});
    }

    public updateEnumValue(pid: string, enumUnid: string, valueUnid: string, value: string): Promise<any> {
        return this._request('PATCH', `/api/projects/${pid}/enums/${enumUnid}/values/${valueUnid}`, {value: value});
    }

    public removeEnumValue(pid: string, enumUnid: string, valueUnid: string): Promise<any> {
        return this._request('DELETE', `/api/projects/${pid}/enums/${enumUnid}/values/${valueUnid}`);
    }

    /* views */

    public createView(pid: string, containerUnid: string, name: string, pos?: {x: number; y: number;}): Promise<any> {
        return this._request('POST', `/api/projects/${pid}/views`, {containerUnid: containerUnid, name: name, pos: pos});
    }

    public updateView(pid: string, unid: string, patch: any): Promise<any> {
        return this._request('PATCH', `/api/projects/${pid}/views/${unid}`, patch);
    }

    public deleteView(pid: string, unid: string): Promise<any> {
        return this._request('DELETE', `/api/projects/${pid}/views/${unid}`);
    }

    public createDiagram(pid: string, containerUnid: string, name: string): Promise<any> {
        return this._request('POST', `/api/projects/${pid}/diagrams`, {containerUnid: containerUnid, name: name});
    }

    public updateDiagram(pid: string, unid: string, patch: {name?: string; description?: string;}): Promise<any> {
        return this._request('PATCH', `/api/projects/${pid}/diagrams/${unid}`, patch);
    }

    public deleteDiagram(pid: string, unid: string): Promise<any> {
        return this._request('DELETE', `/api/projects/${pid}/diagrams/${unid}`);
    }

    /* routines */

    public createRoutine(pid: string, containerUnid: string, name: string, kind: string, pos?: {x: number; y: number;}): Promise<any> {
        return this._request('POST', `/api/projects/${pid}/routines`, {containerUnid: containerUnid, name: name, kind: kind, pos: pos});
    }

    public updateRoutine(pid: string, unid: string, patch: any): Promise<any> {
        return this._request('PATCH', `/api/projects/${pid}/routines/${unid}`, patch);
    }

    public deleteRoutine(pid: string, unid: string): Promise<any> {
        return this._request('DELETE', `/api/projects/${pid}/routines/${unid}`);
    }

    public updateEditorSettings(pid: string, patch: any): Promise<any> {
        return this._request('PUT', `/api/projects/${pid}/editor-settings`, patch);
    }

    public generate(pid: string): Promise<GenerateResult> {
        return this._request('POST', `/api/projects/${pid}/generate`);
    }

    /**
     * Render Markdown documentation for every database in the project
     * and (by default) write them to `<destinationPath>/docs/`. Set
     * `dryRun: true` to get the preview payload without touching
     * disk — useful for "Preview docs" affordances. Server returns the
     * same `GenerateResult` shape as the SQL generator so
     * `SqlPreviewDialog` renders it without a docs-specific component.
     */
    public generateDocs(pid: string, dryRun = false): Promise<GenerateResult & {dryRun: boolean;}> {
        return this._request('POST', `/api/projects/${pid}/docs/generate`, {dryRun: dryRun});
    }

    public generateScoped(
        pid: string,
        scope: {databaseUnid?: string; tableUnid?: string; tableUnids?: string[];}
    ): Promise<GenerateResult & {scope: {databaseUnid?: string; tableUnid?: string; tableUnids?: string[];};}> {
        return this._request('POST', `/api/projects/${pid}/generate/scoped`, scope);
    }

    /* sync with live DB */

    public testConnection(pid: string, databaseUnid: string): Promise<{success: boolean;}> {
        return this._request('POST', `/api/projects/${pid}/connection/test`, {databaseUnid: databaseUnid});
    }

    /**
     * Test a SAVED connection with `patch` overrides applied for this
     * call only — useful in EditConnectionDialog where the user has
     * tweaked host/port/etc. but doesn't want to retype the password
     * (the server never sends it back to the client). Server merges
     * patch on top of `repo.project.connections[i]` before pinging.
     * Nothing is persisted.
     */
    public testConnectionWithPatch(pid: string, databaseUnid: string, patch: Partial<{
        host: string;
        port: number;
        user: string;
        password: string;
        database: string;
        ssl: boolean;
    }>): Promise<{success: boolean;}> {
        return this._request('POST', `/api/projects/${pid}/connection/test`, {databaseUnid: databaseUnid, patch: patch});
    }

    /**
     * Verify a connection's credentials WITHOUT touching the saved
     * `connections[]` on the project. Used by the AddConnection /
     * EditConnection dialogs so the user can iterate on host / port /
     * password without each iteration triggering a server restart.
     * `${VAR}` placeholders in the input strings resolve through the
     * server's env resolver just like saved connections.
     */
    public testAdHocConnection(input: {
        dialect: string;
        host: string;
        port?: number;
        user: string;
        password?: string;
        database: string;
        ssl?: boolean;
    }): Promise<{success: boolean;}> {
        return this._request('POST', '/api/connection/test-ad-hoc', input);
    }

    public refreshLive(pid: string, databaseUnid: string): Promise<{success: boolean; rev: number; data: any;}> {
        return this._request('POST', `/api/projects/${pid}/live/refresh`, {databaseUnid: databaseUnid});
    }

    public liveSnapshot(pid: string): Promise<{success: boolean; snapshot: {byDatabaseUnid: Record<string, any>; errors: Record<string, string>; rev: number;};}> {
        return this._request('GET', `/api/projects/${pid}/live/snapshot`);
    }

    public syncPreview(
        pid: string,
        databaseUnid: string,
        diagramUnid?: string,
        renames?: RenameHints
    ): Promise<{
        success: boolean;
        changeSet: any;
        statements: any[];
        modelDefaults: {engine: string; charset: string; collation: string;};
    }> {
        const body: Record<string, unknown> = {databaseUnid: databaseUnid};
        if (diagramUnid) {body.diagramUnid = diagramUnid;}
        if (renames && hasAnyRename(renames)) {body.renames = renames;}
        return this._request('POST', `/api/projects/${pid}/sync/preview`, body);
    }

    public syncApply(
        pid: string,
        databaseUnid: string,
        changeIds: string[],
        dryRun: boolean,
        diagramUnid?: string,
        renames?: RenameHints
    ): Promise<{
        success: boolean;
        dryRun: boolean;
        statementResults: {changeId: string; sql: string; ok: boolean; error?: string; durationMs: number;}[];
        migrationFiles?: {up: string; down: string;};
    }> {
        const body: Record<string, unknown> = {databaseUnid: databaseUnid, changeIds: changeIds, dryRun: dryRun};
        if (diagramUnid) {body.diagramUnid = diagramUnid;}
        if (renames && hasAnyRename(renames)) {body.renames = renames;}
        return this._request('POST', `/api/projects/${pid}/sync/apply`, body);
    }

    public syncReverseApply(
        pid: string,
        databaseUnid: string,
        changeIds: string[],
        diagramUnid?: string,
        renames?: RenameHints
    ): Promise<{
        success: boolean;
        rev: number;
        appliedChangeIds: string[];
        requestedCount: number;
    }> {
        const body: Record<string, unknown> = {databaseUnid: databaseUnid, changeIds: changeIds};
        if (diagramUnid) {body.diagramUnid = diagramUnid;}
        if (renames && hasAnyRename(renames)) {body.renames = renames;}
        return this._request('POST', `/api/projects/${pid}/sync/reverse-apply`, body);
    }

    /**
     * Test-run: dump → apply → ALWAYS restore. Returns a structured
     * outcome the SyncDialog branches on:
     *   - `success=true, critical=false`  → all green
     *   - `success=false, critical=false` → apply failed cleanly + restored
     *   - `critical=true`                 → restore itself failed; DB
     *                                       may be in indeterminate
     *                                       state; UI shows red banner
     *                                       with `dumpPath` for manual
     *                                       recovery
     */
    /**
     * Fetch the project's persisted sync-history log — every apply,
     * test-run, and reverse-apply that ran against the live DB.
     * Newest first. Optional `limit` caps the response.
     */
    public getSyncHistory(pid: string, limit?: number): Promise<{
        success: boolean;
        total: number;
        entries: SyncHistoryEntry[];
    }> {
        const q = typeof limit === 'number' && limit > 0 ? `?limit=${limit}` : '';
        return this._request('GET', `/api/projects/${pid}/sync/history${q}`);
    }

    public syncTestRun(
        pid: string,
        databaseUnid: string,
        changeIds: string[],
        diagramUnid?: string,
        renames?: RenameHints,
        purgeOnSuccess?: boolean
    ): Promise<{
        success: boolean;
        critical: boolean;
        dumpPath: string;
        dumpKept: boolean;
        dumpSizeBytes: number;
        dumpDurationMs: number;
        statementResults: {changeId: string; sql: string; ok: boolean; error?: string; durationMs: number;}[];
        restoreOk: boolean | null;
        restoreError?: string;
        restoreStderr?: string;
        restoreDurationMs?: number;
        failedAtIndex?: number;
        error?: string;
    }> {
        const body: Record<string, unknown> = {databaseUnid: databaseUnid, changeIds: changeIds};
        if (diagramUnid) {body.diagramUnid = diagramUnid;}
        if (renames && hasAnyRename(renames)) {body.renames = renames;}
        if (purgeOnSuccess === false) {body.purgeOnSuccess = false;}
        return this._request('POST', `/api/projects/${pid}/sync/test-run`, body);
    }

    public getSyncSettings(pid: string): Promise<{
        success: boolean;
        sync: {ignoreTables: string[]; ignoreColumnAttributes: string[];};
    }> {
        return this._request('GET', `/api/projects/${pid}/sync-settings`);
    }

    public replaceFs(pid: string, fs: any): Promise<{success: boolean; rev: number;}> {
        return this._request('PUT', `/api/projects/${pid}/schema`, {fs: fs});
    }

    public importMwb(pid: string, bytes: ArrayBuffer, mode: 'replace' | 'append' = 'replace'): Promise<{
        success: boolean;
        rev: number;
        mode: string;
        stats: {
            schemaCount: number; tableCount: number; columnCount: number;
            indexCount: number; foreignKeyCount: number; positionedTableCount: number;
            positionedViewCount: number;
            multiDiagramTableCount: number;
            viewCount: number; routineCount: number; triggerCount: number;
            layerCount: number;
        };
    }> {
        /*
         * Raw bytes upload — we bypass `_request` because that wraps in JSON.
         * Manually fetch with the right Content-Type so the server's
         * express.raw middleware picks it up.
         */
        const announce = true;
        const url = `/api/projects/${pid}/import-mwb?mode=${mode}`;
        if (announce) {this._emit({kind: 'start', method: 'POST', path: url});}
        return fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Accept': 'application/json',
                'X-Client-Id': this.clientId
            },
            body: bytes
        }).then(async res => {
            const text = await res.text();
            const data = text ? JSON.parse(text) : null;
            if (!res.ok) {
                const msg = (data && data.error) || res.statusText || `HTTP ${res.status}`;
                this._emit({kind: 'error', method: 'POST', path: url, error: msg});
                throw new Error(`POST ${url}: ${msg}`);
            }
            this._emit({kind: 'success', method: 'POST', path: url});
            return data;
        });
    }

    /**
     * Export the project's current schema as a `.mwb` archive (raw
     * bytes). Mirror of `importMwb` — bypasses `_request` because the
     * response is binary, not JSON.
     */
    public exportMwb(pid: string): Promise<Blob> {
        const url = `/api/projects/${pid}/export-mwb`;
        this._emit({kind: 'start', method: 'POST', path: url});
        return fetch(url, {
            method: 'POST',
            headers: {'X-Client-Id': this.clientId}
        }).then(async res => {
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                let msg: string = res.statusText || `HTTP ${res.status}`;
                /*
                 * Body might or might not be JSON (server returns
                 * application/json on error, octet-stream on success).
                 * Tolerate non-JSON: leave msg as the statusText fallback.
                 */
                try {
                    const parsed = JSON.parse(text);
                    if (parsed && parsed.error) {msg = parsed.error;}
                } catch {
                    /* not JSON */
                }
                this._emit({kind: 'error', method: 'POST', path: url, error: msg});
                throw new Error(`POST ${url}: ${msg}`);
            }
            this._emit({kind: 'success', method: 'POST', path: url});
            return res.blob();
        });
    }

    public undo(pid: string): Promise<{success: boolean; applied: boolean; rev: number; canUndo: boolean; canRedo: boolean;}> {
        return this._request('POST', `/api/projects/${pid}/undo`);
    }

    public redo(pid: string): Promise<{success: boolean; applied: boolean; rev: number; canUndo: boolean; canRedo: boolean;}> {
        return this._request('POST', `/api/projects/${pid}/redo`);
    }

    public updateSyncSettings(
        pid: string,
        patch: {ignoreTables?: string[]; ignoreColumnAttributes?: string[];}
    ): Promise<{
        success: boolean;
        rev: number;
        sync: {ignoreTables: string[]; ignoreColumnAttributes: string[];};
    }> {
        return this._request('PUT', `/api/projects/${pid}/sync-settings`, patch);
    }

    public getOutputSettings(pid: string): Promise<{
        success: boolean;
        output: OutputSettings;
    }> {
        return this._request('GET', `/api/projects/${pid}/output-settings`);
    }

    /**
     * Re-runs the dev server boot path so dbeditor.json edits take
     * effect without ctrl-c. The server validates the file on disk
     * first and returns 400 if it doesn't parse — that prevents the
     * UI from booting the server into an unrecoverable state.
     * Following a successful response, the browser will full-page-
     * reload via Vite's client moments later.
     */
    public restartServer(): Promise<{success: boolean;}> {
        return this._request('POST', '/api/restart-server', {});
    }

    /**
     * Append a new project entry to `dbeditor.json` and restart the
     * dev server so it becomes addressable. The browser full-page-
     * reloads via the Vite client and the new project surfaces on
     * the next `/api/load-schema` call.
     */
    public addProject(input: AddProjectInput): Promise<{success: boolean; project: unknown;}> {
        return this._request('POST', '/api/config/projects', input);
    }

    /**
     * Patch the project entry in dbeditor.json. Server resolves the
     * project by its current name (read off the pid-keyed repo).
     * Restart fires on success; browser full-page-reloads.
     */
    public updateProject(pid: string, patch: UpdateProjectInput): Promise<{success: boolean;}> {
        return this._request('PATCH', `/api/projects/${pid}/config`, patch);
    }

    /**
     * Drop the project's entry from dbeditor.json + restart. The
     * project's on-disk schema file is intentionally NOT deleted —
     * removing the project drops only its config entry; the modelled
     * tables persist and can be re-attached later. Server full-page-
     * reloads via Vite.
     */
    public removeProject(pid: string): Promise<{success: boolean;}> {
        return this._request('DELETE', `/api/projects/${pid}/config`);
    }

    /**
     * Append a live-DB connection to the named project's `connections[]`
     * in dbeditor.json. Project lookup on the server is by name. The
     * file write triggers a `server.restart()` so the new connection
     * becomes a live `DbProjectConnection` on the next boot — the
     * browser full-page-reloads via Vite's client.
     */
    public addConnection(pid: string, input: AddConnectionInput): Promise<{success: boolean;}> {
        return this._request('POST', `/api/projects/${pid}/config/connections`, input);
    }

    /**
     * Drop the connection for `databaseUnid` from the project's
     * `connections[]` in dbeditor.json + restart. Same reload
     * semantics as {@link addConnection}.
     */
    public removeConnection(pid: string, databaseUnid: string): Promise<{success: boolean;}> {
        return this._request('DELETE', `/api/projects/${pid}/config/connections/${encodeURIComponent(databaseUnid)}`);
    }

    /**
     * Patch fields of an existing connection in dbeditor.json.
     * Password has tri-state semantics — see {@link UpdateConnectionInput}.
     * Restart fires on success; browser full-page-reloads.
     */
    public updateConnection(pid: string, databaseUnid: string, patch: UpdateConnectionInput): Promise<{success: boolean;}> {
        return this._request('PATCH', `/api/projects/${pid}/config/connections/${encodeURIComponent(databaseUnid)}`, patch);
    }

    /**
     * Rebind an existing connection to a different model database —
     * preserves all credentials/host fields and only changes which
     * model database the connection is associated with. Restart fires
     * on success; browser full-page-reloads.
     */
    public rebindConnection(pid: string, databaseUnid: string, newDatabaseUnid: string): Promise<{success: boolean;}> {
        return this._request(
            'PATCH',
            `/api/projects/${pid}/config/connections/${encodeURIComponent(databaseUnid)}/rebind`,
            {newDatabaseUnid: newDatabaseUnid}
        );
    }

    public getProjectInfo(pid: string): Promise<{
        success: boolean;
        info: ProjectInfo;
    }> {
        return this._request('GET', `/api/projects/${pid}/info`);
    }

    public updateOutputSettings(
        pid: string,
        patch: Partial<OutputSettings>
    ): Promise<{
        success: boolean;
        rev: number;
        output: OutputSettings;
    }> {
        return this._request('PUT', `/api/projects/${pid}/output-settings`, patch);
    }

}

export type OutputSettings = {
    mode: string;
    destinationPath: string;
    destinationClear: boolean;
    sqlComment: boolean;
    sqlIndent: string;
    statementTerminator: string;
    migrationFilenamePattern: string;
};

export type ProjectInfo = {
    name: string;
    dialect: string;
    schemaPath: string;
    autoGenerate: boolean;
    output: OutputSettings;
    sync: {ignoreTables: string[]; ignoreColumnAttributes: string[];};
    connections: {
        databaseUnid: string;
        /** Resolved model database name for this unid, or null if it doesn't resolve. */
        databaseName: string | null;
        host: string;
        port: number;
        user: string;
        database: string;
        ssl: boolean;
        readOnly: boolean;
        passwordSet: boolean;
    }[];
    scriptsBeforeGenerate: {path: string; script: string;}[];
    scriptsAfterGenerate: {path: string; script: string;}[];
};