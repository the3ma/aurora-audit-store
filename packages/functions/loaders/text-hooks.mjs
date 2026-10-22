// Node module customization hooks: import `.sql` / `.pem` files as a default-exported string, the same
// contract as esbuild's `text` loader used for the Lambda bundles.
import { readFile } from 'node:fs/promises';

const TEXT = /\.(sql|pem)$/;

export async function load(url, context, nextLoad) {
  if (!TEXT.test(new URL(url).pathname)) return nextLoad(url, context);
  const text = await readFile(new URL(url), 'utf8');
  return {
    format: 'module',
    shortCircuit: true,
    source: `export default ${JSON.stringify(text)};`,
  };
}
