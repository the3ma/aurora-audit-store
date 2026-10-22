/**
 * Keyset cursor: base64url of `<occurred_at>,<event_row_id>`. It is opaque to clients but not secret -
 * the tenant predicate is always applied server side, so a forged cursor can only move within the
 * caller's own tenant. Decoding is strict so that a tampered or truncated cursor is a 400, never a
 * silently different page.
 */
export interface Cursor {
  /** ISO-8601 UTC with up to microsecond precision, exactly as PostgreSQL stores it. */
  occurredAt: string;
  /** bigint as decimal string. */
  eventRowId: string;
}

const PAYLOAD = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z),([1-9]\d{0,18})$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_BIGINT = 9223372036854775807n;

export class InvalidCursorError extends Error {
  override readonly name = 'InvalidCursorError';
}

export function encodeCursor(cursor: Cursor): string {
  const payload = `${cursor.occurredAt},${cursor.eventRowId}`;
  if (!PAYLOAD.test(payload)) throw new InvalidCursorError('cursor fields are malformed');
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(token: string): Cursor {
  if (token.length === 0 || token.length > 128 || !BASE64URL.test(token)) {
    throw new InvalidCursorError('cursor is not base64url');
  }
  const payload = Buffer.from(token, 'base64url').toString('utf8');
  const m = PAYLOAD.exec(payload);
  if (!m) throw new InvalidCursorError('cursor payload is malformed');
  const [, occurredAt, eventRowId] = m as unknown as [string, string, string];
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new InvalidCursorError('cursor timestamp is invalid');
  }
  if (BigInt(eventRowId) > MAX_BIGINT) {
    throw new InvalidCursorError('cursor row id is out of range');
  }
  // Node's base64url decoder ignores trailing garbage bits; a non-canonical encoding means the token
  // was not produced by us.
  if (encodeCursor({ occurredAt, eventRowId }) !== token) {
    throw new InvalidCursorError('cursor is not canonical');
  }
  return { occurredAt, eventRowId };
}
