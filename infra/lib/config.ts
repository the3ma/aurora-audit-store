import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Node } from 'constructs';

export type Stage = 'dev' | 'prod';
export type VaultLockMode = 'none' | 'governance' | 'compliance';

export type VpcConfig =
  | { readonly mode: 'create'; readonly natGateways: number }
  | {
      readonly mode: 'import';
      readonly vpcId: string;
      readonly dbSubnetGroupName?: string;
      readonly appSubnetGroupName?: string;
      readonly createEndpoints: boolean;
    };

export interface StageConfig {
  readonly stage: Stage;
  readonly prefix: string;
  readonly vpc: VpcConfig;
  readonly minAcu: number;
  readonly maxAcu: number;
  readonly enableReader: boolean;
  readonly backupRetentionYears: number;
  readonly vaultLockMode: VaultLockMode;
  readonly drRegion?: string;
  readonly drVaultArn?: string;
  readonly drVaultName: string;
  readonly alarmEmail?: string;
  readonly jwtIssuer?: string;
  readonly jwtAudience?: string;
  readonly corsOrigins: readonly string[];
  readonly evidenceRetentionDays: number;
  readonly legacyTableName: string;
  readonly createLegacyTable: boolean;
  readonly logRetentionDays: number;
  readonly apiReservedConcurrency?: number;
  readonly apiThrottleRate: number;
  readonly apiThrottleBurst: number;
  /** prod: deletion protection + RETAIN; dev: DESTROY so a sandbox can be torn down. */
  readonly retainData: boolean;
  readonly skipBundling: boolean;
}

export interface DrVaultConfig {
  readonly drVaultName: string;
  readonly vaultLockMode: VaultLockMode;
}

export class ConfigError extends Error {}

const STAGE_DEFAULTS: Record<Stage, Omit<StageConfig, 'stage' | 'prefix' | 'vpc' | 'legacyTableName' | 'skipBundling'>> = {
  dev: {
    minAcu: 0.5,
    maxAcu: 4,
    enableReader: false,
    backupRetentionYears: 7,
    vaultLockMode: 'none',
    drVaultName: 'audit-store-dr',
    corsOrigins: [],
    evidenceRetentionDays: 1,
    createLegacyTable: false,
    logRetentionDays: 30,
    apiThrottleRate: 50,
    apiThrottleBurst: 100,
    retainData: false,
  },
  prod: {
    minAcu: 0.5,
    maxAcu: 4,
    enableReader: true,
    backupRetentionYears: 7,
    vaultLockMode: 'governance',
    drVaultName: 'audit-store-dr',
    corsOrigins: [],
    evidenceRetentionDays: 2557,
    createLegacyTable: false,
    logRetentionDays: 365,
    apiReservedConcurrency: 25,
    apiThrottleRate: 200,
    apiThrottleBurst: 400,
    retainData: true,
  },
};

const VAULT_LOCK_MODES: readonly VaultLockMode[] = ['none', 'governance', 'compliance'];
const LOG_RETENTION_DAYS: readonly number[] = Object.values(RetentionDays).filter((v): v is RetentionDays => typeof v === 'number');

/** Reads `-c key=value` (always a string) or cdk.json context (may already be typed). */
class Context {
  constructor(private readonly node: Node) {}

  private raw(key: string): unknown {
    const v: unknown = this.node.tryGetContext(key);
    return v === '' ? undefined : v;
  }

  str(key: string): string | undefined {
    const v = this.raw(key);
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw new ConfigError(`context ${key} must be a string`);
    return v.trim();
  }

  num(key: string): number | undefined {
    const v = this.raw(key);
    if (v === undefined || v === null) return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) throw new ConfigError(`context ${key} must be a number, got ${JSON.stringify(v)}`);
    return n;
  }

  bool(key: string): boolean | undefined {
    const v = this.raw(key);
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'boolean') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    throw new ConfigError(`context ${key} must be true|false, got ${JSON.stringify(v)}`);
  }

  /** Accepts a JSON array or a comma-separated string. */
  list(key: string): string[] | undefined {
    const v = this.raw(key);
    if (v === undefined || v === null) return undefined;
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x.length > 0);
    if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
    throw new ConfigError(`context ${key} must be a list`);
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new ConfigError(message);
}

