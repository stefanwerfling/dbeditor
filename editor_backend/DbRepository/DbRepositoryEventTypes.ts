/**
 * One mutation event broadcast on a project's event bus. Each event carries
 * the project revision after the mutation, an op tag, and an opaque body.
 *
 * The body is whatever the route handler decided to publish — typically the
 * delta enough for the frontend reducer to apply the change without a full
 * reload. Any client receiving an event whose `clientId` matches its own
 * `X-Client-Id` ignores it (already applied locally).
 */
export type DbRepositoryEvent = {
    rev: number;
    op: string;
    clientId: string | null;
    body: unknown;
};