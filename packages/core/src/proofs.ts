import type pg from 'pg';
import { describeError, SqlState, sqlState } from './errors.js';

export type ProofOutcome = 'pass' | 'fail' | 'inconclusive';

export interface ProofResult {
  name: string;
  outcome: ProofOutcome;
  detail: string;
}

type Queryable = Pick<pg.ClientBase, 'query'>;

const PROBE_ROLE = { writer: 'audit_writer', reader: 'audit_reader' } as const;

/** A syntactically complete row; overrides let the CHECK proofs vary exactly one column. */
function probeInsert(overrides: { changes?: string; source?: string } = {}) {
  return {
    text: `INSERT INTO audit_event (event_id, tenant_id, scope, entity_type, entity_id, entity_label,
                                    action, actor_id, actor_email, occurred_at, changes, source)
           VALUES (gen_random_uuid(), '__proof__', 'security', 'proof', 'proof', 'immutability proof',
                   'proof', 'proof', 'proof@example.test', now(), $1::jsonb, $2)
           RETURNING event_row_id::text AS id, event_id::text AS event_id`,
    values: [overrides.changes ?? '[]', overrides.source ?? 'live'],
  };
}

interface Probe {
  id: string;
  eventId: string;
}

async function insertProbe(client: Queryable): Promise<Probe> {
  const { text, values } = probeInsert();
  const { rows } = await client.query<{ id: string; event_id: string }>(text, values);
  const row = rows[0];
  if (!row) throw new Error('probe insert returned no row');
  return { id: row.id, eventId: row.event_id };
}

/**
 * Runs `attempt` and classifies the outcome: the expected SQLSTATE is a pass; any other error, or the
 * statement succeeding and touching rows, is a fail; succeeding without touching anything proves
 * nothing and is inconclusive (never counted as a pass).
 */
async function expectError(
  name: string,
  expected: string,
  attempt: () => Promise<pg.QueryResult>,
): Promise<ProofResult> {
  try {
    const result = await attempt();
    const touched = result.rowCount ?? 0;
    return touched > 0 || result.command === 'TRUNCATE'
      ? { name, outcome: 'fail', detail: `succeeded (${result.command}, ${String(touched)} rows)` }
      : { name, outcome: 'inconclusive', detail: 'succeeded without touching a row' };
  } catch (error) {
    const code = sqlState(error);
    return code === expected
      ? { name, outcome: 'pass', detail: `rejected with ${expected}` }
      : {
          name,
          outcome: 'fail',
          detail: `expected ${expected}, got ${code ?? 'no SQLSTATE'}: ${describeError(error).message}`,
        };
  }
}

/**
 * Each proof runs inside its own SAVEPOINT and is rolled back, so probes leave no rows behind (only
 * identity gaps, which are expected). The caller must already be in a transaction; migrate runs the
 * proofs inside the migration transaction, so a failed proof also rolls the schema change back.
 */
async function inSavepoint(
  client: Queryable,
  name: string,
  body: () => Promise<ProofResult>,
): Promise<ProofResult> {
  await client.query('SAVEPOINT audit_proof');
  try {
    return await body();
  } catch (error) {
    return {
      name,
      outcome: 'inconclusive',
      detail: `proof errored: ${describeError(error).message}`,
    };
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT audit_proof');
    await client.query('RELEASE SAVEPOINT audit_proof');
  }
}

function mutationProof(
  client: Queryable,
  name: string,
  as: 'writer' | 'reader' | 'owner',
  statement: (probe: Probe) => { text: string; values?: unknown[] },
  expected: string,
): () => Promise<ProofResult> {
  return () =>
    inSavepoint(client, name, async () => {
      const probe = await insertProbe(client);
      if (as !== 'owner') await client.query(`SET LOCAL ROLE ${PROBE_ROLE[as]}`);
      const { text, values } = statement(probe);
      return expectError(name, expected, () => client.query(text, values));
    });
}

function catalogProof(
  client: Queryable,
  name: string,
  check: () => Promise<{ ok: boolean; detail: string }>,
): () => Promise<ProofResult> {
  return () =>
    inSavepoint(client, name, async () => {
      const { ok, detail } = await check();
      return { name, outcome: ok ? 'pass' : 'fail', detail };
    });
}

function checkProof(
  client: Queryable,
  name: string,
  overrides: { changes?: string; source?: string },
): () => Promise<ProofResult> {
  return () =>
    inSavepoint(client, name, () => {
      const { text, values } = probeInsert(overrides);
      return expectError(name, SqlState.checkViolation, () => client.query(text, values));
    });
}

