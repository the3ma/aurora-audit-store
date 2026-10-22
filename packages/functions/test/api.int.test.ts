import { silentLogger, type AuditEventRow } from '@audit/core';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  describeWithPostgres,
  insertEvents,
  type EventFixture,
  type TestDatabase,
} from '../../core/test/support/test-db.js';
import { createApp } from '../src/api/app.js';
import { refreshViews } from '../src/handlers/mv-refresh.js';

type Fixture = Required<
  Pick<
    EventFixture,
    | 'eventId'
    | 'tenantId'
    | 'scope'
    | 'entityType'
    | 'entityId'
    | 'entityLabel'
    | 'action'
    | 'actorId'
    | 'actorEmail'
    | 'occurredAt'
  >
> & { projectId: string | null };

const T1 = 't-001';
const T2 = 't-002';

/**
 * 120 recent "view" rows plus 5 old "export" rows for T1: the shape that broke the legacy store, where
 * a page of N unfiltered rows was fetched first and filtered afterwards.
 */
function fixtures(): Fixture[] {
  const out: Fixture[] = [];
  const recent = Date.parse('2025-06-01T00:00:00Z');
  for (let i = 0; i < 120; i += 1) {
    out.push({
      eventId: randomUUID(),
      tenantId: T1,
      projectId: i % 3 === 0 ? `p-${String(i % 4)}` : null,
      scope: i % 2 === 0 ? 'catalog' : 'orders',
      entityType: i % 2 === 0 ? 'product' : 'order',
      entityId: `e-${String(i % 10)}`,
      entityLabel: i % 5 === 0 ? `Blue Widget ${String(i)}` : `Thing ${String(i)}`,
      action: 'view',
      actorId: `u-${String(i % 6)}`,
      actorEmail:
        i % 4 === 0 ? `alice_${String(i % 6)}@example.test` : `bob${String(i % 6)}@example.test`,
      // Every fourth row shares a timestamp with its neighbour so the row-id tiebreaker is exercised.
      occurredAt: new Date(recent - Math.floor(i / 2) * 3_600_000).toISOString(),
    });
  }
  for (let i = 0; i < 5; i += 1) {
    out.push({
      eventId: randomUUID(),
      tenantId: T1,
      projectId: null,
      scope: 'billing',
      entityType: 'invoice',
      entityId: `inv-${String(i)}`,
      entityLabel: `Invoice inv-${String(i)}`,
      action: 'export',
      actorId: 'u-9',
      actorEmail: 'auditor@example.test',
      occurredAt: new Date(Date.parse('2023-01-15T08:00:00Z') + i * 1000).toISOString(),
    });
  }
  for (let i = 0; i < 10; i += 1) {
    out.push({
      eventId: randomUUID(),
      tenantId: T2,
      projectId: null,
      scope: 'billing',
      entityType: 'invoice',
      entityId: `inv-${String(i)}`,
      entityLabel: `Invoice inv-${String(i)}`,
      action: 'export',
      actorId: 'u-9',
      actorEmail: 'auditor@example.test',
      occurredAt: new Date(Date.parse('2024-01-01T00:00:00Z') + i * 1000).toISOString(),
    });
  }
  // Same millisecond, different microsecond: a JS Date cursor would lose the difference.
  for (const us of [
    '2025-07-01T00:00:00.000001Z',
    '2025-07-01T00:00:00.000002Z',
    '2025-07-01T00:00:00.000003Z',
  ]) {
    out.push({
      eventId: randomUUID(),
      tenantId: T1,
      projectId: null,
      scope: 'security',
      entityType: 'session',
      entityId: 's-1',
      entityLabel: 'Session s-1',
      action: 'sign_in',
      actorId: 'u-1',
      actorEmail: 'bob1@example.test',
      occurredAt: us,
    });
  }
  return out;
}

