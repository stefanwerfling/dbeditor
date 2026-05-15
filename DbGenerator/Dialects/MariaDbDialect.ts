import {MySqlDialect} from './MySqlDialect.js';

/**
 * MariaDB DDL — close enough to MySQL for the surface area we render.
 * Subclassed so we can diverge later if needed (e.g. SEQUENCE support,
 * different JSON handling, RETURNING in DML).
 */
export class MariaDbDialect extends MySqlDialect {}