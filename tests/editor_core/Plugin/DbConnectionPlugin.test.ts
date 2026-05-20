import {beforeEach, describe, expect, it} from 'vitest';
import {MysqlDriver} from '../../../BundledPlugins/MySql/MysqlDriver.js';
import {PostgresDriver} from '../../../BundledPlugins/Postgres/PostgresDriver.js';
import {SqliteDriver} from '../../../BundledPlugins/Sqlite/SqliteDriver.js';
import {pickDriver} from '../../../editor_backend/DbConnection/DriverFactory.js';
import {DbIntrospector} from '../../../editor_backend/DbIntrospect/DbIntrospector.js';
import {MysqlIntrospector} from '../../../BundledPlugins/MySql/MysqlIntrospector.js';
import {PostgresIntrospector} from '../../../BundledPlugins/Postgres/PostgresIntrospector.js';
import {SqliteIntrospector} from '../../../BundledPlugins/Sqlite/SqliteIntrospector.js';
import {MysqlDumpAdapter} from '../../../BundledPlugins/MySql/MysqlDumpAdapter.js';
import {DbConnectionPlugin} from '../../../editor_core/Plugin/DbConnectionPlugin.js';
import {PluginBootstrap} from '../../../editor_core/Plugin/PluginBootstrap.js';
import {PluginKind} from '../../../editor_core/Plugin/PluginKind.js';
import {PluginRegistry} from '../../../editor_core/Plugin/PluginRegistry.js';

const fakeIntrospector: DbIntrospector = {
    introspect: () => { throw new Error('not used in this test'); }
};

class FakeDriver extends DbConnectionPlugin {

    public readonly id = 'fake';
    public readonly displayName = 'Fake';
    public readonly supportedDialects = ['fake', 'fk'] as const;
    public async connect(): Promise<never> {
        throw new Error('not used in this test');
    }
    public introspector(): DbIntrospector {
        return fakeIntrospector;
    }

}

describe('DbConnectionPlugin', () => {
    beforeEach(() => {
        PluginRegistry.resetForTests();
    });

    it('reports the DbConnection kind', () => {
        const plugin = new FakeDriver();
        expect(plugin.kind).toBe(PluginKind.DbConnection);
    });

    it('looks up a driver by plugin id', () => {
        const plugin = new FakeDriver();
        PluginRegistry.instance.register(plugin);
        expect(PluginRegistry.instance.dbConnection('fake')).toBe(plugin);
        expect(PluginRegistry.instance.dbConnection('missing')).toBeUndefined();
    });

    it('resolves by dialect via supportedDialects (case-insensitive)', () => {
        const plugin = new FakeDriver();
        PluginRegistry.instance.register(plugin);
        expect(PluginRegistry.instance.dbConnectionForDialect('fake')).toBe(plugin);
        expect(PluginRegistry.instance.dbConnectionForDialect('FK')).toBe(plugin);
        expect(PluginRegistry.instance.dbConnectionForDialect('unknown')).toBeUndefined();
    });
});

describe('PluginBootstrap.bootstrapBuiltins (db-connection drivers)', () => {
    beforeEach(() => {
        PluginRegistry.resetForTests();
    });

    it('registers all three bundled drivers', () => {
        PluginBootstrap.bootstrapBuiltins();
        expect(PluginRegistry.instance.dbConnection('mysql')).toBeInstanceOf(MysqlDriver);
        expect(PluginRegistry.instance.dbConnection('postgres')).toBeInstanceOf(PostgresDriver);
        expect(PluginRegistry.instance.dbConnection('sqlite')).toBeInstanceOf(SqliteDriver);
    });

    it('maps mariadb dialect to the MySQL driver', () => {
        PluginBootstrap.bootstrapBuiltins();
        expect(PluginRegistry.instance.dbConnectionForDialect('mariadb')).toBeInstanceOf(MysqlDriver);
        expect(PluginRegistry.instance.dbConnectionForDialect('mysql')).toBeInstanceOf(MysqlDriver);
    });

    it('each bundled driver returns its paired introspector', () => {
        PluginBootstrap.bootstrapBuiltins();
        expect(new MysqlDriver().introspector()).toBeInstanceOf(MysqlIntrospector);
        expect(new PostgresDriver().introspector()).toBeInstanceOf(PostgresIntrospector);
        expect(new SqliteDriver().introspector()).toBeInstanceOf(SqliteIntrospector);
    });

    it('MysqlDriver exposes a dump adapter; Postgres/Sqlite return null (not yet implemented)', () => {
        expect(new MysqlDriver().dumpAdapter()).toBeInstanceOf(MysqlDumpAdapter);
        expect(new PostgresDriver().dumpAdapter()).toBeNull();
        expect(new SqliteDriver().dumpAdapter()).toBeNull();
    });
});

describe('pickDriver (registry-backed)', () => {
    beforeEach(() => {
        PluginRegistry.resetForTests();
    });

    it('lazily bootstraps builtins on first call', () => {
        expect(pickDriver('mysql')).toBeInstanceOf(MysqlDriver);
        expect(pickDriver('mariadb')).toBeInstanceOf(MysqlDriver);
        expect(pickDriver('postgres')).toBeInstanceOf(PostgresDriver);
        expect(pickDriver('sqlite')).toBeInstanceOf(SqliteDriver);
    });

    it('throws on unknown dialect', () => {
        expect(() => pickDriver('oracle')).toThrow(/unknown dialect/u);
    });
});