describeWithPostgres('read/write API against PostgreSQL 16', () => {
  let t: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const data = fixtures();
  const as = (tenantId: string) => ({ 'x-tenant-id': tenantId, 'x-actor-id': 'u-test' });

  const get = async (path: string, tenantId = T1) => {
    const res = await app.request(path, { headers: as(tenantId) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  /** Follows next_cursor to the end and returns every item in order. */
  const all = async (query: string, limit = 200, tenantId = T1) => {
    const items: AuditEventRow[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const sep = query ? '&' : '';
      const { status, body } = await get(
        `/v1/events?${query}${sep}limit=${String(limit)}${cursor ? `&cursor=${cursor}` : ''}`,
        tenantId,
      );
      expect(status).toBe(200);
      items.push(...(body['items'] as AuditEventRow[]));
      cursor = body['next_cursor'] as string | null;
      pages += 1;
    } while (cursor && pages < 1000);
    return items;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    await t.migrate();
    await insertEvents(t.db, data);
    app = createApp({ db: t.db, authMode: 'header' });
  });

  afterAll(async () => {
    await t.drop();
  });

  it('GET /v1/health reports the database', async () => {
    const res = await app.request('/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', checks: { db: 'ok' } });
  });

  it('requires the tenant from the auth context', async () => {
    const res = await app.request('/v1/events');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    expect((await get('/v1/events?tenant_id=t-002')).status).toBe(400);
  });

  const expected = (pred: (f: Fixture) => boolean, tenantId = T1) =>
    data
      .filter((f) => f.tenantId === tenantId && pred(f))
      .map((f) => f.eventId)
      .sort();

  const cases: [string, (f: Fixture) => boolean][] = [
    ['scope=billing', (f) => f.scope === 'billing'],
    ['entity_type=product', (f) => f.entityType === 'product'],
    ['entity_type=order&entity_id=e-3', (f) => f.entityType === 'order' && f.entityId === 'e-3'],
    ['actor_id=u-2', (f) => f.actorId === 'u-2'],
    ['actor_email_prefix=ALICE_', (f) => f.actorEmail.startsWith('alice_')],
    ['actor_email_prefix=alice%25', () => false],
    ['action=export', (f) => f.action === 'export'],
    ['project_id=p-0', (f) => f.projectId === 'p-0'],
    [
      'from=2025-05-30T00:00:00Z&to=2025-05-31T00:00:00Z',
      (f) => f.occurredAt >= '2025-05-30T00:00:00' && f.occurredAt < '2025-05-31T00:00:00',
    ],
    ['q=widget', (f) => f.entityLabel.toLowerCase().includes('widget')],
    [
      'scope=catalog&actor_id=u-0&q=blue',
      (f) => f.scope === 'catalog' && f.actorId === 'u-0' && f.entityLabel.includes('Blue'),
    ],
  ];

  it.each(cases)(
    'filter %s returns exactly the matching rows and count agrees',
    async (query, pred) => {
      const want = expected(pred);
      const items = await all(query, 7);
      expect(items.map((i) => i.event_id).sort()).toEqual(want);
      expect(items.every((i) => i.tenant_id === T1)).toBe(true);
      const { body } = await get(`/v1/events/count?${query}`);
      expect(body).toEqual({ count: want.length });
    },
  );

  it('keyset paging visits every row once, newest first, across ties and microseconds', async () => {
    const total = data.filter((f) => f.tenantId === T1).length;
    for (const limit of [1, 7, 50, 200]) {
      const items = await all('', limit);
      expect(items).toHaveLength(total);
      expect(new Set(items.map((i) => i.event_id)).size).toBe(total);
      for (let i = 1; i < items.length; i += 1) {
        const prev = items[i - 1] as AuditEventRow;
        const cur = items[i] as AuditEventRow;
        const ordered =
          prev.occurred_at > cur.occurred_at ||
          (prev.occurred_at === cur.occurred_at &&
            BigInt(prev.event_row_id) > BigInt(cur.event_row_id));
        expect(ordered).toBe(true);
      }
    }
    const signIns = await all('action=sign_in', 1);
    expect(signIns.map((i) => i.occurred_at)).toEqual([
      '2025-07-01T00:00:00.000003Z',
      '2025-07-01T00:00:00.000002Z',
      '2025-07-01T00:00:00.000001Z',
    ]);
  });

  it('regression: filtered rows older than the newest N unfiltered rows are still returned', async () => {
    const { status, body } = await get('/v1/events?action=export&limit=50');
    expect(status).toBe(200);
    const items = body['items'] as AuditEventRow[];
    expect(items).toHaveLength(5);
    expect(items.every((i) => i.action === 'export' && i.tenant_id === T1)).toBe(true);
    expect(body['next_cursor']).toBeNull();
  });

  it('isolates tenants, including with a cursor taken from another tenant', async () => {
    const t2 = await all('', 3, T2);
    expect(t2.map((i) => i.event_id).sort()).toEqual(expected(() => true, T2));
    const { body } = await get('/v1/events?limit=1');
    const foreignCursor = body['next_cursor'] as string;
    const page = await get(`/v1/events?limit=200&cursor=${foreignCursor}`, T2);
    expect((page.body['items'] as AuditEventRow[]).every((i) => i.tenant_id === T2)).toBe(true);
  });

  it.each([
    ['limit=0'],
    ['limit=201'],
    ['limit=abc'],
    ['q=ab'],
    ['scope=finance'],
    ['actor=u-1'],
    ['from=yesterday'],
    ['from=2025-01-02T00:00:00Z&to=2025-01-01T00:00:00Z'],
    ['cursor=not-a-cursor!'],
    [`cursor=${Buffer.from('2024-01-01T00:00:00Z,1 OR 1=1').toString('base64url')}`],
    ['scope=billing&scope=orders'],
  ])('rejects %s with 400', async (query) => {
    const { status, body } = await get(`/v1/events?${query}`);
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: expect.stringMatching(/^invalid_/) as unknown } });
  });

  describe('POST /v1/events', () => {
    const event = {
      event_id: randomUUID(),
      scope: 'billing',
      entity_type: 'invoice',
      entity_id: 'inv-9001',
      entity_label: 'Invoice inv-9001',
      action: 'void',
      actor_id: 'u-17',
      actor_email: 'user17@example.test',
      occurred_at: '2026-01-02T03:04:05.678Z',
      changes: [{ field: 'status', old: 'open', new: 'void' }],
    };
    const post = (body: unknown, tenantId = T1) =>
      app.request('/v1/events', {
        method: 'POST',
        headers: { ...as(tenantId), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('creates once (201) and replays idempotently (200, same row)', async () => {
      const first = await post(event);
      expect(first.status).toBe(201);
      const row = (await first.json()) as AuditEventRow;
      expect(row).toMatchObject({
        ...event,
        occurred_at: '2026-01-02T03:04:05.678000Z',
        tenant_id: T1,
        source: 'live',
        project_id: null,
        comment: null,
      });

      const replay = await post(event);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(row);
    });

    it('does not reveal an event_id owned by another tenant', async () => {
      const res = await post(event, T2);
      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).not.toContain('inv-9001');
    });

    it.each([
      ['missing event_id', { ...event, event_id: undefined }],
      ['row id', { ...event, event_id: randomUUID(), event_row_id: 1 }],
      ['source', { ...event, event_id: randomUUID(), source: 'backfill' }],
      ['tenant_id', { ...event, event_id: randomUUID(), tenant_id: T2 }],
      ['bad scope', { ...event, event_id: randomUUID(), scope: 'finance' }],
      ['bad changes', { ...event, event_id: randomUUID(), changes: { field: 'x' } }],
      ['bad timestamp', { ...event, event_id: randomUUID(), occurred_at: '2026-01-02 03:04' }],
    ])('rejects %s with 400', async (_name, body) => {
      expect((await post(body)).status).toBe(400);
    });

    it('rejects a non-JSON body with 400', async () => {
      const res = await app.request('/v1/events', {
        method: 'POST',
        headers: { ...as(T1), 'content-type': 'application/json' },
        body: '{',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('materialized views', () => {
    beforeAll(async () => {
      await refreshViews(t.db, silentLogger);
    });

    it('GET /v1/facets lists distinct values for the tenant only', async () => {
      const { status, body } = await get('/v1/facets');
      expect(status).toBe(200);
      expect(body['scope']).toEqual(['billing', 'catalog', 'orders', 'security']);
      expect(body['action']).toEqual(['export', 'sign_in', 'view', 'void']);
      expect(body['entity_type']).toEqual(['invoice', 'order', 'product', 'session']);
      expect((await get('/v1/facets', T2)).body['scope']).toEqual(['billing']);
    });

    it('GET /v1/stats/daily returns UTC day buckets', async () => {
      const { status, body } = await get('/v1/stats/daily?from=2023-01-01&to=2023-01-31');
      expect(status).toBe(200);
      expect(body).toEqual({
        items: [{ scope: 'billing', day: '2023-01-15', action: 'export', events: 5 }],
      });
      expect((await get('/v1/stats/daily?from=2023-01-01&to=2025-01-01')).status).toBe(400);
    });
  });

  it('unknown routes are 404 with the error envelope', async () => {
    const { status, body } = await get('/v1/nope');
    expect(status).toBe(404);
    expect(body).toEqual({ error: { code: 'not_found', message: 'no such route' } });
  });
});
