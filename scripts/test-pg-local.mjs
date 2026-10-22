// Runs the integration tests against a throwaway PostgreSQL 16 (embedded-postgres binaries), for
// machines without Docker. CI uses a postgres:16 service container and sets DATABASE_URL_ADMIN itself.
import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const port = await freePort();
const dir = await mkdtemp(join(tmpdir(), 'audit-pg-'));
const password = 'postgres';
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  port,
  user: 'postgres',
  password,
  authMethod: 'scram-sha-256',
  persistent: false,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => undefined,
  onError: (e) => console.error(String(e)),
});

let code = 1;
try {
  await pg.initialise();
  await pg.start();
  console.log(`embedded PostgreSQL listening on 127.0.0.1:${String(port)}`);
  const vitest = join(import.meta.dirname, '..', 'node_modules', 'vitest', 'vitest.mjs');
  code = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [vitest, 'run', '--project', 'integration', ...process.argv.slice(2)],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          DATABASE_URL_ADMIN: `postgresql://postgres:${password}@127.0.0.1:${String(port)}/postgres`,
        },
      },
    );
    child.on('exit', (exitCode) => resolve(exitCode ?? 1));
  });
} finally {
  await pg.stop().catch((e) => console.error('failed to stop embedded PostgreSQL', e));
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
process.exit(code);
