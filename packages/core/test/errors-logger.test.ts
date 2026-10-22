import { describe, expect, it } from 'vitest';
import { createLogger, describeError, scrubLiterals } from '../src/index.js';

describe('scrubLiterals', () => {
  it.each([
    [`syntax error at or near "'hunter2'"`, `syntax error at or near "'***'"`],
    [`invalid value 'it''s secret' for x`, `invalid value '***' for x`],
    [`near E'a\\'b' here`, `near '***' here`],
    [`unterminated 'SCRAM-SHA-256$4096:abc`, `unterminated '***'`],
    [`relation "audit_event" does not exist`, `relation "audit_event" does not exist`],
  ])('%s', (input, expected) => {
    expect(scrubLiterals(input)).toBe(expected);
  });
});

describe('describeError', () => {
  it('keeps code and constraint but drops detail and statement text', () => {
    const error = Object.assign(new Error(`password 'p@ss' rejected`), {
      code: '42601',
      constraint: 'c1',
      detail: 'Key (event_id)=(abc) already exists.',
      query: `ALTER ROLE x PASSWORD 'p@ss'`,
    });
    const description = describeError(error);
    expect(description).toEqual({
      name: 'Error',
      message: `password '***' rejected`,
      code: '42601',
      constraint: 'c1',
    });
    expect(JSON.stringify(description)).not.toContain('p@ss');
    expect(JSON.stringify(description)).not.toContain('abc');
  });

  it('handles non-errors', () => {
    expect(describeError(`'x'`)).toEqual({ name: 'NonError', message: `'***'` });
  });
});

describe('logger', () => {
  it('writes JSON lines, filters by level and redacts sensitive keys', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      sink: (l) => lines.push(l),
      clock: () => new Date('2026-01-01T00:00:00Z'),
      base: { fn: 'test' },
    });
    logger.debug('hidden');
    logger.info('hello', { password: 'p', nested: { apiToken: 't', ok: 1 }, n: 10n });
    logger.child({ requestId: 'r-1' }).error('boom', { error: new Error(`bad 'secret'`) });

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      level: 'info',
      time: '2026-01-01T00:00:00.000Z',
      msg: 'hello',
      fn: 'test',
      password: '[redacted]',
      nested: { apiToken: '[redacted]', ok: 1 },
      n: '10',
    });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({
      level: 'error',
      requestId: 'r-1',
      error: { name: 'Error', message: `bad '***'` },
    });
  });
});
