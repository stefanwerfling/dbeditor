import {beforeEach, describe, expect, it} from 'vitest';
import {MariaDbDialect} from '../../../BundledPlugins/MariaDb/MariaDbDialect.js';
import {MySqlDialect} from '../../../BundledPlugins/MySql/MySqlDialect.js';
import {PostgresDialect} from '../../../BundledPlugins/Postgres/PostgresDialect.js';
import {SqliteDialect} from '../../../BundledPlugins/Sqlite/SqliteDialect.js';
import {FileFormatPlugin} from '../../../editor_core/Plugin/FileFormatPlugin.js';
import {PluginBootstrap} from '../../../editor_core/Plugin/PluginBootstrap.js';
import {PluginRegistry} from '../../../editor_core/Plugin/PluginRegistry.js';

class FakeFormat extends FileFormatPlugin {

    public readonly id = 'fake';
    public readonly displayName = 'Fake';
    public readonly extensions = ['fake', 'fk'] as const;
    public readonly mimeType = 'application/x-fake';
    public import(): never { throw new Error('not used in this test'); }
    public export(): never { throw new Error('not used in this test'); }

}

describe('PluginRegistry', () => {
    beforeEach(() => {
        PluginRegistry.resetForTests();
    });

    it('returns undefined for unknown lookups before registration', () => {
        expect(PluginRegistry.instance.dialect('mysql')).toBeUndefined();
        expect(PluginRegistry.instance.fileFormat('fake')).toBeUndefined();
        expect(PluginRegistry.instance.generationHooks()).toEqual([]);
        expect(PluginRegistry.instance.dbConnection('mysql')).toBeUndefined();
        expect(PluginRegistry.instance.dbConnectionForDialect('mysql')).toBeUndefined();
    });

    it('registers a dialect and looks it up by id', () => {
        const plugin = new MySqlDialect();
        PluginRegistry.instance.register(plugin);
        expect(PluginRegistry.instance.dialect('mysql')).toBe(plugin);
    });

    it('looks up file-format plugins by extension (case-insensitive, leading dot ignored)', () => {
        const plugin = new FakeFormat();
        PluginRegistry.instance.register(plugin);
        expect(PluginRegistry.instance.fileFormatByExtension('fake')).toBe(plugin);
        expect(PluginRegistry.instance.fileFormatByExtension('.FK')).toBe(plugin);
        expect(PluginRegistry.instance.fileFormatByExtension('unknown')).toBeUndefined();
    });

    it('re-registering the same id overwrites the previous entry', () => {
        const a = new MySqlDialect();
        const b = new MySqlDialect();
        PluginRegistry.instance.register(a);
        PluginRegistry.instance.register(b);
        expect(PluginRegistry.instance.dialect('mysql')).toBe(b);
    });
});

describe('PluginBootstrap.bootstrapBuiltins', () => {
    beforeEach(() => {
        PluginRegistry.resetForTests();
    });

    it('registers all four bundled dialects', () => {
        PluginBootstrap.bootstrapBuiltins();
        expect(PluginRegistry.instance.dialect('mysql')).toBeInstanceOf(MySqlDialect);
        expect(PluginRegistry.instance.dialect('mariadb')).toBeInstanceOf(MariaDbDialect);
        expect(PluginRegistry.instance.dialect('postgres')).toBeInstanceOf(PostgresDialect);
        expect(PluginRegistry.instance.dialect('sqlite')).toBeInstanceOf(SqliteDialect);
    });

    it('is idempotent', () => {
        PluginBootstrap.bootstrapBuiltins();
        const first = PluginRegistry.instance.dialect('mysql');
        PluginBootstrap.bootstrapBuiltins();
        const second = PluginRegistry.instance.dialect('mysql');
        expect(second).toBeInstanceOf(MySqlDialect);
        expect(first).not.toBe(second);
    });
});