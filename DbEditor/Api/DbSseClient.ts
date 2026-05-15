/**
 * SSE listener for one project. Filters out events whose `clientId`
 * matches our own — those mutations were dispatched locally and the
 * frontend already applied the optimistic update.
 *
 * The server emits each event with `id: <rev>` so EventSource will
 * automatically reconnect with `Last-Event-ID` after a transient
 * network blip.
 */
export type DbSseEvent = {
    rev: number;
    op: string;
    clientId: string | null;
    body: unknown;
};

export class DbSseClient {

    private _es: EventSource | null = null;
    private readonly _ourClientId: string;
    private readonly _projectUnid: string;
    private readonly _onEvent: (ev: DbSseEvent) => void;

    public constructor(projectUnid: string, ourClientId: string, onEvent: (ev: DbSseEvent) => void) {
        this._projectUnid = projectUnid;
        this._ourClientId = ourClientId;
        this._onEvent = onEvent;
    }

    public start(): void {
        if (this._es) {return;}
        this._es = new EventSource(`/api/projects/${this._projectUnid}/events`);
        this._es.onmessage = (e): void => this._handle(e.data);
        // also listen to typed events the server emits via `event:` lines
        this._es.addEventListener('error', () => {
            // EventSource auto-reconnects. nothing to do.
        });
    }

    public stop(): void {
        if (this._es) { this._es.close(); this._es = null; }
    }

    private _handle(raw: string): void {
        try {
            const ev = JSON.parse(raw) as DbSseEvent;
            if (ev.clientId === this._ourClientId) {return;}
            this._onEvent(ev);
        } catch {
            // ignore malformed
        }
    }

}