import { unmarshall } from '@aws-sdk/util-dynamodb';
import { isScope, type FieldChange, type NewAuditEvent, type Scope } from './types.js';
import { isUuid, uuidV5 } from './uuid.js';

/**
 * Namespace for ids derived from legacy items that never had an EventId. Changing it would make a
 * re-run insert every such item a second time, so it is a constant, not configuration.
 */
export const LEGACY_EVENT_ID_NAMESPACE = '8b0f6a3e-5c1d-4e7a-9f2b-3d4c5e6f7a80';

/** Attribute shape of the old single-table design (see docs/CONTRACT.md section 6). */
export interface LegacyItem {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
  GSI2PK?: string;
  GSI3PK?: string;
  GSI4PK?: string;
  EventId?: string;
  TenantId?: string;
  ProjectId?: string;
  Scope?: string;
  EntityType?: string;
  EntityId?: string;
  EntityLabel?: string;
  Action?: string;
  ActorId?: string;
  ActorEmail?: string;
  OccurredAt?: string;
  Comment?: string;
  Changes?: string;
  ExpiresAt?: number;
}

export const REJECT_REASONS = [
  'invalid_scope',
  'invalid_date',
  'invalid_changes',
  'invalid_event_id',
  'missing_field',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export type MapResult =
  | { ok: true; event: NewAuditEvent; derivedEventId: boolean }
  | { ok: false; reason: RejectReason; detail: string };

const REQUIRED_TEXT = [
  'TenantId',
  'EntityType',
  'EntityId',
  'EntityLabel',
  'Action',
  'ActorId',
  'ActorEmail',
] as const;

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Strict ISO-8601 instant. `Date.parse` alone accepts "2024-02-30" (rolls over to March) and
 * offset-less strings (interpreted in local time); both are rejected here rather than guessed at.
 */
export function parseIsoInstant(value: string): Date | undefined {
  const m = ISO_INSTANT.exec(value);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return undefined;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > daysInMonth) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseChanges(raw: unknown): FieldChange[] | undefined {
  if (raw === undefined) return [];
  if (typeof raw !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const changes: FieldChange[] = [];
  for (const entry of parsed as unknown[]) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const field = (entry as Record<string, unknown>)['field'];
    if (typeof field !== 'string' || field.length === 0) return undefined;
    changes.push(entry as FieldChange);
  }
  return changes;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Legacy item -> row. Rejects instead of coercing: a record we cannot represent faithfully is
 * reported with its reason, never "fixed" on the way in.
 */
export function mapLegacyItem(item: LegacyItem): MapResult {
  const record = item as unknown as Record<string, unknown>;
  for (const key of ['PK', 'SK', ...REQUIRED_TEXT] as const) {
    const v = record[key];
    if (typeof v !== 'string' || v.length === 0) {
      return { ok: false, reason: 'missing_field', detail: `${key} is missing or empty` };
    }
  }

  let eventId: string;
  let derivedEventId = false;
  if (item.EventId === undefined) {
    eventId = uuidV5(JSON.stringify([item.PK, item.SK]), LEGACY_EVENT_ID_NAMESPACE);
    derivedEventId = true;
  } else if (typeof item.EventId === 'string' && isUuid(item.EventId)) {
    eventId = item.EventId.toLowerCase();
  } else {
    return { ok: false, reason: 'invalid_event_id', detail: 'EventId is present but not a UUID' };
  }

  const scope = typeof item.Scope === 'string' ? item.Scope.trim().toLowerCase() : '';
  if (!isScope(scope)) {
    return {
      ok: false,
      reason: 'invalid_scope',
      detail: `Scope ${JSON.stringify(item.Scope)} is not a known scope`,
    };
  }

  const occurredAt =
    typeof item.OccurredAt === 'string' ? parseIsoInstant(item.OccurredAt) : undefined;
  if (!occurredAt) {
    return { ok: false, reason: 'invalid_date', detail: 'OccurredAt is not an ISO-8601 instant' };
  }

  const changes = parseChanges(item.Changes);
  if (!changes) {
    return {
      ok: false,
      reason: 'invalid_changes',
      detail: 'Changes is not a JSON array of {"field",...} objects',
    };
  }

  return {
    ok: true,
    derivedEventId,
    event: {
      eventId,
      tenantId: item.TenantId as string,
      projectId: optionalText(item.ProjectId),
      scope: scope satisfies Scope,
      entityType: item.EntityType as string,
      entityId: item.EntityId as string,
      entityLabel: item.EntityLabel as string,
      action: item.Action as string,
      actorId: item.ActorId as string,
      actorEmail: item.ActorEmail as string,
      occurredAt: occurredAt.toISOString(),
      changes,
      comment: optionalText(item.Comment),
    },
  };
}

/**
 * One line of a DynamoDB export data file: `{"Item":{"PK":{"S":"..."},...}}`. Returns undefined for
 * blank lines; throws on anything that is not an export record (a corrupt file is a hard failure, not
 * a per-item reject).
 */
export function parseExportLine(line: string): LegacyItem | undefined {
  if (line.trim().length === 0) return undefined;
  const parsed = JSON.parse(line) as unknown;
  if (parsed === null || typeof parsed !== 'object' || !('Item' in parsed)) {
    throw new Error('export line is not a {"Item":{...}} record');
  }
  const item = unmarshall((parsed as { Item: Parameters<typeof unmarshall>[0] }).Item, {
    wrapNumbers: false,
  }) as Record<string, unknown>;
  if (typeof item['PK'] !== 'string' || typeof item['SK'] !== 'string') {
    throw new Error('export record has no string PK/SK');
  }
  return item as unknown as LegacyItem;
}
