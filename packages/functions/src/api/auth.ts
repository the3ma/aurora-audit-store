import { HttpError } from './http-error.js';

export type AuthMode = 'header' | 'jwt';

export interface Principal {
  tenantId: string;
  actorId: string;
}

const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ACTOR_ID = /^[^\s]{1,256}$/;

export function parseAuthMode(value: string | undefined): AuthMode {
  if (value === 'header' || value === 'jwt') return value;
  throw new Error('AUTH_MODE must be "header" or "jwt"');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * jwt mode: API Gateway's JWT authorizer has already verified signature, issuer, audience and expiry;
 * we only read the claims it forwards. There is deliberately no second, local JWT verification path
 * that could drift from the authorizer's configuration.
 */
export function principalFromLambdaEvent(event: unknown): Principal {
  const claims = asRecord(
    asRecord(asRecord(asRecord(asRecord(event)?.['requestContext'])?.['authorizer'])?.['jwt'])?.[
      'claims'
    ],
  );
  if (!claims) throw new HttpError(401, 'unauthenticated', 'no verified token on the request');
  const tenantId = claims['tenant_id'];
  if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId)) {
    throw new HttpError(403, 'forbidden', 'token carries no valid tenant_id claim');
  }
  const sub = claims['sub'];
  return { tenantId, actorId: typeof sub === 'string' && sub.length > 0 ? sub : 'unknown' };
}

/** header mode is for local development only: the caller simply asserts who it is. */
export function principalFromHeaders(header: (name: string) => string | undefined): Principal {
  const tenantId = header('x-tenant-id');
  const actorId = header('x-actor-id');
  if (tenantId === undefined || actorId === undefined) {
    throw new HttpError(401, 'unauthenticated', 'X-Tenant-Id and X-Actor-Id headers are required');
  }
  if (!TENANT_ID.test(tenantId) || !ACTOR_ID.test(actorId)) {
    throw new HttpError(403, 'forbidden', 'X-Tenant-Id or X-Actor-Id is malformed');
  }
  return { tenantId, actorId };
}
