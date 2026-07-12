/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.db` (note: NOT `context.sql`, despite the class name — see
 * `Container.ts`'s `ServiceContainer`). Thin wrapper around the `mssql` driver for one-shot SQL
 * Server queries; connects lazily on first use and closes the pool again after every `select()`
 * call (see `init()`/`close()`) rather than holding a long-lived connection, since Tyr commands
 * are short-lived CLI invocations, not a long-running server.
 */
import path from 'path';
import sql, { config as SQLConfig } from 'mssql';
import { getEnvString } from '../core/util/getenv.js';

/**
 * @class SQLManager
 * @description SQL Server database connector.
 */
export class SQLManager {
  private pool!: sql.ConnectionPool;
  private connected = false;

  constructor() {
  }

  private async init(): Promise<void> {
    if (!this.connected) {

      const db_config: SQLConfig = {
        user: getEnvString('MSSQL_USER'),
        password: getEnvString('MSSQL_PASSWORD'),
        server: getEnvString('MSSQL_SERVER') || '',
        database: getEnvString('MSSQL_DATABASE'),
        options: {
          encrypt: false,
          trustServerCertificate: true
        }
      };

      this.pool = await sql.connect(db_config);
      this.connected = true;
    }
  }

  /**
   * @method select
   * @description Executes a SELECT command on SQL Server and returns the result as JSON.
   * @param {string} query - The full SELECT command.
   * @returns {Promise<any[]>} The result records.
   * @example
   * await dbManager.init();
   * const data = await dbManager.select('SELECT * FROM table');
   */
  public async select(query: string): Promise<any[]> {
    await this.init();

    const result = await this.pool.request().query(query);

    await this.close();
    return result.recordset;
  }

  private async close(): Promise<void> {
    if (this.connected && this.pool) {
      await this.pool.close();
      this.connected = false;
    }
  }
}

/**
 * @object SQLManagerTests
 * @description Test parameters to validate SQLManager functionality.
 */
export const SQLManagerTests = {
    // init: {},
    // select: { query: 'SELECT 1 as test_value' },
    // connectionPool: { queries: ['SELECT 1 as q1', 'SELECT 2 as q2', 'SELECT 3 as q3'] }
};