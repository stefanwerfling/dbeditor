import {DbRepositoryEvent} from './DbRepositoryEventTypes.js';

const REPLAY_BUFFER_SIZE = 500;

type Listener = (event: DbRepositoryEvent) => void;

/**
 * Per-project pub/sub with a small replay buffer. SSE clients can request
 * `?last_event_id=N` and receive every event with rev > N before live events.
 */
export class DbRepositoryEventBus {

    private _listeners = new Set<Listener>();
    private _buffer: DbRepositoryEvent[] = [];

    public publish(event: DbRepositoryEvent): void {
        this._buffer.push(event);
        if (this._buffer.length > REPLAY_BUFFER_SIZE) {
            this._buffer.splice(0, this._buffer.length - REPLAY_BUFFER_SIZE);
        }
        for (const l of this._listeners) {
            try { l(event); } catch (err) { console.error('[DbRepositoryEventBus]', err); }
        }
    }

    public subscribe(listener: Listener): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    public replayFrom(rev: number): DbRepositoryEvent[] {
        return this._buffer.filter(e => e.rev > rev);
    }

}