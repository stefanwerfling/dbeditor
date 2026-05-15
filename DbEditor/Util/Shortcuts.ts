/**
 * Static registry of every keyboard / mouse shortcut the editor binds.
 * Lives here (not as a wired-up source of truth) because the handlers
 * themselves are spread across `_wireKeyboard`, `_wireRubberBand`,
 * `_wireWheelZoom`, `_wireMiddleMousePan`, etc., and centralising
 * registration would mean carrying the whole keyboard surface around as
 * a string-key table — more abstraction than the editor warrants. So
 * this is just a documentation surface that the Help dialog reads.
 * Keep entries in sync when you add a new shortcut.
 *
 * `keys` is rendered verbatim as the chord; use `+` to separate modifiers
 * and `,` to separate alternative chords (e.g. "Ctrl + Z" or "Cmd + Z").
 * The Help dialog displays `Ctrl/Cmd` literally — macOS users mentally
 * substitute.
 */

export type ShortcutCategory = 'Edit' | 'Navigate' | 'Canvas' | 'Selection';

export type ShortcutEntry = {
    category: ShortcutCategory;
    keys: string;
    label: string;
};

export const KEYBOARD_SHORTCUTS: ShortcutEntry[] = [
    /* Edit */
    {category: 'Edit', keys: 'Ctrl/Cmd + Z',           label: 'Undo'},
    {category: 'Edit', keys: 'Ctrl/Cmd + Shift + Z, Ctrl/Cmd + Y', label: 'Redo'},
    {category: 'Edit', keys: 'R or F2',                label: 'Rename selected table(s). 1 = inline, 2+ = bulk pattern dialog with {name}/{name:lower}/{name:upper}/{name:snake} placeholders (R only; F2 always inline, single-target only).'},
    {category: 'Edit', keys: 'O',                     label: 'Edit table options (1 selected = full; 2+ = sparse-patch batch)'},
    {category: 'Edit', keys: 'L',                     label: 'Assign selected table(s) to an EER diagram'},
    {category: 'Edit', keys: 'Delete, Backspace',     label: 'Delete selected (single or multiple)'},
    {category: 'Edit', keys: 'Ctrl/Cmd + Shift + C',  label: 'Copy SQL for selected tables to clipboard'},

    /* Navigate */
    {category: 'Navigate', keys: 'Ctrl/Cmd + P, Ctrl/Cmd + K', label: 'Open search palette (jump to table)'},
    {category: 'Navigate', keys: 'Ctrl/Cmd + F',              label: 'Focus the treeview filter'},
    {category: 'Navigate', keys: '?',                          label: 'Show this help'},

    /* Canvas */
    {category: 'Canvas', keys: 'Ctrl + wheel',     label: 'Zoom around cursor'},
    {category: 'Canvas', keys: 'Topbar +/−/100%',  label: 'Zoom in / out / reset'},
    {category: 'Canvas', keys: 'F, ⛶ button',     label: 'Fit everything in view'},
    {category: 'Canvas', keys: 'Middle-mouse drag', label: 'Pan canvas'},
    {category: 'Canvas', keys: 'Space + drag',     label: 'Pan canvas (keyboard alternative)'},

    /* Selection */
    {category: 'Selection', keys: 'Click card',             label: 'Select (replaces)'},
    {category: 'Selection', keys: 'Shift + click',          label: 'Add card to selection'},
    {category: 'Selection', keys: 'Ctrl/Cmd + click',       label: 'Toggle card in selection'},
    {category: 'Selection', keys: 'Drag from background',   label: 'Rubber-band select'},
    {category: 'Selection', keys: 'Click background',       label: 'Clear selection'},
    {category: 'Canvas',    keys: 'Alt + drag background',  label: 'Sketch a new EER diagram (asks for name on release)'}
];

export const categoriesInOrder: ShortcutCategory[] = ['Edit', 'Navigate', 'Canvas', 'Selection'];