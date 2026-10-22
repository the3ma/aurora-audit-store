// Bundles the handlers, CLIs and local API server with the same esbuild settings the CDK
// NodejsFunction uses (text loader for .sql/.pem, Node 22, ESM), into a self-contained dist/ that the
// container image runs without node_modules.
import { build } from 'esbuild';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const root = import.meta.dirname;
const out = join(root, 'dist');
const ts = (dir) =>
  readdir(join(root, dir)).then((f) => f.filter((n) => n.endsWith('.ts')).map((n) => join(dir, n)));

const cli = await ts('src/cli');
const handlers = await ts('src/handlers');

await rm(out, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: [
    ...cli.map((f) => ({ in: f, out: `cli/${basename(f, '.ts')}` })),
    ...handlers.map((f) => ({ in: f, out: `handlers/${basename(f, '.ts')}` })),
    { in: 'src/api/server.ts', out: 'cli/api' },
  ],
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  loader: { '.sql': 'text', '.pem': 'text' },
  // pg tries to require the optional native binding; it is never installed.
  external: ['pg-native'],
  // CommonJS dependencies inside an ESM bundle still call require() for Node builtins.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

const scripts = Object.fromEntries(
  [...cli.map((f) => basename(f, '.ts')), 'api'].map((name) => [
    name === 'simulate-dynamodb-export' ? 'simulate-export' : name,
    `node --enable-source-maps cli/${name}.mjs`,
  ]),
);
await writeFile(
  join(out, 'package.json'),
  JSON.stringify(
    { name: 'audit-functions-runtime', private: true, type: 'module', scripts },
    null,
    2,
  ) + '\n',
);
console.log(`built ${String(cli.length + handlers.length + 1)} entry points into dist/`);
