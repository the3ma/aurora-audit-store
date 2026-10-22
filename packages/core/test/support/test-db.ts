import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { describe } from 'vitest';
import {
  Database,
  envCredentialProvider,
  INSERT_EVENTS_SQL,
  migrate,
  parseDatabaseUrl,
  type DbCredentials,
  type MigrateResult,
} from '../../src/index.js';

/**
 * Integration tests run against a real PostgreSQL 16 when DATABASE_URL_ADMIN points at a superuser on
 * a disposable server (CI service container, or `npm run test:pg:local`). Each test file gets its own
 * database; the login roles are cluster-wide, which is why integration files run one at a time.
 */
export const ADMIN_URL = process.env['DATABASE_URL_ADMIN'];

export const describeWithPostgres = ADMIN_URL ? describe : describe.skip;

export const PASSWORDS = { owner: 'owner', writer: 'writer', reader: 'reader' } as const;

export interface TestDatabase {
  name: string;
  db: Database;
  env: Record<string, string>;
  /** Superuser client on the test database, for fixture surgery (disabling triggers etc.). */
  admin: pg.Client;
  /** A fresh client connected as one of the three roles (caller ends it). */
  connectAs(role: 'owner' | 'writer' | 'reader'): Promise<pg.Client>;
  migrate(options?: { runProofs?: boolean }): Promise<MigrateResult>;
  drop(): Promise<void>;
}

const url = (c: DbCredentials, user: string, password: string, database: string) =>
  `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${c.host}:${String(c.port)}/${database}`;

async function adminClient(database?: string): Promise<pg.Client> {
  if (!ADMIN_URL) throw new Error('DATABASE_URL_ADMIN is not set');
  const c = parseDatabaseUrl(ADMIN_URL);
  const client = new pg.Client({ ...c, database: database ?? c.database });
  client.on('notice', () => undefined);
  await client.connect();
  return client;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!ADMIN_URL) throw new Error('DATABASE_URL_ADMIN is not set');
  const admin = parseDatabaseUrl(ADMIN_URL);
  const name = `audit_it_${randomBytes(4).toString('hex')}`;

  const server = await adminClient();
  try {
    // The owner mirrors the RDS master user: CREATEROLE but not a superuser (unless the server's own
    // superuser already is audit_owner, as in docker compose).
    if (admin.user !== 'audit_owner') {
      const exists = await server.query(`SELECT 1 FROM pg_roles WHERE rolname = 'audit_owner'`);
      const verb = exists.rowCount ? 'ALTER' : 'CREATE';
      await server.query(
        `${verb} ROLE audit_owner WITH LOGIN CREATEROLE NOSUPERUSER PASSWORD ${pg.escapeLiteral(PASSWORDS.owner)}`,
      );
    }
    await server.query(`CREATE DATABASE ${pg.escapeIdentifier(name)} OWNER audit_owner`);
  } finally {
    await server.end();
  }

  const ownerPassword = admin.user === 'audit_owner' ? admin.password : PASSWORDS.owner;
  const env = {
    DATABASE_URL_OWNER: url(admin, 'audit_owner', ownerPassword, name),
    DATABASE_URL_WRITER: url(admin, 'audit_writer', PASSWORDS.writer, name),
    DATABASE_URL_READER: url(admin, 'audit_reader', PASSWORDS.reader, name),
    DB_SSL: 'disable',
  };
  const db = new Database({
    credentials: envCredentialProvider(env, () => Promise.reject(new Error('no secrets in tests'))),
    ssl: 'disable',
    poolMax: 4,
  });
  const adminOnDb = await adminClient(name);

  return {
    name,
    db,
    env,
    admin: adminOnDb,
    connectAs: async (role) => {
      const key = `DATABASE_URL_${role.toUpperCase()}` as keyof typeof env;
      const client = new pg.Client(parseDatabaseUrl(env[key]));
      client.on('notice', () => undefined);
      await client.connect();
      return client;
    },
    migrate: (options = {}) =>
      db.withClient('owner', (client) =>
        migrate(client, {
          rolePasswords: [
            { role: 'audit_writer', password: PASSWORDS.writer },
            { role: 'audit_reader', password: PASSWORDS.reader },
          ],
          ...options,
        }),
      ),
    drop: async () => {
      await db.end();
      await adminOnDb.end();
      const server2 = await adminClient();
      try {
        await server2.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
      } finally {
        await server2.end();
      }
    },
  };
}

export interface EventFixture {
  eventId?: string;
  tenantId?: string;
  projectId?: string | null;
  scope?: string;
  entityType?: string;
  entityId?: string;
  entityLabel?: string;
  action?: string;
  actorId?: string;
  actorEmail?: string;
  occurredAt: string;
  changes?: unknown[];
}

/** Inserts rows as audit_writer, the way the API and backfill do. */
export async function insertEvents(db: Database, events: readonly EventFixture[]): Promise<void> {
  const records = events.map((e) => ({
    event_id: e.eventId ?? crypto.randomUUID(),
    tenant_id: e.tenantId ?? 't-001',
    project_id: e.projectId ?? null,
    scope: e.scope ?? 'billing',
    entity_type: e.entityType ?? 'invoice',
    entity_id: e.entityId ?? 'inv-1',
    entity_label: e.entityLabel ?? 'Invoice inv-1',
    action: e.action ?? 'update',
    actor_id: e.actorId ?? 'u-1',
    actor_email: e.actorEmail ?? 'user1@example.test',
    occurred_at: e.occurredAt,
    changes: e.changes ?? [],
    comment: null,
    source: 'live',
  }));
  for (let i = 0; i < records.length; i += 500) {
    await db.withClient('writer', (c) =>
      c.query(INSERT_EVENTS_SQL, [JSON.stringify(records.slice(i, i + 500))]),
    );
  }
}
