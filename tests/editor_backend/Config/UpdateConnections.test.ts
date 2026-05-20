/*
 * Literal ${VAR} strings in this file are *test data* — they exercise
 * that env-placeholder syntax round-trips through the connection
 * persistence diagram untouched, not stray un-templated literals.
 */
/* eslint-disable no-template-curly-in-string */
import {describe, expect, it} from 'vitest';
import {
    ConnectionConfig,
    ConnectionConfigError
} from '../../../editor_backend/Config/UpdateConnections.js';

const baseConfig = (extraConn?: Record<string, any>): unknown => ({
    projects: [
        {
            name: 'MyDatabase',
            schemaPath: './schemas/database.json',
            dialect: 'mariadb',
            output: {mode: 'ddl-files', destinationPath: './schemas/sql'},
            ...extraConn ? {connections: [extraConn]} : {}
        }
    ],
    server: {port: 5274}
});

const validInput = (overrides: Record<string, any> = {}): any => ({
    databaseUnid: 'db-uuid-1',
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '${PWD}',
    database: 'app',
    ...overrides
});

const expectError = (fn: () => unknown, code: string): ConnectionConfigError => {
    try {
        fn();
    } catch (err) {
        expect(err).toBeInstanceOf(ConnectionConfigError);
        const cErr = err as ConnectionConfigError;
        expect(cErr.code).toBe(code);
        return cErr;
    }
    throw new Error(`expected ConnectionConfigError with code "${code}" but call returned normally`);
};

describe('addConnectionToConfig', () => {

    it('appends to a connectionless project', () => {
        const next = ConnectionConfig.add(baseConfig(), 'MyDatabase', validInput());
        expect(next.projects[0].connections).toHaveLength(1);
        expect(next.projects[0].connections![0]).toMatchObject({
            databaseUnid: 'db-uuid-1',
            host: 'localhost',
            port: 3306,
            user: 'root',
            password: '${PWD}',
            database: 'app'
        });
    });

    it('appends alongside an existing connection on the same project', () => {
        const cfg = baseConfig({databaseUnid: 'db-uuid-0', host: 'a', user: 'u', database: 'd'});
        const next = ConnectionConfig.add(cfg, 'MyDatabase', validInput());
        expect(next.projects[0].connections).toHaveLength(2);
        expect(next.projects[0].connections!.map(c => c.databaseUnid)).toEqual(['db-uuid-0', 'db-uuid-1']);
    });

    it('looks up the project case-insensitively', () => {
        const next = ConnectionConfig.add(baseConfig(), 'mydatabase', validInput());
        expect(next.projects[0].connections).toHaveLength(1);
    });

    it('rejects when no project of that name exists', () => {
        expectError(
            () => ConnectionConfig.add(baseConfig(), 'Other', validInput()),
            'unknown-project'
        );
    });

    it('rejects duplicate databaseUnid within the same project', () => {
        const cfg = baseConfig({databaseUnid: 'db-uuid-1', host: 'h', user: 'u', database: 'd'});
        expectError(
            () => ConnectionConfig.add(cfg, 'MyDatabase', validInput()),
            'duplicate-connection'
        );
    });

    it('rejects empty host after trim', () => {
        expectError(
            () => ConnectionConfig.add(baseConfig(), 'MyDatabase', validInput({host: '   '})),
            'invalid-input'
        );
    });

    it('rejects empty user after trim', () => {
        expectError(
            () => ConnectionConfig.add(baseConfig(), 'MyDatabase', validInput({user: '   '})),
            'invalid-input'
        );
    });

    it('rejects empty database after trim', () => {
        expectError(
            () => ConnectionConfig.add(baseConfig(), 'MyDatabase', validInput({database: '   '})),
            'invalid-input'
        );
    });

    it('rejects empty databaseUnid after trim', () => {
        expectError(
            () => ConnectionConfig.add(baseConfig(), 'MyDatabase', validInput({databaseUnid: '   '})),
            'invalid-input'
        );
    });

    it('omits optional fields when not supplied (clean on-disk shape)', () => {
        const next = ConnectionConfig.add(baseConfig(), 'MyDatabase', {
            databaseUnid: 'db-uuid-1',
            host: 'localhost',
            user: 'root',
            database: 'app'
        } as any);
        const c = next.projects[0].connections![0] as any;
        expect(c.port).toBeUndefined();
        expect(c.password).toBeUndefined();
        expect(c.ssl).toBeUndefined();
        expect(c.readOnly).toBeUndefined();
    });

    it('keeps ssl/readOnly only when true (false-equals-omit)', () => {
        const next = ConnectionConfig.add(baseConfig(), 'MyDatabase', validInput({ssl: false, readOnly: false}));
        const c = next.projects[0].connections![0] as any;
        expect(c.ssl).toBeUndefined();
        expect(c.readOnly).toBeUndefined();
    });

    it('preserves boolean true for ssl + readOnly', () => {
        const next = ConnectionConfig.add(baseConfig(), 'MyDatabase', validInput({ssl: true, readOnly: true}));
        expect(next.projects[0].connections![0].ssl).toBe(true);
        expect(next.projects[0].connections![0].readOnly).toBe(true);
    });

    it('rejects malformed config (missing projects array)', () => {
        expectError(
            () => ConnectionConfig.add({server: {port: 5174}}, 'MyDatabase', validInput()),
            'invalid-config'
        );
    });

});

