export const SCOPES = ['accounts', 'billing', 'catalog', 'orders', 'settings', 'security'] as const;
export type Scope = (typeof SCOPES)[number];

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

export const EVENT_SOURCES = ['live', 'backfill'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export interface FieldChange {
  field: string;
  old?: unknown;
  new?: unknown;
}

/** What a writer supplies. Row id, source and recorded_at are assigned by the store. */
export interface NewAuditEvent {
  eventId: string;
  tenantId: string;
  projectId: string | null;
  scope: Scope;
  entityType: string;
  entityId: string;
  entityLabel: string;
  action: string;
  actorId: string;
  actorEmail: string;
  occurredAt: string;
  changes: FieldChange[];
  comment: string | null;
}

/** A stored row as returned by the API (snake_case, timestamps as ISO-8601 with microseconds). */
export interface AuditEventRow {
  event_row_id: string;
  event_id: string;
  tenant_id: string;
  project_id: string | null;
  scope: Scope;
  entity_type: string;
  entity_id: string;
  entity_label: string;
  action: string;
  actor_id: string;
  actor_email: string;
  occurred_at: string;
  changes: FieldChange[];
  comment: string | null;
  source: EventSource;
  recorded_at: string;
}

export const FACETS = ['scope', 'entity_type', 'action', 'actor_email'] as const;
export type Facet = (typeof FACETS)[number];
