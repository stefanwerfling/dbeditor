/**
 * Carried by card classes (DbTable, DbView) so their menus know which
 * EER diagram is currently scoped and can show / label
 * "Remove from <diagram>" entries. `null` when no scope is active.
 */
export type ActiveDiagramContext = { unid: string; name: string; };