describe('updateConnectionInConfig', () => {

    const seeded = (extra: Record<string, any> = {}): unknown => baseConfig({
        databaseUnid: 'db-uuid-1',
        host: 'old-host',
        port: 3306,
        user: 'old-user',
        password: '${OLD_PWD}',
        database: 'old-db',
        ...extra
    });

    it('replaces only the patched fields', () => {
        const next = ConnectionConfig.update(seeded(), 'MyDatabase', 'db-uuid-1', {host: 'new-host'});
        const c = next.projects[0].connections![0];
        expect(c.host).toBe('new-host');
        expect(c.user).toBe('old-user');
        expect(c.database).toBe('old-db');
        expect(c.port).toBe(3306);
        expect(c.password).toBe('${OLD_PWD}');
    });

    it('keeps unchanged fields verbatim when patch is empty', () => {
        const next = ConnectionConfig.update(seeded(), 'MyDatabase', 'db-uuid-1', {});
        expect(next.projects[0].connections![0]).toMatchObject({
            host: 'old-host',
            port: 3306,
            user: 'old-user',
            password: '${OLD_PWD}',
            database: 'old-db'
        });
    });

    it('rejects empty trimmed host (cannot clear)', () => {
        expectError(
            () => ConnectionConfig.update(seeded(), 'MyDatabase', 'db-uuid-1', {host: '   '}),
            'invalid-input'
        );
    });

    it('rejects empty trimmed user', () => {
        expectError(
            () => ConnectionConfig.update(seeded(), 'MyDatabase', 'db-uuid-1', {user: '   '}),
            'invalid-input'
        );
    });

    it('rejects empty trimmed database', () => {
        expectError(
            () => ConnectionConfig.update(seeded(), 'MyDatabase', 'db-uuid-1', {database: '   '}),
            'invalid-input'
        );
    });

    it('rejects non-finite port', () => {
        expectError(
            () => ConnectionConfig.update(seeded(), 'MyDatabase', 'db-uuid-1', {port: Number.NaN}),
            'invalid-input'
        );
    });

    it('clears password when patch sends empty string', () => {
        const next = ConnectionConfig.update(seeded(), 'MyDatabase', 'db-uuid-1', {password: ''});
        const c = next.projects[0].connections![0] as any;
        expect(c.password).toBeUndefined();
    });

    it('replaces password when patch sends a value', () => {
        const next = ConnectionConfig.update(seeded(), 'MyDatabase', 'db-uuid-1', {password: '${NEW_PWD}'});
        expect(next.projects[0].connections![0].password).toBe('${NEW_PWD}');
    });

    it('keeps password when patch omits the key', () => {
        const next = ConnectionConfig.update(seeded(), 'MyDatabase', 'db-uuid-1', {host: 'new-host'});
        expect(next.projects[0].connections![0].password).toBe('${OLD_PWD}');
    });

    it('toggles ssl on and off (false removes the key)', () => {
        const on = ConnectionConfig.update(seeded(), 'MyDatabase', 'db-uuid-1', {ssl: true});
        expect(on.projects[0].connections![0].ssl).toBe(true);
        const off = ConnectionConfig.update(on, 'MyDatabase', 'db-uuid-1', {ssl: false});
        expect((off.projects[0].connections![0] as any).ssl).toBeUndefined();
    });

    it('toggles readOnly on and off (false removes the key)', () => {
        const on = ConnectionConfig.update(seeded(), 'MyDatabase', 'db-uuid-1', {readOnly: true});
        expect(on.projects[0].connections![0].readOnly).toBe(true);
        const off = ConnectionConfig.update(on, 'MyDatabase', 'db-uuid-1', {readOnly: false});
        expect((off.projects[0].connections![0] as any).readOnly).toBeUndefined();
    });

    it('rejects unknown project', () => {
        expectError(
            () => ConnectionConfig.update(seeded(), 'Other', 'db-uuid-1', {host: 'x'}),
            'unknown-project'
        );
    });

    it('rejects unknown databaseUnid', () => {
        expectError(
            () => ConnectionConfig.update(seeded(), 'MyDatabase', 'db-uuid-99', {host: 'x'}),
            'unknown-connection'
        );
    });

    it('leaves the other connections on the same project untouched', () => {
        const cfg = {
            projects: [{
                name: 'MyDatabase',
                schemaPath: './schemas/database.json',
                dialect: 'mariadb',
                output: {mode: 'ddl-files', destinationPath: './schemas/sql'},
                connections: [
                    {databaseUnid: 'a', host: 'a-host', user: 'u', database: 'd'},
                    {databaseUnid: 'b', host: 'b-host', user: 'u', database: 'd'}
                ]
            }]
        };
        const next = ConnectionConfig.update(cfg, 'MyDatabase', 'a', {host: 'a-host-2'});
        expect(next.projects[0].connections![0].host).toBe('a-host-2');
        expect(next.projects[0].connections![1].host).toBe('b-host');
    });

});

