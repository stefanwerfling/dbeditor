/**
 * Synthesised `unid` scheme for objects discovered by live introspection.
 *
 * Shared across all introspectors so the diff engine can match model
 * (random UUIDs) against live (deterministic, name-derived) consistently.
 * The strings travel cross-process as the `unid` field on `JsonTable` /
 * `JsonColumn` / etc., so the format is effectively a stable contract —
 * any change here invalidates in-flight reverse-sync URIs.
 *
 * Format: `live:<kind>:<db>:<container>:<name>`. Database-level kinds
 * omit the container segment.
 */
export class LiveUridScheme {

    public static table(db: string, t: string): string {
        return `live:t:${db}:${t}`;
    }

    public static column(db: string, t: string, c: string): string {
        return `live:c:${db}:${t}:${c}`;
    }

    public static index(db: string, t: string, i: string): string {
        return `live:i:${db}:${t}:${i}`;
    }

    public static fk(db: string, t: string, n: string): string {
        return `live:fk:${db}:${t}:${n}`;
    }

    public static view(db: string, v: string): string {
        return `live:v:${db}:${v}`;
    }

    public static db(db: string): string {
        return `live:db:${db}`;
    }

    /** Postgres-only — MySQL inlines enums as a column type, SQLite has no enums. */
    public static enumType(db: string, e: string): string {
        return `live:e:${db}:${e}`;
    }

}