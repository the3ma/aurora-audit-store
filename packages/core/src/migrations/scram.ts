import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

const ITERATIONS = 4096;

/**
 * SCRAM-SHA-256 verifier in the format PostgreSQL stores in pg_authid. Sending the verifier instead of
 * the plaintext means `ALTER ROLE ... PASSWORD` never carries the password itself, so it cannot leak
 * through log_statement, pg_stat_statements or an error message. Passwords are generated from a
 * printable-ASCII alphabet, for which SASLprep is the identity.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${String(ITERATIONS)}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
