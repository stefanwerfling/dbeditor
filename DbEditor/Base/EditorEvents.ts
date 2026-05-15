/**
 * Custom window events the editor uses for component-to-component
 * communication. Components dispatch a CustomEvent with the matching
 * name on `window`, the controller (DbEditor) listens and translates
 * to API calls + canvas updates.
 *
 * Keep names alphanumerical-with-dashes — they're emitted as DOM
 * events and end up in dev tools listings.
 */
export const EditorEvents = {
    /** UI asks to switch the active database container. Detail: { unid }. */
    activateContainer: 'dbeditor:activate-container',

    /** UI asks to focus a specific table on the canvas. Detail: { tableUnid, containerUnid? }. */
    focusTable: 'dbeditor:focus-table',

    /**
     * Canvas table clicked → adjust selection. Detail: `{ tableUnid, additive?, toggle? }`.
     * Pass `null` for `tableUnid` to clear. `additive: true` (Shift-click)
     * extends the selection; `toggle: true` (Ctrl/Cmd-click) toggles the
     * one card in/out of the selection; neither = replace selection.
     */
    selectTable: 'dbeditor:select-table',

    /** Canvas asks the controller to (re)render. */
    redrawCanvas: 'dbeditor:redraw-canvas',

    /** A table card was moved. Detail: { tableUnid, x, y }. */
    tableMoved: 'dbeditor:table-moved',

    /** UI asks to delete a table. Detail: { tableUnid }. */
    deleteTable: 'dbeditor:delete-table',

    /** UI asks to clone a table within its container. Detail: { tableUnid }. */
    duplicateTable: 'dbeditor:duplicate-table',

    /** UI asks to rename a table. Detail: { tableUnid, name }. */
    renameTable: 'dbeditor:rename-table',

    /** UI asks to edit table options. Detail: { tableUnid }. */
    editTableOptions: 'dbeditor:edit-table-options',

    /** UI asks to add a column. Detail: { tableUnid, column }. */
    addColumn: 'dbeditor:add-column',

    /** UI asks to update a column. Detail: { tableUnid, columnUnid, patch }. */
    updateColumn: 'dbeditor:update-column',

    /** UI asks to remove a column. Detail: { tableUnid, columnUnid }. */
    removeColumn: 'dbeditor:remove-column',

    /** UI asks to add an index. Detail: { tableUnid, index }. */
    addIndex: 'dbeditor:add-index',

    /** UI asks to update an index. Detail: { tableUnid, indexUnid, patch }. */
    updateIndex: 'dbeditor:update-index',

    /** UI asks to remove an index. Detail: { tableUnid, indexUnid }. */
    removeIndex: 'dbeditor:remove-index',

    /** UI asks to move a column. Detail: { tableUnid, columnUnid, beforeColumnUnid | null }. */
    reorderColumn: 'dbeditor:reorder-column',

    /** UI asks to create a database/folder. Detail: { parentUnid, type, name }. */
    createContainer: 'dbeditor:create-container',

    /** UI asks to rename a database/folder. Detail: { unid, name }. */
    renameContainer: 'dbeditor:rename-container',

    /** UI asks to delete a database/folder (recursively). Detail: { unid }. */
    deleteContainer: 'dbeditor:delete-container',

    /** UI asks to create a table inside a specific container. Detail: { containerUnid, name }. */
    createTableIn: 'dbeditor:create-table-in',

    /** UI asks to create an enum inside a specific container. Detail: { containerUnid, name }. */
    createEnumIn: 'dbeditor:create-enum-in',

    /** UI asks to create an EER diagram (layer) inside a database container. Detail: { containerUnid, name }. */
    createLayerIn: 'dbeditor:create-layer-in',

    /** UI directly assigns one table to a specific layer (drag-drop, no picker). Detail: { tableUnid, layerUnid }. */
    assignTableToLayer: 'dbeditor:assign-table-to-layer',

    /** UI asks to rename an enum. Detail: { unid, name }. */
    renameEnum: 'dbeditor:rename-enum',

    /** UI asks to delete an enum. Detail: { unid }. */
    deleteEnum: 'dbeditor:delete-enum',

    /** UI asks to open the enum value editor. Detail: { unid }. */
    editEnum: 'dbeditor:edit-enum',

    /** UI asks to create a view inside a specific container. Detail: { containerUnid, name }. */
    createViewIn: 'dbeditor:create-view-in',

    /** UI asks to rename a view. Detail: { unid, name }. */
    renameView: 'dbeditor:rename-view',

    /** UI asks to delete a view. Detail: { unid }. */
    deleteView: 'dbeditor:delete-view',

    /** UI asks to open the view editor (name + SELECT body). Detail: { unid }. */
    editView: 'dbeditor:edit-view',

    /** A view card was moved on the canvas. Detail: { viewUnid, x, y }. */
    viewMoved: 'dbeditor:view-moved',

    /** UI asks to create a routine inside a container. Detail: { containerUnid, name, kind }. */
    createRoutineIn: 'dbeditor:create-routine-in',

    /** UI asks to rename a routine. Detail: { unid, name }. */
    renameRoutine: 'dbeditor:rename-routine',

    /** UI asks to delete a routine. Detail: { unid }. */
    deleteRoutine: 'dbeditor:delete-routine',

    /** UI asks to open the routine editor (name + kind + body). Detail: { unid }. */
    editRoutine: 'dbeditor:edit-routine',

    /** UI asks to rename a layer. Detail: { unid, name }. */
    renameLayer: 'dbeditor:rename-layer',

    /** UI asks to delete a layer. Detail: { unid }. */
    deleteLayer: 'dbeditor:delete-layer',

    /**
     * UI asks to assign one or more tables to a layer (or unassign).
     * Detail: { tableUnids: string[] }. The controller opens the
     * picker and applies the result via updateTable per table.
     */
    pickLayerForTables: 'dbeditor:pick-layer-for-tables',

    /**
     * UI asks to scope the canvas to a single EER-diagram (layer):
     * activate the parent database and show only tables whose
     * `layerUnid` matches. Detail: { layerUnid, containerUnid }.
     * Re-activating a different container (or any non-layer node)
     * clears the scope.
     */
    scopeToLayer: 'dbeditor:scope-to-layer',

    /**
     * UI asks to generate SQL for a single database or table (preview-only,
     * no disk write). Detail: `{ databaseUnid?: string; tableUnid?: string }`.
     * Exactly one of the two should be set; if both are, `tableUnid` wins.
     */
    generateScoped: 'dbeditor:generate-scoped',

    /** UI asks to add a foreign key. Detail: matches DbApi body. */
    addForeignKey: 'dbeditor:add-foreign-key',

    /** UI asks to remove a foreign key. Detail: { tableUnid, fkUnid }. */
    removeForeignKey: 'dbeditor:remove-foreign-key',

    /** Re-fetch projects/data from the server. */
    reload: 'dbeditor:reload',

    /** UI asks to open the Sync-with-DB dialog for a database container. Detail: { databaseUnid }. */
    openSyncDialog: 'dbeditor:open-sync-dialog',

    /** UI asks to re-introspect the live DB for a database container. Detail: { databaseUnid }. */
    refreshLive: 'dbeditor:refresh-live',

    /** UI asks to switch the treeview between "Modell" and "Live" mode. Detail: { mode: 'model' | 'live' }. */
    switchTreeviewMode: 'dbeditor:switch-treeview-mode',

    /** UI asks to open the database-defaults (properties) dialog. Detail: { unid }. */
    openDatabaseProperties: 'dbeditor:open-database-properties'
} as const;

export type EditorEventName = typeof EditorEvents[keyof typeof EditorEvents];

export const dispatch = (name: EditorEventName, detail: unknown): void => {
    window.dispatchEvent(new CustomEvent(name, {detail: detail}));
};