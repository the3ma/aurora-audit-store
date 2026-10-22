import type { Cursor } from './cursor.js';
import type { Scope } from './types.js';

export interface EventFilter {
  tenantId: string;
  scope?: Scope;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  actorEmailPrefix?: string;
  action?: string;
  projectId?: string;
  /** inclusive, ISO-8601 */
  from?: string;
  /** exclusive, ISO-8601 */
  to?: string;
  /** substring of entity_label, case-insensitive */
  q?: string;
}

export interface SqlQuery {
  text: string;
  values: unknown[];
}

const isoUtc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Timestamps leave the database as text with microseconds. A JS Date would truncate to milliseconds,
 * and a cursor built from a truncated value skips or repeats rows that share the millisecond.
 */
export const EVENT_COLUMNS = [
  'event_row_id::text AS event_row_id',
  'event_id::text AS event_id',
  'tenant_id',
  'project_id',
  'scope::text AS scope',
  'entity_type',
  'entity_id',
  'entity_label',
  'action',
  'actor_id',
  'actor_email',
  `${isoUtc('occurred_at')} AS occurred_at`,
  'changes',
  'comment',
  'source',
  `${isoUtc('recorded_at')} AS recorded_at`,
].join(', ');

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${String(this.values.length)}`;
  }
}

/** Every predicate is a bound parameter; column names and operators are fixed strings. */
function whereClause(filter: EventFilter, params: Params): string[] {
  const where = [`tenant_id = ${params.add(filter.tenantId)}`];
  if (filter.scope !== undefined) where.push(`scope = ${params.add(filter.scope)}::audit_scope`);
  if (filter.entityType !== undefined) where.push(`entity_type = ${params.add(filter.entityType)}`);
  if (filter.entityId !== undefined) where.push(`entity_id = ${params.add(filter.entityId)}`);
  if (filter.actorId !== undefined) where.push(`actor_id = ${params.add(filter.actorId)}`);
  if (filter.actorEmailPrefix !== undefined) {
    where.push(`actor_email ILIKE ${params.add(`${escapeLike(filter.actorEmailPrefix)}%`)}`);
  }
  if (filter.action !== undefined) where.push(`action = ${params.add(filter.action)}`);
  if (filter.projectId !== undefined) where.push(`project_id = ${params.add(filter.projectId)}`);
  if (filter.from !== undefined) {
    where.push(`occurred_at >= ${params.add(filter.from)}::timestamptz`);
  }
  if (filter.to !== undefined) where.push(`occurred_at < ${params.add(filter.to)}::timestamptz`);
  if (filter.q !== undefined) {
    where.push(`entity_label ILIKE ${params.add(`%${escapeLike(filter.q)}%`)}`);
  }
  return where;
}

/**
 * Newest first, keyset paged. All filters are in the WHERE clause, ahead of LIMIT - the legacy store
 * applied them after fetching a page and so returned short or empty pages. Fetches `limit + 1` rows so
 * the caller knows whether another page exists without a second query.
 */
export function buildListQuery(
  filter: EventFilter,
  page: { limit: number; cursor?: Cursor },
): SqlQuery {
  if (!Number.isInteger(page.limit) || page.limit < 1) throw new RangeError('limit must be >= 1');
  const params = new Params();
  const where = whereClause(filter, params);
  if (page.cursor) {
    where.push(
      `(occurred_at, event_row_id) < (${params.add(page.cursor.occurredAt)}::timestamptz, ${params.add(page.cursor.eventRowId)}::bigint)`,
    );
  }
  const limit = params.add(page.limit + 1);
  return {
    text: `SELECT ${EVENT_COLUMNS} FROM audit_event WHERE ${where.join(' AND ')} ORDER BY occurred_at DESC, event_row_id DESC LIMIT ${limit}`,
    values: params.values,
  };
}

export function buildCountQuery(filter: EventFilter): SqlQuery {
  const params = new Params();
  const where = whereClause(filter, params);
  return {
    text: `SELECT count(*)::bigint AS count FROM audit_event WHERE ${where.join(' AND ')}`,
    values: params.values,
  };
}

const INSERT_COLUMNS = [
  'event_id',
  'tenant_id',
  'project_id',
  'scope',
  'entity_type',
  'entity_id',
  'entity_label',
  'action',
  'actor_id',
  'actor_email',
  'occurred_at',
  'changes',
  'comment',
  'source',
] as const;

/**
 * Batch insert with one jsonb parameter instead of rows x columns placeholders: the statement text is
 * constant (plan-cacheable, no 65535-parameter ceiling) and values are never spliced into SQL.
 * RETURNING only reports rows actually inserted, so `batch - returned` is the already-present count -
 * including duplicates inside the same batch, which DO NOTHING also skips.
 */
export const INSERT_EVENTS_SQL = `
INSERT INTO audit_event (${INSERT_COLUMNS.join(', ')})
SELECT r.event_id, r.tenant_id, r.project_id, r.scope, r.entity_type, r.entity_id, r.entity_label,
       r.action, r.actor_id, r.actor_email, r.occurred_at, r.changes, r.comment, r.source
FROM jsonb_to_recordset($1::jsonb) AS r (
  event_id uuid, tenant_id text, project_id text, scope audit_scope, entity_type text, entity_id text,
  entity_label text, action text, actor_id text, actor_email text, occurred_at timestamptz,
  changes jsonb, comment text, source text
)
ON CONFLICT (event_id) DO NOTHING
RETURNING event_id::text AS event_id`;

export const INSERT_ONE_EVENT_SQL = `
INSERT INTO audit_event (${INSERT_COLUMNS.join(', ')})
VALUES ($1::uuid, $2, $3, $4::audit_scope, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::jsonb, $13, 'live')
ON CONFLICT (event_id) DO NOTHING
RETURNING ${EVENT_COLUMNS}`;

export const SELECT_EVENT_BY_ID_SQL = `SELECT ${EVENT_COLUMNS} FROM audit_event WHERE event_id = $1::uuid AND tenant_id = $2`;
