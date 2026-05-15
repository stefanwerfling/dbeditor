/**
 * SSE listener for one project's live-DB event stream. Separate from
 * `DbSseClient` because:
 *   - the path differs (`/live/events`),
 *   - no client-id filtering is needed (the server never echoes our writes
 *     back here — live events are always server-initiated),
 *   - the event payloads describe live-tree refreshes, not model mutations.
 */
export type DbLiveSseEvent = {
    rev: number;
    op: string;
    clientId: string | null;
    body: unknown;
};

export class DbLiveSseClient {

    private _es: EventSource | null = null;
    private readonly _projectUnid: string;
    private readonly _onEvent: (ev: DbLiveSseEvent) => void;

    public constructor(projectUnid: string, onEvent: (ev: DbLiveSseEvent) => void) {
        this._projectUnid = projectUnid;
        this._onEvent = onEvent;
    }

    public start(): void {
        if (this._es) {return;}
        this._es = new EventSource(`/api/projects/${this._projectUnid}/live/events`);
        this._es.onmessage = (e): void => this._handle(e.data);
        this._es.addEventListener('error', () => {
            // EventSource auto-reconnects.
        });
    }

    public stop(): void {
        if (this._es) { this._es.close(); this._es = null; }
    }

    private _handle(raw: string): void {
        try {
            const ev = JSON.parse(raw) as DbLiveSseEvent;
            this._onEvent(ev);
        } catch {
            // ignore malformed
        }
    }

}