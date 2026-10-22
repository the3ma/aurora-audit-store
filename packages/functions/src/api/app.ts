import {
  buildCountQuery,
  buildListQuery,
  describeError,
  encodeCursor,
  FACETS,
  INSERT_ONE_EVENT_SQL,
  SELECT_EVENT_BY_ID_SQL,
  silentLogger,
  type AuditEventRow,
  type DbAccess,
  type Facet,
  type Logger,
} from '@audit/core';
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import {
  principalFromHeaders,
  principalFromLambdaEvent,
  type AuthMode,
  type Principal,
} from './auth.js';
import { HttpError } from './http-error.js';
import {
  countQuerySchema,
  dailyStatsQuerySchema,
  listQuerySchema,
  newEventSchema,
  parseCursor,
  singleValuedQuery,
  toFilter,
  validate,
} from './schemas.js';

export interface AppOptions {
  db: DbAccess;
  authMode: AuthMode;
  corsOrigins?: readonly string[];
  logger?: Logger;
}

interface AppEnv {
  Bindings: { event?: unknown };
  Variables: { principal: Principal; requestId: string };
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

export function createApp(options: AppOptions): Hono<AppEnv> {
  const { db, authMode } = options;
  const logger = options.logger ?? silentLogger;
  const app = new Hono<AppEnv>();

  if (options.corsOrigins && options.corsOrigins.length > 0) {
    app.use(
      '*',
      cors({
        origin: [...options.corsOrigins],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type', 'X-Tenant-Id', 'X-Actor-Id'],
        maxAge: 600,
      }),
    );
  }

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? randomUUID();
    c.set('requestId', requestId);
    const started = performance.now();
    await next();
    c.header('x-request-id', requestId);
    logger.info('request', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  });

  app.get('/v1/health', async (c) => {
    try {
      await db.withClient('reader', (client) => client.query('SELECT 1'));
      return c.json({ status: 'ok', checks: { db: 'ok' } });
    } catch (error) {
      logger.warn('health check failed', { error });
      return c.json({ status: 'degraded', checks: { db: 'error' } }, 503);
    }
  });

  // Everything else needs a tenant; it comes from the auth context only.
  app.use('/v1/*', async (c, next) => {
    c.set(
      'principal',
      authMode === 'jwt'
        ? principalFromLambdaEvent(c.env.event)
        : principalFromHeaders((n) => c.req.header(n)),
    );
    await next();
  });

  const query = (c: Context<AppEnv>) => singleValuedQuery(c.req.queries());

  app.get('/v1/events', async (c) => {
    const { tenantId } = c.get('principal');
    const q = validate(listQuerySchema, query(c));
    const cursor = parseCursor(q.cursor);
    const sql = buildListQuery(toFilter(tenantId, q), { limit: q.limit, cursor });
    const { rows } = await db.withClient('reader', (client) => client.query<AuditEventRow>(sql));
    const items = rows.slice(0, q.limit);
    const last = items.at(-1);
    const next_cursor =
      rows.length > q.limit && last
        ? encodeCursor({ occurredAt: last.occurred_at, eventRowId: last.event_row_id })
        : null;
    return c.json({ items, next_cursor });
  });

  app.get('/v1/events/count', async (c) => {
    const { tenantId } = c.get('principal');
    const q = validate(countQuerySchema, query(c));
    const { rows } = await db.withClient('reader', (client) =>
      client.query<{ count: string }>(buildCountQuery(toFilter(tenantId, q))),
    );
    return c.json({ count: Number(rows[0]?.count ?? 0) });
  });

  app.post(
    '/v1/events',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: () => {
        throw new HttpError(413, 'payload_too_large', 'body exceeds 64 KiB');
      },
    }),
    async (c) => {
      const { tenantId } = c.get('principal');
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        throw new HttpError(400, 'invalid_request', 'body must be JSON');
      }
      const body = validate(newEventSchema, raw);
      const values = [
        body.event_id,
        tenantId,
        body.project_id ?? null,
        body.scope,
        body.entity_type,
        body.entity_id,
        body.entity_label,
        body.action,
        body.actor_id,
        body.actor_email,
        body.occurred_at,
        JSON.stringify(body.changes),
        body.comment ?? null,
      ];
      const result = await db.withClient('writer', async (client) => {
        const inserted = await client.query<AuditEventRow>(INSERT_ONE_EVENT_SQL, values);
        if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
        const existing = await client.query<AuditEventRow>(SELECT_EVENT_BY_ID_SQL, [
          body.event_id,
          tenantId,
        ]);
        return { row: existing.rows[0], created: false };
      });
      // The id exists but under another tenant: report a conflict without revealing anything about it.
      if (!result.row) throw new HttpError(409, 'conflict', 'event_id is already in use');
      return c.json(result.row, result.created ? 201 : 200);
    },
  );

  app.get('/v1/facets', async (c) => {
    const { tenantId } = c.get('principal');
    if (Object.keys(c.req.queries()).length > 0) {
      throw new HttpError(400, 'invalid_request', 'facets takes no query parameters');
    }
    const { rows } = await db.withClient('reader', (client) =>
      client.query<{ facet: Facet; value: string }>(
        'SELECT facet, value FROM mv_audit_facets WHERE tenant_id = $1 ORDER BY facet, value',
        [tenantId],
      ),
    );
    const facets = Object.fromEntries(FACETS.map((f) => [f, [] as string[]])) as Record<
      Facet,
      string[]
    >;
    for (const { facet, value } of rows) facets[facet].push(value);
    return c.json(facets);
  });

  app.get('/v1/stats/daily', async (c) => {
    const { tenantId } = c.get('principal');
    const q = validate(dailyStatsQuerySchema, query(c));
    const { rows } = await db.withClient('reader', (client) =>
      client.query<{ scope: string; day: string; action: string; events: string }>(
        `SELECT scope::text AS scope, to_char(day, 'YYYY-MM-DD') AS day, action, events::text AS events
         FROM mv_audit_daily_counts
         WHERE tenant_id = $1 AND day BETWEEN $2::date AND $3::date
         ORDER BY day, scope, action`,
        [tenantId, q.from, q.to],
      ),
    );
    return c.json({ items: rows.map((r) => ({ ...r, events: Number(r.events) })) });
  });

  app.notFound((c) => c.json(errorBody('not_found', 'no such route'), 404));

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json(errorBody(error.code, error.message), error.status);
    }
    logger.error('unhandled error', { requestId: c.get('requestId'), error: describeError(error) });
    return c.json(errorBody('internal', 'internal error'), 500);
  });

  return app;
}
