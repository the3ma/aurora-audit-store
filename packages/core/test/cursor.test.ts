import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, InvalidCursorError } from '../src/index.js';

const cursor = { occurredAt: '2024-03-01T10:15:30.123456Z', eventRowId: '9001' };
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('cursor', () => {
  it('round-trips with microsecond precision', () => {
    const token = encodeCursor(cursor);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(token)).toEqual(cursor);
  });

  it('round-trips the largest bigint row id', () => {
    const big = { ...cursor, eventRowId: '9223372036854775807' };
    expect(decodeCursor(encodeCursor(big))).toEqual(big);
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'abc+/='],
    ['padding', `${b64('2024-03-01T10:15:30Z,1')}==`],
    ['missing row id', b64('2024-03-01T10:15:30Z')],
    ['row id zero', b64('2024-03-01T10:15:30Z,0')],
    ['negative row id', b64('2024-03-01T10:15:30Z,-5')],
    ['row id beyond bigint', b64('2024-03-01T10:15:30Z,9223372036854775808')],
    ['SQL in payload', b64('2024-03-01T10:15:30Z,1;DROP TABLE audit_event')],
    ['local time', b64('2024-03-01T10:15:30,1')],
    ['impossible date', b64('2024-13-45T10:15:30Z,1')],
    ['extra field', b64('2024-03-01T10:15:30Z,1,2')],
    ['too long', 'A'.repeat(200)],
  ])('rejects a tampered cursor: %s', (_name, token) => {
    expect(() => decodeCursor(token)).toThrow(InvalidCursorError);
  });

  it('rejects a cursor with a flipped character', () => {
    const token = encodeCursor(cursor);
    const flipped = `${token.slice(0, 5)}${token[5] === 'A' ? 'B' : 'A'}${token.slice(6)}`;
    expect(() => decodeCursor(flipped)).toThrow(InvalidCursorError);
  });

  it('refuses to encode malformed fields', () => {
    expect(() => encodeCursor({ occurredAt: 'now', eventRowId: '1' })).toThrow(InvalidCursorError);
  });
});
