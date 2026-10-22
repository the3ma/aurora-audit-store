import type { DbAccess } from '@audit/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/api/app.js';
import { principalFromLambdaEvent } from '../src/api/auth.js';
import { HttpError } from '../src/api/http-error.js';

/** Validation and auth must reject before any database access. */
const noDb: DbAccess = {
  withClient: vi.fn(() => Promise.reject(new Error('database must not be reached'))),
};
const headers = { 'x-tenant-id': 't-001', 'x-actor-id': 'u-1' };

describe('API without a database', () => {
  const app = createApp({
    db: noDb,
    authMode: 'header',
    corsOrigins: ['https://app.example.test'],
  });

  beforeEach(() => {
    vi.mocked(noDb.withClient).mockClear();
  });

  it.each([
    ['/v1/events?limit=500'],
    ['/v1/events?unknown=1'],
    ['/v1/events?tenant_id=t-002'],
    ['/v1/events?q=ab'],
    ['/v1/events?cursor=%%%'],
    ['/v1/events?action=a&action=b'],
    ['/v1/events/count?limit=5'],
    ['/v1/stats/daily?from=2024-01-01'],
    ['/v1/facets?scope=billing'],
  ])('400 for %s', async (path) => {
    const res = await app.request(path, { headers });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: expect.any(String) as unknown, message: expect.any(String) as unknown },
    });
    expect(noDb.withClient).not.toHaveBeenCalled();
  });

  it('401 without identity headers, 403 for malformed ones', async () => {
    expect((await app.request('/v1/events')).status).toBe(401);
    expect(
      (
        await app.request('/v1/events', {
          headers: { 'x-tenant-id': 'bad tenant', 'x-actor-id': 'u' },
        })
      ).status,
    ).toBe(403);
    expect(noDb.withClient).not.toHaveBeenCalled();
  });

  it('503 from health when the database is down, without leaking the error', async () => {
    const res = await app.request('/v1/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'degraded', checks: { db: 'error' } });
  });

  it('500 envelope for unexpected errors', async () => {
    const res = await app.request('/v1/events', { headers });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'internal', message: 'internal error' } });
  });

  it('413 for an oversized body', async () => {
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'content-length': String(70 * 1024),
      },
      body: JSON.stringify({ comment: 'x'.repeat(70 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it('answers CORS preflight only for configured origins', async () => {
    const ok = await app.request('/v1/events', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example.test', 'access-control-request-method': 'GET' },
    });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    const other = await app.request('/v1/events', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.test', 'access-control-request-method': 'GET' },
    });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('jwt mode', () => {
  const event = (claims?: Record<string, unknown>) => ({
    requestContext: claims === undefined ? {} : { authorizer: { jwt: { claims, scopes: [] } } },
  });

  it('takes the tenant from the authorizer claim', () => {
    expect(principalFromLambdaEvent(event({ tenant_id: 't-042', sub: 'u-17' }))).toEqual({
      tenantId: 't-042',
      actorId: 'u-17',
    });
  });

  it('401 without a verified token, 403 without a usable tenant claim', () => {
    const status = (e: unknown) => {
      try {
        principalFromLambdaEvent(e);
        return 200;
      } catch (error) {
        return error instanceof HttpError ? error.status : 0;
      }
    };
    expect(status(event())).toBe(401);
    expect(status(undefined)).toBe(401);
    expect(status(event({ sub: 'u-1' }))).toBe(403);
    expect(status(event({ tenant_id: 42 }))).toBe(403);
    expect(status(event({ tenant_id: '../t-1' }))).toBe(403);
  });

  it('ignores X-Tenant-Id headers entirely', async () => {
    const app = createApp({ db: noDb, authMode: 'jwt' });
    const res = await app.request('/v1/events', { headers }, { event: event() });
    expect(res.status).toBe(401);
  });
});
