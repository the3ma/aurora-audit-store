import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// Same contract as esbuild's `text` loader in the Lambda bundles: .sql/.pem import as a string.
const textFiles: Plugin = {
  name: 'text-files',
  enforce: 'pre',
  async load(id) {
    if (!/\.(sql|pem)$/.test(id)) return null;
    return `export default ${JSON.stringify(await readFile(id, 'utf8'))};`;
  },
};

export default defineConfig({
  plugins: [textFiles],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.int.test.ts'],
          globalSetup: ['packages/core/test/support/integration-setup.ts'],
          // Login roles are cluster-wide, so integration files must not run concurrently.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