function parseVaultLockMode(value: string | undefined, fallback: VaultLockMode, key: string): VaultLockMode {
  if (value === undefined) return fallback;
  const mode = VAULT_LOCK_MODES.find((m) => m === value);
  if (!mode) throw new ConfigError(`context ${key} must be one of ${VAULT_LOCK_MODES.join('|')}, got ${value}`);
  return mode;
}

function isHalfStep(n: number): boolean {
  return Number.isInteger(n * 2);
}

export function loadStageConfig(node: Node): StageConfig {
  const ctx = new Context(node);
  const stageRaw = ctx.str('stage') ?? 'dev';
  check(stageRaw === 'dev' || stageRaw === 'prod', `context stage must be dev|prod, got ${stageRaw}`);
  const stage = stageRaw as Stage;
  const d = STAGE_DEFAULTS[stage];

  const prefix = ctx.str('prefix') ?? `audit-${stage}`;
  check(/^[a-z][a-z0-9-]{1,23}$/.test(prefix), `context prefix must match ^[a-z][a-z0-9-]{1,23}$, got ${prefix}`);

  const vpcId = ctx.str('vpcId');
  let vpc: VpcConfig;
  if (vpcId !== undefined) {
    check(/^vpc-[0-9a-f]{8,17}$/.test(vpcId), `context vpcId is not a VPC id: ${vpcId}`);
    const dbSubnetGroupName = ctx.str('dbSubnetGroupName');
    const appSubnetGroupName = ctx.str('appSubnetGroupName');
    vpc = {
      mode: 'import',
      vpcId,
      createEndpoints: ctx.bool('createEndpoints') ?? false,
      ...(dbSubnetGroupName !== undefined && { dbSubnetGroupName }),
      ...(appSubnetGroupName !== undefined && { appSubnetGroupName }),
    };
  } else {
    const natGateways = ctx.num('natGateways') ?? 0;
    check(Number.isInteger(natGateways) && natGateways >= 0 && natGateways <= 2, 'context natGateways must be 0, 1 or 2');
    vpc = { mode: 'create', natGateways };
  }

  const minAcu = ctx.num('minAcu') ?? d.minAcu;
  const maxAcu = ctx.num('maxAcu') ?? d.maxAcu;
  check(isHalfStep(minAcu) && isHalfStep(maxAcu), 'minAcu/maxAcu must be multiples of 0.5');
  check(minAcu >= 0 && minAcu <= 256, 'minAcu must be within 0-256');
  check(maxAcu >= 1 && maxAcu <= 256, 'maxAcu must be within 1-256');
  check(minAcu <= maxAcu, `minAcu (${minAcu}) must be <= maxAcu (${maxAcu})`);

  const backupRetentionYears = ctx.num('backupRetentionYears') ?? d.backupRetentionYears;
  check(Number.isInteger(backupRetentionYears) && backupRetentionYears >= 1 && backupRetentionYears <= 99, 'backupRetentionYears must be an integer within 1-99');

  const vaultLockMode = parseVaultLockMode(ctx.str('vaultLockMode'), d.vaultLockMode, 'vaultLockMode');
  // Compliance-mode Vault Lock is irreversible once its grace period ends: never on a sandbox.
  check(!(vaultLockMode === 'compliance' && stage !== 'prod'), `vaultLockMode=compliance is only allowed for stage=prod (got stage=${stage})`);

  const drRegion = ctx.str('drRegion');
  if (drRegion !== undefined) check(/^[a-z]{2}(-[a-z]+)+-\d$/.test(drRegion), `context drRegion is not a region: ${drRegion}`);
  const drVaultArn = ctx.str('drVaultArn');
  if (drVaultArn !== undefined) check(/^arn:aws[a-z-]*:backup:[a-z0-9-]+:\d{12}:backup-vault:[A-Za-z0-9_-]+$/.test(drVaultArn), `context drVaultArn is not a Backup vault ARN: ${drVaultArn}`);
  const drVaultName = ctx.str('drVaultName') ?? d.drVaultName;
  check(/^[A-Za-z0-9_-]{2,50}$/.test(drVaultName), 'drVaultName must match ^[A-Za-z0-9_-]{2,50}$');

  const alarmEmail = ctx.str('alarmEmail');
  if (alarmEmail !== undefined) check(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alarmEmail), `context alarmEmail is not an email: ${alarmEmail}`);

  const jwtIssuer = ctx.str('jwtIssuer');
  const jwtAudience = ctx.str('jwtAudience');
  if (jwtIssuer !== undefined) {
    check(/^https:\/\/[^\s]+$/.test(jwtIssuer), 'jwtIssuer must be an https:// URL');
    check(jwtAudience !== undefined, 'jwtAudience is required when jwtIssuer is set');
  }

  const corsOrigins = ctx.list('corsOrigins') ?? [...d.corsOrigins];
  for (const origin of corsOrigins) {
    check(/^https:\/\/[^\s/*]+$/.test(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin), `corsOrigins entry must be https://host or http://localhost[:port], got ${origin}`);
  }

  const evidenceRetentionDays = ctx.num('evidenceRetentionDays') ?? d.evidenceRetentionDays;
  check(Number.isInteger(evidenceRetentionDays) && evidenceRetentionDays >= 1 && evidenceRetentionDays <= 36500, 'evidenceRetentionDays must be an integer within 1-36500');

  const logRetentionDays = ctx.num('logRetentionDays') ?? d.logRetentionDays;
  check(LOG_RETENTION_DAYS.includes(logRetentionDays), `logRetentionDays must be one of ${LOG_RETENTION_DAYS.join(',')}`);

  const apiReservedConcurrency = ctx.num('apiReservedConcurrency') ?? d.apiReservedConcurrency;
  if (apiReservedConcurrency !== undefined) check(Number.isInteger(apiReservedConcurrency) && apiReservedConcurrency >= 1, 'apiReservedConcurrency must be a positive integer');

  const apiThrottleRate = ctx.num('apiThrottleRate') ?? d.apiThrottleRate;
  const apiThrottleBurst = ctx.num('apiThrottleBurst') ?? d.apiThrottleBurst;
  check(apiThrottleRate > 0 && Number.isInteger(apiThrottleBurst) && apiThrottleBurst > 0, 'apiThrottleRate/apiThrottleBurst must be positive');

  return {
    stage,
    prefix,
    vpc,
    minAcu,
    maxAcu,
    enableReader: ctx.bool('enableReader') ?? d.enableReader,
    backupRetentionYears,
    vaultLockMode,
    drVaultName,
    corsOrigins,
    evidenceRetentionDays,
    legacyTableName: ctx.str('legacyTableName') ?? `${prefix}-audit-legacy`,
    createLegacyTable: ctx.bool('createLegacyTable') ?? d.createLegacyTable,
    logRetentionDays,
    apiThrottleRate,
    apiThrottleBurst,
    retainData: d.retainData,
    skipBundling: ctx.bool('skipBundling') ?? false,
    ...(drRegion !== undefined && { drRegion }),
    ...(drVaultArn !== undefined && { drVaultArn }),
    ...(alarmEmail !== undefined && { alarmEmail }),
    ...(jwtIssuer !== undefined && { jwtIssuer }),
    ...(jwtAudience !== undefined && { jwtAudience }),
    ...(apiReservedConcurrency !== undefined && { apiReservedConcurrency }),
  };
}

export function loadDrVaultConfig(node: Node): DrVaultConfig {
  const ctx = new Context(node);
  const drVaultName = ctx.str('drVaultName') ?? STAGE_DEFAULTS.prod.drVaultName;
  check(/^[A-Za-z0-9_-]{2,50}$/.test(drVaultName), 'drVaultName must match ^[A-Za-z0-9_-]{2,50}$');
  return {
    drVaultName,
    vaultLockMode: parseVaultLockMode(ctx.str('drVaultLockMode'), 'governance', 'drVaultLockMode'),
  };
}

/** Maps validated logRetentionDays onto the CloudWatch Logs enum without a cast. */
export function logRetention(days: number): RetentionDays {
  const match = (Object.values(RetentionDays) as unknown[]).find((v): v is RetentionDays => v === days);
  if (match === undefined) throw new ConfigError(`unsupported log retention ${days}`);
  return match;
}
