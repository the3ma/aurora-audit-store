import { type LegacyItem, type RejectReason, SCOPES, type Scope } from '@audit/core';

/** Small deterministic PRNG (mulberry32) so a seed reproduces the same data set. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ENTITIES: Record<Scope, readonly string[]> = {
  accounts: ['user', 'role', 'api_key'],
  billing: ['invoice', 'payment', 'subscription'],
  catalog: ['product', 'price_list'],
  orders: ['order', 'shipment', 'refund'],
  settings: ['setting', 'integration'],
  security: ['session', 'mfa_device', 'sso_config'],
};

const ACTIONS: Record<Scope, readonly string[]> = {
  accounts: ['create', 'update', 'delete', 'view'],
  billing: ['create', 'update', 'void', 'view', 'export'],
  catalog: ['create', 'update', 'delete', 'view'],
  orders: ['create', 'update', 'view', 'export'],
  settings: ['update', 'view'],
  security: ['sign_in', 'sign_out', 'update', 'create'],
};

const FIELDS = ['status', 'amount', 'name', 'email', 'role', 'quantity', 'currency', 'enabled'];
const THREE_YEARS_MS = 3 * 365 * 86_400_000;

export interface GeneratedItem {
  item: LegacyItem;
  /** The reject reason this item was deliberately built to trigger, if any. */
  defect?: RejectReason;
}

export interface GenerateOptions {
  count: number;
  seed?: number;
  /** Newest possible OccurredAt; history spreads three years back from here. */
  anchor?: Date;
  /** Share of items per reject reason (default 1%). */
  defectRate?: number;
  /** Share of valid items without EventId (old writer versions never set one). */
  missingEventIdRate?: number;
}

function pick<T>(rand: () => number, values: readonly T[]): T {
  return values[Math.floor(rand() * values.length)] as T;
}

function mixedCase(rand: () => number, scope: string): string {
  const r = rand();
  if (r < 0.15) return scope.toUpperCase();
  if (r < 0.3) return scope.charAt(0).toUpperCase() + scope.slice(1);
  return scope;
}

function uuidFrom(rand: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Items shaped like the old single-table design, skewed the way real tenants are (a few large, many
 * small), with deliberate defects for every reject reason so the backfill's reject path is exercised.
 */
export function* generateLegacyItems(options: GenerateOptions): Generator<GeneratedItem> {
  const rand = prng(options.seed ?? 42);
  const anchor = (options.anchor ?? new Date('2026-10-01T00:00:00.000Z')).getTime();
  const defectRate = options.defectRate ?? 0.01;
  const missingRate = options.missingEventIdRate ?? 0.05;
  const tenants = Array.from({ length: 12 }, (_, i) => `t-${String(i * 37 + 5).padStart(3, '0')}`);

  for (let i = 0; i < options.count; i += 1) {
    // Squaring the uniform draw skews volume towards the first tenants.
    const tenantId = tenants[Math.floor(rand() ** 2 * tenants.length)] as string;
    const scope = pick(rand, SCOPES);
    const entityType = pick(rand, ENTITIES[scope]);
    const action = pick(rand, ACTIONS[scope]);
    const occurred = new Date(anchor - Math.floor(rand() * THREE_YEARS_MS));
    const iso = occurred.toISOString();
    const entityId = `${entityType.slice(0, 3)}-${String(1000 + Math.floor(rand() * 4000))}`;
    const actorNo = Math.floor(rand() * 40) + 1;
    const actorId = `u-${String(actorNo)}`;
    const projectId = rand() < 0.4 ? `p-${String(Math.floor(rand() * 9) + 1)}` : undefined;
    const changes =
      action === 'update'
        ? [{ field: pick(rand, FIELDS), old: 'a', new: 'b' }]
        : action === 'create'
          ? [{ field: pick(rand, FIELDS), new: 'a' }]
          : [];

    const item: LegacyItem = {
      PK: `TENANT#${tenantId}#ENTITY#${entityType}`,
      // The old change number was unix seconds, which collides for bursts within one second.
      SK: `DATE#${iso}#CHANGE#${String(Math.floor(occurred.getTime() / 1000))}`,
      GSI1PK: `ACTOR#${actorId}`,
      GSI1SK: `DATE#${iso}`,
      GSI2PK: projectId ? `PROJECT#${projectId}` : `TENANT#${tenantId}`,
      GSI3PK: `ENTITY#${entityType}#${entityId}`,
      GSI4PK: `SCOPE#${scope}`,
      EventId: rand() < missingRate ? undefined : uuidFrom(rand),
      TenantId: tenantId,
      Scope: mixedCase(rand, scope),
      EntityType: entityType,
      EntityId: entityId,
      EntityLabel: `${entityType.replace('_', ' ')} ${entityId}`,
      Action: action,
      ActorId: actorId,
      ActorEmail: `user${String(actorNo)}@${tenantId}.example.test`,
      OccurredAt: iso,
      Changes: JSON.stringify(changes),
      ExpiresAt: Math.floor((occurred.getTime() + 2 * 365 * 86_400_000) / 1000),
    };
    if (projectId) item.ProjectId = projectId;
    if (rand() < 0.1) item.Comment = 'requested by support';
    if (item.EventId === undefined) delete item.EventId;

    let defect: RejectReason | undefined;
    const d = rand();
    if (d < defectRate) {
      defect = 'invalid_scope';
      item.Scope = pick(rand, ['finance', 'admin', '']);
    } else if (d < 2 * defectRate) {
      defect = 'invalid_date';
      item.OccurredAt = pick(rand, ['2024-02-30T10:00:00Z', '03/01/2024 10:15', 'yesterday']);
    } else if (d < 3 * defectRate) {
      defect = 'invalid_changes';
      item.Changes = pick(rand, ['{"field":"status"}', 'status: a -> b', '[{"old":"a"}]']);
    } else if (d < 4 * defectRate) {
      defect = 'invalid_event_id';
      item.EventId = pick(rand, [`evt-${String(i)}`, uuidFrom(rand).slice(0, 30)]);
    }
    yield defect ? { item, defect } : { item };
  }
}
