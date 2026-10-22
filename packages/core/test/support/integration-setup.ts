// Runs once in the main vitest process, so the notice is visible even when every file is skipped.
export default function setup(): void {
  if (process.env['DATABASE_URL_ADMIN']) return;
  process.stderr.write(
    '\n[integration] DATABASE_URL_ADMIN is not set - all PostgreSQL integration tests are SKIPPED.\n' +
      '[integration] Run `npm run test:pg:local` (embedded PostgreSQL 16) or set DATABASE_URL_ADMIN to a\n' +
      '[integration] superuser URL on a disposable server (tests create and drop their own databases).\n\n',
  );
}