describe('removeConnectionFromConfig', () => {

    it('removes the named connection', () => {
        const cfg = baseConfig({databaseUnid: 'db-uuid-1', host: 'h', user: 'u', database: 'd'});
        const next = ConnectionConfig.remove(cfg, 'MyDatabase', 'db-uuid-1');
        expect((next.projects[0] as any).connections).toBeUndefined();
    });

    it('leaves other connections untouched', () => {
        const cfg = {
            projects: [{
                name: 'MyDatabase',
                schemaPath: './schemas/database.json',
                dialect: 'mariadb',
                output: {mode: 'ddl-files', destinationPath: './schemas/sql'},
                connections: [
                    {databaseUnid: 'a', host: 'h', user: 'u', database: 'd'},
                    {databaseUnid: 'b', host: 'h', user: 'u', database: 'd'}
                ]
            }]
        };
        const next = ConnectionConfig.remove(cfg, 'MyDatabase', 'a');
        expect(next.projects[0].connections).toHaveLength(1);
        expect(next.projects[0].connections![0].databaseUnid).toBe('b');
    });

    it('rejects when project name unknown', () => {
        const cfg = baseConfig({databaseUnid: 'db-uuid-1', host: 'h', user: 'u', database: 'd'});
        expectError(
            () => ConnectionConfig.remove(cfg, 'Other', 'db-uuid-1'),
            'unknown-project'
        );
    });

    it('rejects when databaseUnid not present', () => {
        const cfg = baseConfig({databaseUnid: 'db-uuid-1', host: 'h', user: 'u', database: 'd'});
        expectError(
            () => ConnectionConfig.remove(cfg, 'MyDatabase', 'db-uuid-99'),
            'unknown-connection'
        );
    });

    it('rejects when project has no connections at all', () => {
        expectError(
            () => ConnectionConfig.remove(baseConfig(), 'MyDatabase', 'db-uuid-1'),
            'unknown-connection'
        );
    });

});

