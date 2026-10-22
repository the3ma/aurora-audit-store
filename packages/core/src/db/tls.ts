import type { ConnectionOptions } from 'node:tls';
import rdsCaBundle from '../../certs/rds-global-bundle.pem';
import { ConfigError } from '../errors.js';

export type SslMode = 'verify-full' | 'disable';

export function parseSslMode(value: string | undefined): SslMode {
  if (value === undefined || value === '' || value === 'verify-full') return 'verify-full';
  if (value === 'disable') return 'disable';
  throw new ConfigError(`DB_SSL must be "verify-full" or "disable"`);
}

/**
 * verify-full: the server certificate must chain to the RDS CA bundle (committed, not fetched at
 * runtime) and its name must match the host we dialled. Node's default checkServerIdentity does the
 * hostname check once `servername` is set.
 */
export function tlsOptions(mode: SslMode, host: string): ConnectionOptions | false {
  if (mode === 'disable') return false;
  return {
    ca: rdsCaBundle,
    rejectUnauthorized: true,
    servername: host,
    minVersion: 'TLSv1.2',
  };
}
