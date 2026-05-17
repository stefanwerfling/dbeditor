import {SearchEntry, topMatches} from '../Util/SearchIndex.js';

/**
 * Lightweight command-palette-style overlay for jumping to a table by
 * name. Pure UI — owns no schema state; the controller passes a fresh
 * index every time the palette opens. On Enter / click, resolves with
 * the selected entry; on Esc / backdrop click, resolves with `null`.
 *
 * Not based on `BaseDialog` because the palette has different ergonomics
 * (no header, no footer buttons, ultra-fast open/close, top-of-viewport
 * anchored rather than centred) — duplicating the small modal scaffold
 * is simpler than carving the right hooks into BaseDialog.
 */
export class SearchPalette {

    private readonly _backdrop: HTMLDivElement;
    private readonly _panel: HTMLDivElement;
    private readonly _input: HTMLInputElement;
    private readonly _list: HTMLDivElement;
    private readonly _index: SearchEntry[];
    private _matches: { entry: SearchEntry; score: number; }[] = [];
    private _activeIdx = 0;
    private _resolve: ((value: SearchEntry | null) => void) | null = null;

    public constructor(index: SearchEntry[]) {
        this._index = index;

        this._backdrop = document.createElement('div');
        this._backdrop.className = 'search-palette-backdrop';
        this._backdrop.addEventListener('mousedown', (e: MouseEvent): void => {
            if (e.target === this._backdrop) {this._close(null);}
        });

        this._panel = document.createElement('div');
        this._panel.className = 'search-palette';

        this._input = document.createElement('input');
        this._input.type = 'search';
        this._input.placeholder = 'Jump to table…';
        this._input.className = 'search-palette-input';
        this._input.autocomplete = 'off';
        this._input.spellcheck = false;
        this._input.addEventListener('input', () => this._refilter());
        this._input.addEventListener('keydown', (e: KeyboardEvent) => this._onKey(e));

        this._list = document.createElement('div');
        this._list.className = 'search-palette-list';

        this._panel.append(this._input, this._list);
        this._backdrop.append(this._panel);
    }

    public show(): Promise<SearchEntry | null> {
        document.body.append(this._backdrop);
        this._refilter();
        /* Focus next tick so the input's `value` is empty on open. */
        setTimeout(() => this._input.focus(), 0);
        return new Promise<SearchEntry | null>(resolve => { this._resolve = resolve; });
    }

    private _close(value: SearchEntry | null): void {
        this._backdrop.remove();
        if (this._resolve) {
            this._resolve(value);
            this._resolve = null;
        }
    }

    private _refilter(): void {
        const q = this._input.value.trim();
        this._matches = topMatches(this._index, q, 50);
        this._activeIdx = 0;
        this._renderList();
    }

    private _renderList(): void {
        this._list.replaceChildren();
        if (this._matches.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'search-palette-empty';
            empty.textContent = this._index.length === 0
                ? 'No tables in this project yet.'
                : 'No matches.';
            this._list.append(empty);
            return;
        }
        this._matches.forEach((m, i) => {
            const row = document.createElement('div');
            row.className = 'search-palette-row';
            if (i === this._activeIdx) {row.classList.add('search-palette-row--active');}
            row.addEventListener('mousemove', () => {
                if (this._activeIdx === i) {return;}
                this._activeIdx = i;
                this._updateActiveClasses();
            });
            row.addEventListener('mousedown', (e: MouseEvent) => {
                e.preventDefault();
                this._close(m.entry);
            });
            const kind = document.createElement('span');
            kind.className = `search-palette-kind search-palette-kind--${m.entry.kind}`;
            const KIND_LABEL: Record<string, string> = {column: 'COL', diagram: 'LAY', table: 'TBL'};
            kind.textContent = KIND_LABEL[m.entry.kind] ?? 'TBL';
            const name = document.createElement('span');
            name.className = 'search-palette-row-name';
            name.textContent = m.entry.name;
            const qual = document.createElement('span');
            qual.className = 'search-palette-row-qual';
            /*
             * Hide the prefix duplication when the qualified form is just
             * `<db>.<name>` — show only the db prefix in muted form.
             */
            qual.textContent = m.entry.qualifiedName === m.entry.name
                ? ''
                : m.entry.qualifiedName.replace(`.${m.entry.name}`, '');
            row.append(kind, name, qual);
            this._list.append(row);
        });
    }

    private _updateActiveClasses(): void {
        const rows = this._list.querySelectorAll('.search-palette-row');
        rows.forEach((row, i) => {
            row.classList.toggle('search-palette-row--active', i === this._activeIdx);
        });
        const active = rows[this._activeIdx] as HTMLElement | undefined;
        if (active) {active.scrollIntoView({block: 'nearest'});}
    }

    private _onKey(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.preventDefault();
            this._close(null);
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            const pick = this._matches[this._activeIdx]?.entry ?? null;
            this._close(pick);
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (this._matches.length > 0) {
                this._activeIdx = (this._activeIdx + 1) % this._matches.length;
                this._updateActiveClasses();
            }
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (this._matches.length > 0) {
                this._activeIdx = (this._activeIdx - 1 + this._matches.length) % this._matches.length;
                this._updateActiveClasses();
            }
        }
    }

}