describe('rebindConnectionInConfig', () => {

    it('swaps databaseUnid while preserving all other fields and position', () => {
        const cfg = {
            ...baseConfig() as any,
            projects: [{
                name: 'MyDatabase',
                schemaPath: './schemas/database.json',
                dialect: 'mariadb',
                output: {mode: 'ddl-files', destinationPath: './schemas/sql'},
                connections: [
                    {databaseUnid: 'a', host: 'h-a', user: 'u-a', database: 'd-a'},
                    {databaseUnid: 'b', host: 'h-b', port: 3307, user: 'u-b', password: '${P}', database: 'd-b', ssl: true, readOnly: true}
                ]
            }]
        };
        const next = ConnectionConfig.rebind(cfg, 'MyDatabase', 'b', 'c');
        expect(next.projects[0].connections).toHaveLength(2);
        expect(next.projects[0].connections![0].databaseUnid).toBe('a');
        const rebound = next.projects[0].connections![1];
        expect(rebound).toEqual({
            databaseUnid: 'c',
            host: 'h-b',
            port: 3307,
            user: 'u-b',
            password: '${P}',
            database: 'd-b',
            ssl: true,
            readOnly: true
        });
    });

    it('treats same-source-and-target as a no-op success', () => {
        const cfg = baseConfig({databaseUnid: 'a', host: 'h', user: 'u', database: 'd'});
        const next = ConnectionConfig.rebind(cfg, 'MyDatabase', 'a', 'a');
        expect(next.projects[0].connections).toHaveLength(1);
        expect(next.projects[0].connections![0].databaseUnid).toBe('a');
    });

    it('rejects when project name unknown', () => {
        const cfg = baseConfig({databaseUnid: 'a', host: 'h', user: 'u', database: 'd'});
        expectError(
            () => ConnectionConfig.rebind(cfg, 'Other', 'a', 'b'),
            'unknown-project'
        );
    });

    it('rejects when oldDatabaseUnid not present', () => {
        const cfg = baseConfig({databaseUnid: 'a', host: 'h', user: 'u', database: 'd'});
        expectError(
            () => ConnectionConfig.rebind(cfg, 'MyDatabase', 'no-such', 'b'),
            'unknown-connection'
        );
    });

    it('rejects when newDatabaseUnid already has a connection', () => {
        const cfg = {
            ...baseConfig() as any,
            projects: [{
                name: 'MyDatabase',
                schemaPath: './schemas/database.json',
                dialect: 'mariadb',
                output: {mode: 'ddl-files', destinationPath: './schemas/sql'},
                connections: [
                    {databaseUnid: 'a', host: 'h', user: 'u', database: 'd'},
                    {databaseUnid: 'b', host: 'h', user: 'u', database: 'd'}
                ]
            }]
        };
        expectError(
            () => ConnectionConfig.rebind(cfg, 'MyDatabase', 'a', 'b'),
            'duplicate-connection'
        );
    });

    it('rejects when newDatabaseUnid is empty', () => {
        const cfg = baseConfig({databaseUnid: 'a', host: 'h', user: 'u', database: 'd'});
        expectError(
            () => ConnectionConfig.rebind(cfg, 'MyDatabase', 'a', '   '),
            'invalid-input'
        );
    });

});