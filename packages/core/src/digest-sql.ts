/**
 * Tamper-evidence hashing, done in the database so the rows never have to leave it.
 *
 *   rows_hash  = sha256( to_jsonb(row)::text for each row in the range, ordered by event_row_id,
 *                        joined with '\n', UTF-8 )
 *   block_hash = sha256( decode(prev_hash, 'hex') || rows_hash )            -- raw bytes, not hex text
 *
 * to_jsonb renders timestamptz in the session TimeZone, so callers MUST run these inside a transaction
 * that has done `SET LOCAL TimeZone = 'UTC'` (see DIGEST_SESSION_SQL); otherwise two sessions in
 * different zones would hash the same rows differently.
 */
export const DIGEST_SESSION_SQL = [
  'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  `SET LOCAL TimeZone = 'UTC'`,
] as const;

export const GENESIS_HASH = '0'.repeat(64);

/** $1 = from row id (inclusive), $2 = to row id (inclusive), $3 = previous block hash (hex). */
export const HASH_RANGE_SQL = `
SELECT count(*)::bigint AS rows,
       encode(
         sha256(decode($3::text, 'hex') || sha256(convert_to(
           coalesce(string_agg(to_jsonb(e)::text, E'\\n' ORDER BY e.event_row_id), ''), 'UTF8'))),
         'hex') AS hash
FROM audit_event e
WHERE e.event_row_id BETWEEN $1::bigint AND $2::bigint`;

/**
 * Highest row id recorded before the cutoff and not yet sealed. Bounded by the PK range above the last
 * sealed id, so the daily run never scans history.
 * $1 = last sealed row id (0 if none), $2 = cutoff (start of the current UTC day).
 */
export const SEALABLE_UPPER_BOUND_SQL = `
SELECT max(event_row_id)::text AS to_row_id
FROM audit_event
WHERE event_row_id > $1::bigint AND recorded_at < $2::timestamptz`;
