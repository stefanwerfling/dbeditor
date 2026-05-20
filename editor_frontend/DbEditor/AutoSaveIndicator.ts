import {DbApiClient, RequestEvent} from './Api/DbApiClient.js';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Topbar pill that reflects mutation state from `DbApiClient`. Counts
 * in-flight non-GET requests; transitions:
 *
 *   idle  --start--> saving
 *   saving (counter > 0) --success--> saving
 *   saving (counter == 0, last was success) --success--> saved (1.5s) --> idle
 *   any --error--> error (sticky until next start)
 *
 * Sticky-on-error means a failed save keeps showing until the user
 * tries something else, so the user can't miss it after dismissing
 * the alert dialog.
 */
export class AutoSaveIndicator {

    private _el: HTMLElement;
    private _inFlight = 0;
    private _lastError = false;
    private _savedTimer: number | null = null;
    private _state: SaveState = 'idle';

    public constructor(el: HTMLElement, api: DbApiClient) {
        this._el = el;
        this._render();
        api.onRequest((ev: RequestEvent): void => this._onEvent(ev));
    }

    private _onEvent(ev: RequestEvent): void {
        switch (ev.kind) {
            case 'start':
                this._inFlight += 1;
                this._lastError = false;
                this._setState('saving');
                break;
            case 'success':
                this._inFlight = Math.max(0, this._inFlight - 1);
                if (this._inFlight === 0 && !this._lastError) {
                    this._setState('saved');
                    if (this._savedTimer !== null) {window.clearTimeout(this._savedTimer);}
                    this._savedTimer = window.setTimeout((): void => {
                        this._savedTimer = null;
                        if (this._inFlight === 0 && !this._lastError) {this._setState('idle');}
                    }, 1500);
                }
                break;
            case 'error':
                this._inFlight = Math.max(0, this._inFlight - 1);
                this._lastError = true;
                this._setState('error');
                break;
            default: break;
        }
    }

    private _setState(s: SaveState): void {
        if (this._state === s) {return;}
        this._state = s;
        this._render();
    }

    private _render(): void {
        const variants: Record<SaveState, string> = {
            idle:   '',
            saving: 'savestate--saving',
            saved:  'savestate--saved',
            error:  'savestate--error'
        };
        const labels: Record<SaveState, string> = {
            idle:   '',
            saving: 'Saving…',
            saved:  'Saved',
            error:  'Save failed'
        };
        this._el.className = `savestate ${variants[this._state]}`.trim();
        this._el.textContent = labels[this._state];
    }

}