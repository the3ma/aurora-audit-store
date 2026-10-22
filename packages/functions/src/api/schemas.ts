import {
  decodeCursor,
  InvalidCursorError,
  SCOPES,
  type Cursor,
  type EventFilter,
} from '@audit/core';
import { z } from 'zod';
import { HttpError } from './http-error.js';

const text = (max = 200) => z.string().min(1).max(max);
const instant = z.iso.datetime({ offset: true });

const filterShape = {
  scope: z.enum(SCOPES).optional(),
  entity_type: text().optional(),
  entity_id: text().optional(),
  actor_id: text().optional(),
  actor_email_prefix: text(320).optional(),
  action: text(64).optional(),
  project_id: text().optional(),
  from: instant.optional(),
  to: instant.optional(),
  q: z.string().trim().min(3).max(200).optional(),
};

const fromBeforeTo = (v: { from?: string | undefined; to?: string | undefined }) =>
  v.from === undefined || v.to === undefined || Date.parse(v.from) < Date.parse(v.to);

// strictObject: an unknown or misspelt filter (`?actor=` for `?actor_id=`) is a 400, not a silently
// unfiltered result - and `tenant_id` can never arrive through the query string.
export const countQuerySchema = z
  .strictObject(filterShape)
  .refine(fromBeforeTo, { message: 'from must be before to', path: ['from'] });

export const listQuerySchema = z
  .strictObject({
    ...filterShape,
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(128).optional(),
  })
  .refine(fromBeforeTo, { message: 'from must be before to', path: ['from'] });

export const dailyStatsQuerySchema = z
  .strictObject({ from: z.iso.date(), to: z.iso.date() })
  .refine((v) => v.from <= v.to, { message: 'from must not be after to', path: ['from'] })
  .refine((v) => Date.parse(v.to) - Date.parse(v.from) <= 366 * 86_400_000, {
    message: 'range must not exceed 366 days',
    path: ['to'],
  });

export const newEventSchema = z.strictObject({
  event_id: z.uuid(),
  project_id: text().nullable().optional(),
  scope: z.enum(SCOPES),
  entity_type: text(),
  entity_id: text(),
  entity_label: text(500),
  action: text(64),
  actor_id: text(),
  actor_email: z.email().max(320),
  occurred_at: instant,
  changes: z
    .array(z.looseObject({ field: text() }))
    .max(500)
    .default([]),
  comment: z.string().max(2000).nullable().optional(),
});
export type NewEventBody = z.infer<typeof newEventSchema>;

export function validate<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  throw new HttpError(400, 'invalid_request', `${where}${issue?.message ?? 'invalid request'}`);
}

/** Repeated query parameters are ambiguous (`?scope=a&scope=b`), so they are rejected outright. */
export function singleValuedQuery(queries: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, values] of Object.entries(queries)) {
    if (values.length !== 1 || values[0] === undefined) {
      throw new HttpError(400, 'invalid_request', `${key}: must be given exactly once`);
    }
    out[key] = values[0];
  }
  return out;
}

export function toFilter(tenantId: string, q: z.infer<typeof countQuerySchema>): EventFilter {
  return {
    tenantId,
    scope: q.scope,
    entityType: q.entity_type,
    entityId: q.entity_id,
    actorId: q.actor_id,
    actorEmailPrefix: q.actor_email_prefix,
    action: q.action,
    projectId: q.project_id,
    from: q.from,
    to: q.to,
    q: q.q,
  };
}

export function parseCursor(token: string | undefined): Cursor | undefined {
  if (token === undefined) return undefined;
  try {
    return decodeCursor(token);
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw new HttpError(400, 'invalid_cursor', error.message);
    }
    throw error;
  }
}
