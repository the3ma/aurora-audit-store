import pg from 'pg';
import { SqlState, sqlState } from '../errors.js';
import { silentLogger, type Logger } from '../logger.js';
import { envCredentialProvider, type CredentialProvider, type DbRole } from './credentials.js';
import { parseSslMode, tlsOptions, type SslMode } from './tls.js';

export type DbClient = pg.PoolClient;

export interface DatabaseOptions {
  credentials: CredentialProvider;
  ssl: SslMode;
  logger?: Logger;
  /** Per-role pool size. Lambda serves one request per environment, so 2 is plenty there. */
  poolMax?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
}

const AUTH_FAILURES: ReadonlySet<string> = new Set([
  SqlState.invalidPassword,
  SqlState.invalidAuthorization,
]);

/** Server-reported errors leave the connection usable; anything else (socket, TLS) poisons it. */
function isServerError(error: unknown): boolean {
  return error instanceof pg.DatabaseError;
}

export class Database {
  private readonly pools = new Map<DbRole, Promise<pg.Pool>>();
  private readonly logger: Logger;

  constructor(private readonly options: DatabaseOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  hasRole(role: DbRole): boolean {
    return this.options.credentials.has(role);
  }

  credentials(role: DbRole) {
    return this.options.credentials.resolve(role);
  }

  async withClient<T>(role: DbRole, fn: (client: DbClient) => Promise<T>): Promise<T> {
    const client = await this.connect(role);
    let failure: unknown;
    try {
      return await fn(client);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      client.release(failure !== undefined && !isServerError(failure));
    }
  }

  async withTransaction<T>(role: DbRole, fn: (client: DbClient) => Promise<T>): Promise<T> {
    return this.withClient(role, async (client) => {
      await client.query('BEGIN');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async end(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.allSettled(pools.map(async (p) => (await p).end()));
  }

  /**
   * After a password rotation the cached secret and every pooled connection are stale. On 28P01/28000
   * drop both and retry exactly once; a second failure is a real misconfiguration and surfaces.
   */
  private async connect(role: DbRole): Promise<DbClient> {
    const pool = await this.pool(role);
    try {
      return await pool.connect();
    } catch (error) {
      const code = sqlState(error);
      if (code === undefined || !AUTH_FAILURES.has(code)) throw error;
      const { rotating } = await this.options.credentials.resolve(role);
      if (!rotating) throw error;
      this.logger.warn('database authentication failed; refreshing credentials', { role, code });
      this.options.credentials.invalidate(role);
      await this.dropPool(role);
      return (await this.pool(role)).connect();
    }
  }

  private pool(role: DbRole): Promise<pg.Pool> {
    let pending = this.pools.get(role);
    if (!pending) {
      pending = this.createPool(role);
      pending.catch(() => this.pools.delete(role));
      this.pools.set(role, pending);
    }
    return pending;
  }

  private async dropPool(role: DbRole): Promise<void> {
    const pending = this.pools.get(role);
    this.pools.delete(role);
    if (pending) await (await pending).end().catch(() => undefined);
  }

  private async createPool(role: DbRole): Promise<pg.Pool> {
    const { credentials } = await this.options.credentials.resolve(role);
    const pool = new pg.Pool({
      host: credentials.host,
      port: credentials.port,
      database: credentials.database,
      user: credentials.user,
      password: credentials.password,
      ssl: tlsOptions(this.options.ssl, credentials.host),
      max: this.options.poolMax ?? 2,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: this.options.statementTimeoutMs ?? 30_000,
      idle_in_transaction_session_timeout: 60_000,
      application_name: this.options.applicationName ?? `audit-${role}`,
    });
    // An idle client dying (failover, rotation) emits on the pool; unhandled it would crash the process.
    pool.on('error', (error) => {
      this.logger.warn('idle database connection failed', { role, error });
    });
    return pool;
  }
}

export interface DatabaseFromEnvOptions {
  env?: Readonly<Record<string, string | undefined>>;
  logger?: Logger;
  poolMax?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
}

export function databaseFromEnv(options: DatabaseFromEnvOptions = {}): Database {
  const { env = process.env, ...rest } = options;
  return new Database({
    ...rest,
    credentials: envCredentialProvider(env),
    ssl: parseSslMode(env['DB_SSL']),
  });
}

/** What jobs and the API need from a Database; narrow enough to stub in unit tests. */
export type DbAccess = Pick<Database, 'withClient'>;