export async function runProofs(client: Queryable): Promise<ProofResult[]> {
  const update = (p: Probe) => ({
    text: `UPDATE audit_event SET comment = 'tampered' WHERE event_row_id = $1`,
    values: [p.id],
  });
  const del = (p: Probe) => ({
    text: `DELETE FROM audit_event WHERE event_row_id = $1`,
    values: [p.id],
  });
  const truncate = () => ({ text: 'TRUNCATE audit_event' });
  const insert = () => probeInsert();

  const proofs: (() => Promise<ProofResult>)[] = [
    mutationProof(client, 'writer_update_denied', 'writer', update, SqlState.insufficientPrivilege),
    mutationProof(client, 'writer_delete_denied', 'writer', del, SqlState.insufficientPrivilege),
    mutationProof(
      client,
      'writer_truncate_denied',
      'writer',
      truncate,
      SqlState.insufficientPrivilege,
    ),
    mutationProof(client, 'reader_insert_denied', 'reader', insert, SqlState.insufficientPrivilege),
    mutationProof(client, 'reader_update_denied', 'reader', update, SqlState.insufficientPrivilege),
    mutationProof(client, 'reader_delete_denied', 'reader', del, SqlState.insufficientPrivilege),
    mutationProof(client, 'owner_update_blocked', 'owner', update, SqlState.restrictViolation),
    mutationProof(client, 'owner_delete_blocked', 'owner', del, SqlState.restrictViolation),
    mutationProof(client, 'owner_truncate_blocked', 'owner', truncate, SqlState.restrictViolation),

    catalogProof(client, 'triggers_enabled', async () => {
      const { rows } = await client.query<{ tgname: string; tgenabled: string }>(
        `SELECT tgname, tgenabled FROM pg_trigger
         WHERE tgrelid = 'public.audit_event'::regclass
           AND tgname IN ('audit_event_deny_update_delete', 'audit_event_deny_truncate')`,
      );
      const enabled = rows.filter((r) => r.tgenabled === 'O').map((r) => r.tgname);
      return { ok: enabled.length === 2, detail: `enabled: [${enabled.join(', ')}] of 2` };
    }),

    catalogProof(client, 'no_other_role_can_mutate', async () => {
      // Explicit ACL entries plus membership in the owner role (which would inherit ownership).
      const { rows } = await client.query<{ grantee: string; privilege: string }>(
        `SELECT coalesce(r.rolname, 'PUBLIC') AS grantee, a.privilege_type AS privilege
         FROM pg_class c
         CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
         LEFT JOIN pg_roles r ON r.oid = a.grantee
         WHERE c.oid = 'public.audit_event'::regclass
           AND a.grantee <> c.relowner
           AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER')
         UNION ALL
         SELECT m.rolname, 'MEMBER OF OWNER'
         FROM pg_class c
         JOIN pg_auth_members am ON am.roleid = c.relowner
         JOIN pg_roles m ON m.oid = am.member
         WHERE c.oid = 'public.audit_event'::regclass AND am.inherit_option`,
      );
      return {
        ok: rows.length === 0,
        detail:
          rows.length === 0 ? 'none' : rows.map((r) => `${r.grantee}:${r.privilege}`).join(', '),
      };
    }),

    catalogProof(client, 'public_holds_nothing', async () => {
      const { rows } = await client.query<{ object: string; privilege: string }>(
        `SELECT c.relname AS object, a.privilege_type AS privilege
         FROM pg_class c
         CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
         WHERE c.relnamespace = 'public'::regnamespace
           AND c.relname IN ('audit_event', 'mv_audit_facets', 'mv_audit_daily_counts')
           AND a.grantee = 0
         UNION ALL
         SELECT 'schema public', a.privilege_type
         FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
         WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE'
         UNION ALL
         SELECT 'database', a.privilege_type
         FROM pg_database d
         CROSS JOIN LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
         WHERE d.datname = current_database() AND a.grantee = 0
         UNION ALL
         SELECT p.proname, a.privilege_type
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('refresh_audit_views', 'audit_event_deny_mutation')
           AND a.grantee = 0`,
      );
      return {
        ok: rows.length === 0,
        detail:
          rows.length === 0 ? 'none' : rows.map((r) => `${r.object}:${r.privilege}`).join(', '),
      };
    }),

    catalogProof(client, 'event_id_unique_index_valid', async () => {
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT i.indisunique AND i.indisvalid AND i.indisready AS ok
         FROM pg_index i
         WHERE i.indexrelid = to_regclass('public.ux_audit_event_event_id')`,
      );
      const ok = rows[0]?.ok === true;
      return { ok, detail: ok ? 'unique, valid, ready' : 'missing or not valid' };
    }),

    checkProof(client, 'changes_must_be_array', { changes: '{"field":"x"}' }),
    checkProof(client, 'source_must_be_known', { source: 'imported' }),

    () =>
      inSavepoint(client, 'duplicate_event_id_is_noop', async () => {
        const probe = await insertProbe(client);
        const result = await client.query(
          `INSERT INTO audit_event (event_id, tenant_id, scope, entity_type, entity_id, entity_label,
                                    action, actor_id, actor_email, occurred_at)
           VALUES ($1::uuid, '__proof__', 'security', 'proof', 'proof', 'duplicate', 'proof', 'proof',
                   'proof@example.test', now())
           ON CONFLICT (event_id) DO NOTHING`,
          [probe.eventId],
        );
        const inserted = result.rowCount ?? -1;
        return {
          name: 'duplicate_event_id_is_noop',
          outcome: inserted === 0 ? 'pass' : 'fail',
          detail: `inserted ${String(inserted)} rows`,
        };
      }),
  ];

  const results: ProofResult[] = [];
  // Sequential on purpose: every proof shares the same connection and savepoint name.
  for (const proof of proofs) results.push(await proof());
  return results;
}

export function summarizeProofs(results: readonly ProofResult[]): {
  passed: number;
  total: number;
} {
  return { passed: results.filter((r) => r.outcome === 'pass').length, total: results.length };
}
