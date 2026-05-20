import {MySqlDialect} from './MySqlDialect.js';

/**
 * MariaDB DDL — close enough to MySQL for the surface area we render.
 * Subclassed so we can diverge later if needed (e.g. SEQUENCE support,
 * different JSON handling, RETURNING in DML). Inherits everything
 * from `MySqlDialect` (which extends `DialectPlugin`); only the plugin
 * identity is overridden.
 */
export class MariaDbDialect extends MySqlDialect {

    public override readonly id: string = 'mariadb';

    public override readonly displayName: string = 'MariaDB';

}