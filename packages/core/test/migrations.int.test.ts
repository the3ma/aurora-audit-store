import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  migrate,
  MIGRATIONS,
  MigrationDriftError,
  ProofFailedError,
  runProofs,
  sqlState,
  toMigrations,
  type ProofResult,
} from '../src/index.js';
import {
  createTestDatabase,
  describeWithPostgres,
  insertEvents,
  type TestDatabase,
} from './support/test-db.js';

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => sqlState(e) ?? String(e),
  );

const outcome = (results: ProofResult[], name: string) =>
  results.find((r) => r.name === name)?.outcome;

/** Proofs need a transaction; this one is always rolled back. */
async function proofsNow(t: TestDatabase): Promise<ProofResult[]> {
  return t.db.withClient('owner', async (c) => {
    await c.query('BEGIN');
    try {
      return await runProofs(c);
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

describeWithPostgres('migrations against PostgreSQL 16', () => {
  let t: TestDatabase;
  let writer: pg.Client;
  let reader: pg.Client;
  let owner: pg.Client;
  const clients: pg.Client[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
  });

  afterAll(async () => {
    await Promise.allSettled(clients.map((c) => c.end()));
    await t.drop();
  });

  it('applies every migration once and all immutability proofs pass', async () => {
    const result = await t.migrate();
    expect(result.applied).toEqual(MIGRATIONS.map((m) => m.version));
    expect(result.proofs.filter((p) => p.outcome !== 'pass')).toEqual([]);
    expect(result.proofs).toHaveLength(16);

    const { rows } = await t.admin.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM audit_schema_migrations ORDER BY version',
    );
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, checksum: m.checksum })));

    writer = await t.connectAs('writer');
    reader = await t.connectAs('reader');
    owner = await t.connectAs('owner');
    clients.push(writer, reader, owner);
  });

  it('re-applying is a no-op that still proves the walls', async () => {
    const result = await t.migrate();
    expect(result.applied).toEqual([]);
    expect(result.proofs.every((p) => p.outcome === 'pass')).toBe(true);
  });

  it('rejects a migration whose checksum changed after it was applied', async () => {
    const version = MIGRATIONS[1]?.version ?? '';
    const original = MIGRATIONS[1]?.checksum ?? '';
    await t.admin.query('UPDATE audit_schema_migrations SET checksum = $1 WHERE version = $2', [
      '0'.repeat(64),
      version,
    ]);
    try {
      await expect(t.migrate()).rejects.toThrow(MigrationDriftError);
    } finally {
      await t.admin.query('UPDATE audit_schema_migrations SET checksum = $1 WHERE version = $2', [
        original,
        version,
      ]);
    }
  });

  it('sets role passwords from a SCRAM verifier (the plaintext never reaches the server)', async () => {
    const { rows } = await t.admin.query<{ rolname: string; scram: boolean }>(
      `SELECT rolname, rolpassword LIKE 'SCRAM-SHA-256$%' AS scram FROM pg_authid
       WHERE rolname IN ('audit_writer', 'audit_reader') ORDER BY rolname`,
    );
    expect(rows).toEqual([
      { rolname: 'audit_reader', scram: true },
      { rolname: 'audit_writer', scram: true },
    ]);
    expect((await reader.query('SELECT current_user AS u')).rows[0]).toEqual({ u: 'audit_reader' });
  });

  describe('the two walls', () => {
    beforeAll(async () => {
      await insertEvents(t.db, [{ occurredAt: '2024-01-01T00:00:00Z' }]);
    });

    it('GRANT wall: writer and reader get 42501 for every mutation', async () => {
      expect(await code(writer.query(`UPDATE audit_event SET comment = 'x'`))).toBe('42501');
      expect(await code(writer.query('DELETE FROM audit_event'))).toBe('42501');
      expect(await code(writer.query('TRUNCATE audit_event'))).toBe('42501');
      expect(await code(reader.query(`UPDATE audit_event SET comment = 'x'`))).toBe('42501');
      expect(await code(reader.query('DELETE FROM audit_event'))).toBe('42501');
      expect(
        await code(
          reader.query(
            `INSERT INTO audit_event (event_id, tenant_id, scope, entity_type, entity_id, entity_label, action,
                                      actor_id, actor_email, occurred_at)
             VALUES (gen_random_uuid(), 't', 'billing', 'x', 'x', 'x', 'x', 'x', 'x@example.test', now())`,
          ),
        ),
      ).toBe('42501');
    });

    it('trigger wall: even the owner gets 23001', async () => {
      expect(await code(owner.query(`UPDATE audit_event SET comment = 'x'`))).toBe('23001');
      expect(await code(owner.query('DELETE FROM audit_event'))).toBe('23001');
      expect(await code(owner.query('TRUNCATE audit_event'))).toBe('23001');
      await expect(owner.query('DELETE FROM audit_event')).rejects.toThrow(
        'audit_event is append-only',
      );
    });

    it('the GRANT wall holds on its own when the trigger is disabled', async () => {
      await owner.query('ALTER TABLE audit_event DISABLE TRIGGER audit_event_deny_update_delete');
      try {
        expect(await code(writer.query(`UPDATE audit_event SET comment = 'x'`))).toBe('42501');
      } finally {
        await owner.query('ALTER TABLE audit_event ENABLE TRIGGER audit_event_deny_update_delete');
      }
    });

    it('the trigger wall holds on its own when a grant leaks', async () => {
      await owner.query('GRANT UPDATE, DELETE ON audit_event TO audit_writer');
      try {
        expect(await code(writer.query(`UPDATE audit_event SET comment = 'x'`))).toBe('23001');
        expect(await code(writer.query('DELETE FROM audit_event'))).toBe('23001');
      } finally {
        await owner.query('REVOKE UPDATE, DELETE ON audit_event FROM audit_writer');
      }
    });

    it('PUBLIC cannot even connect', async () => {
      await t.admin.query(`DROP ROLE IF EXISTS audit_intruder`);
      await t.admin.query(`CREATE ROLE audit_intruder LOGIN PASSWORD 'intruder'`);
      try {
        const url = new URL(t.env['DATABASE_URL_READER'] ?? '');
        const intruder = new pg.Client({
          host: url.hostname,
          port: Number(url.port),
          database: t.name,
          user: 'audit_intruder',
          password: 'intruder',
        });
        expect(await code(intruder.connect())).toBe('42501');
        await intruder.end().catch(() => undefined);
      } finally {
        await t.admin.query('DROP ROLE audit_intruder');
      }
    });
  });

  describe('proofs fail when a wall is broken (negative controls)', () => {
    it('disabling the row trigger as owner fails the owner UPDATE/DELETE proofs', async () => {
      await owner.query('ALTER TABLE audit_event DISABLE TRIGGER audit_event_deny_update_delete');
      try {
        const results = await proofsNow(t);
        expect(outcome(results, 'owner_update_blocked')).toBe('fail');
        expect(outcome(results, 'owner_delete_blocked')).toBe('fail');
        expect(outcome(results, 'triggers_enabled')).toBe('fail');
        expect(outcome(results, 'owner_truncate_blocked')).toBe('pass');
        expect(outcome(results, 'writer_update_denied')).toBe('pass');
        await expect(t.migrate()).rejects.toThrow(ProofFailedError);
      } finally {
        await owner.query('ALTER TABLE audit_event ENABLE TRIGGER audit_event_deny_update_delete');
      }
      expect((await proofsNow(t)).every((r) => r.outcome === 'pass')).toBe(true);
    });

    it('a leaked grant fails the grant-wall and privilege proofs', async () => {
      await owner.query('GRANT UPDATE ON audit_event TO audit_reader');
      try {
        const results = await proofsNow(t);
        expect(outcome(results, 'reader_update_denied')).toBe('fail');
        expect(outcome(results, 'no_other_role_can_mutate')).toBe('fail');
      } finally {
        await owner.query('REVOKE UPDATE ON audit_event FROM audit_reader');
      }
    });

    it('a grant to PUBLIC fails public_holds_nothing', async () => {
      await owner.query('GRANT SELECT ON audit_event TO PUBLIC');
      try {
        expect(outcome(await proofsNow(t), 'public_holds_nothing')).toBe('fail');
      } finally {
        await owner.query('REVOKE SELECT ON audit_event FROM PUBLIC');
      }
    });

    it('a failed proof rolls the whole migration back', async () => {
      const bad = toMigrations([
        ...MIGRATIONS.map((m) => ({ file: `${m.version}.sql`, sql: m.sql })),
        { file: '0099_oops.sql', sql: 'GRANT UPDATE ON audit_event TO audit_writer;' },
      ]);
      await expect(
        t.db.withClient('owner', (c) => migrate(c, { migrations: bad })),
      ).rejects.toThrow(ProofFailedError);
      const { rowCount } = await t.admin.query(
        `SELECT 1 FROM audit_schema_migrations WHERE version = '0099_oops'`,
      );
      expect(rowCount).toBe(0);
      expect(await code(writer.query(`UPDATE audit_event SET comment = 'x'`))).toBe('42501');
    });
  });

  describe('indexes on a populated table', () => {
    const schemaSql = MIGRATIONS[0]?.sql ?? '';

    it('warns (does not build) when a read-path index is missing', async () => {
      const notices: string[] = [];
      const onNotice = (n: { message?: string }) => notices.push(n.message ?? '');
      owner.on('notice', onNotice);
      try {
        await owner.query('BEGIN');
        await owner.query('DROP INDEX ix_audit_event_time');
        await owner.query(schemaSql);
        const { rowCount } = await owner.query(
          `SELECT 1 FROM pg_class WHERE relname = 'ix_audit_event_time'`,
        );
        expect(rowCount).toBe(0);
      } finally {
        await owner.query('ROLLBACK');
        owner.off('notice', onNotice);
      }
      expect(
        notices.some((n) => n.includes('ix_audit_event_time') && n.includes('CONCURRENTLY')),
      ).toBe(true);
    });

    it('raises when the event_id unique index is missing', async () => {
      await owner.query('BEGIN');
      try {
        await owner.query('DROP INDEX ux_audit_event_event_id');
        expect(await code(owner.query(schemaSql))).toBe('55000');
      } finally {
        await owner.query('ROLLBACK');
      }
    });
  });
});
