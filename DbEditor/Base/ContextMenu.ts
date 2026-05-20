/**
 * Lightweight popover-style context menu anchored to a trigger button.
 * One menu can be open at a time. Closes on outside click, Escape, or
 * after an item is picked. The trigger button is what got clicked, not
 * the row — we anchor to its bounding rect so the menu lines up with
 * the visible affordance regardless of where the row extends.
 */
export type ContextMenuItem =
    | {
        kind?: 'item';
        label: string;
        onClick: () => void;
        danger?: boolean;
        disabled?: boolean;
        /**
         * Right-aligned hint shown after the label (e.g. a keyboard
         * shortcut like "Ctrl+Z"). Purely visual — does NOT register
         * the shortcut; callers wire their own listener.
         */
        hint?: string;
    }
    | {kind: 'separator';};

export class ContextMenu {

    private static _openCleanup: (() => void) | null = null;

    private static _closeCurrent(): void {
        if (ContextMenu._openCleanup) {
            ContextMenu._openCleanup();
            ContextMenu._openCleanup = null;
        }
    }

    public static open(anchor: HTMLElement, items: ContextMenuItem[]): void {
        ContextMenu._closeCurrent();

        const menu = document.createElement('div');
        menu.className = 'context-menu';

        for (const item of items) {
            if (item.kind === 'separator') {
                const sep = document.createElement('div');
                sep.className = 'context-menu-sep';
                menu.append(sep);
                continue;
            }
            const btn = document.createElement('button');
            btn.className = `context-menu-item${item.danger ? ' context-menu-item-danger' : ''}`;
            const label = document.createElement('span');
            label.className = 'context-menu-item-label';
            label.textContent = item.label;
            btn.append(label);
            if (item.hint) {
                const hint = document.createElement('span');
                hint.className = 'context-menu-item-hint';
                hint.textContent = item.hint;
                btn.append(hint);
            }
            btn.disabled = Boolean(item.disabled);
            btn.addEventListener('click', (e): void => {
                e.stopPropagation();
                ContextMenu._closeCurrent();
                item.onClick();
            });
            menu.append(btn);
        }

        document.body.append(menu);
        const ar = anchor.getBoundingClientRect();
        const mr = menu.getBoundingClientRect();
        let top = ar.bottom + 4;
        let left = ar.left;
        if (top + mr.height > window.innerHeight - 8) {
            top = ar.top - mr.height - 4;
        }
        if (left + mr.width > window.innerWidth - 8) {
            left = ar.right - mr.width;
        }
        if (left < 8) {
            left = 8;
        }
        if (top < 8) {
            top = 8;
        }
        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;

        const onDocPointerDown = (e: MouseEvent): void => {
            if (!menu.contains(e.target as Node) && e.target !== anchor) {
                ContextMenu._closeCurrent();
            }
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                ContextMenu._closeCurrent();
            }
        };
        const onScroll = (): void => ContextMenu._closeCurrent();

        ContextMenu._openCleanup = (): void => {
            menu.remove();
            document.removeEventListener('mousedown', onDocPointerDown, true);
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onScroll);
        };

        setTimeout((): void => {
            document.addEventListener('mousedown', onDocPointerDown, true);
        });
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);
    }

}