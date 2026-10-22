import { describe, expect, it } from 'vitest';
import { buildCountQuery, buildListQuery, escapeLike, type EventFilter } from '../src/index.js';

const hostile = "x' OR '1'='1";
const everything: EventFilter = {
  tenantId: 't-042',
  scope: 'billing',
  entityType: hostile,
  entityId: hostile,
  actorId: hostile,
  actorEmailPrefix: 'user_1%',
  action: hostile,
  projectId: hostile,
  from: '2024-01-01T00:00:00Z',
  to: '2025-01-01T00:00:00Z',
  q: hostile,
};

describe('buildListQuery', () => {
  it('binds every value and never splices it into the SQL text', () => {
    const { text, values } = buildListQuery(everything, {
      limit: 50,
      cursor: { occurredAt: '2024-06-01T00:00:00.000001Z', eventRowId: '77' },
    });
    expect(text).not.toContain(hostile);
    expect(text).not.toContain('t-042');
    expect(text).not.toContain('77');
    const placeholders = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    expect(new Set(placeholders).size).toBe(values.length);
    expect(Math.max(...placeholders)).toBe(values.length);
  });

  it('always scopes to the tenant as the first predicate', () => {
    const { text, values } = buildListQuery({ tenantId: 't-001' }, { limit: 10 });
    expect(text).toMatch(/WHERE tenant_id = \$1 ORDER BY/);
    expect(values).toEqual(['t-001', 11]);
  });

  it('puts every predicate before ORDER BY and LIMIT, with a fixed sort', () => {
    const { text } = buildListQuery(everything, { limit: 5 });
    const where = text.indexOf(' WHERE ');
    const order = text.indexOf(' ORDER BY ');
    const limit = text.indexOf(' LIMIT ');
    expect(where).toBeGreaterThan(0);
    expect(order).toBeGreaterThan(where);
    expect(limit).toBeGreaterThan(order);
    expect(text.slice(order)).toMatch(
      /^ ORDER BY occurred_at DESC, event_row_id DESC LIMIT \$\d+$/,
    );
    for (const column of [
      'scope',
      'entity_type',
      'entity_id',
      'actor_id',
      'actor_email',
      'action',
      'project_id',
      'entity_label',
    ]) {
      expect(text.slice(where, order)).toContain(column);
    }
  });

  it('fetches one extra row to detect the next page', () => {
    expect(buildListQuery({ tenantId: 't' }, { limit: 200 }).values.at(-1)).toBe(201);
  });

  it('uses a row-value keyset predicate for the cursor', () => {
    const { text, values } = buildListQuery(
      { tenantId: 't' },
      { limit: 1, cursor: { occurredAt: '2024-01-01T00:00:00Z', eventRowId: '5' } },
    );
    expect(text).toContain('(occurred_at, event_row_id) < ($2::timestamptz, $3::bigint)');
    expect(values).toEqual(['t', '2024-01-01T00:00:00Z', '5', 2]);
  });

  it('escapes LIKE wildcards in the email prefix and the label search', () => {
    const { values } = buildListQuery(
      { tenantId: 't', actorEmailPrefix: 'a_b%', q: '100%_off\\' },
      { limit: 1 },
    );
    expect(values).toContain('a\\_b\\%%');
    expect(values).toContain('%100\\%\\_off\\\\%');
  });

  it('rejects a non-positive limit', () => {
    expect(() => buildListQuery({ tenantId: 't' }, { limit: 0 })).toThrow(RangeError);
  });
});

describe('buildCountQuery', () => {
  it('uses the same predicates without paging', () => {
    const list = buildListQuery(everything, { limit: 5 });
    const count = buildCountQuery(everything);
    expect(count.text).toMatch(/^SELECT count\(\*\)::bigint AS count FROM audit_event WHERE /);
    expect(count.text).not.toContain('LIMIT');
    expect(count.values).toEqual(list.values.slice(0, -1));
  });
});

describe('escapeLike', () => {
  it('escapes backslash, percent and underscore', () => {
    expect(escapeLike('\\%_a')).toBe('\\\\\\%\\_a');
  });
});
