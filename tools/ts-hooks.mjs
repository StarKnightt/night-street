/* Resolve extensionless relative imports to .ts, for Node's type stripper.
 *
 * Node runs TypeScript directly now, but it is still an ESM resolver, and ESM
 * does not guess extensions. `import { x } from './dsp'` — which is how the
 * application code has to be written, because that is what the bundler
 * expects — therefore fails to resolve under bare Node. Twelve lines of
 * resolve hook lets tools/audiograph.mjs load the real engine module rather
 * than a copy of it, which is the entire point of that tool.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* The bundler's `@/` alias, which resolves to src/. Nothing in ESM knows about
 * tsconfig paths, so a module that imports `@/world/dims` — as every file in
 * src/scene does — cannot be loaded by a tool without this. */
const SRC = pathToFileURL(path.resolve(import.meta.dirname, '..', 'src') + path.sep).href;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    return resolve(SRC + specifier.slice(2), context, next);
  }
  if ((specifier.startsWith('.') || specifier.startsWith('file:')) && !/\.[a-z]+$/i.test(specifier)) {
    try { return await next(`${specifier}.ts`, context); } catch { /* fall through */ }
    try { return await next(`${specifier}.tsx`, context); } catch { /* fall through */ }
  }
  return next(specifier, context);
}
