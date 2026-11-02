// Bundles the watch runner into one Node file (dist-watch/watch-runner.mjs).
// src/lib/cesium.ts is swapped for a stub: the runner never draws on a globe.
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
await esbuild.build({
  entryPoints: [path.join(here, 'runner.ts')],
  outfile: path.join(here, '../../dist-watch/watch-runner.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  define: { 'import.meta.env': '{}' },
  plugins: [
    {
      name: 'no-cesium',
      setup(b) {
        b.onResolve({ filter: /(^cesium$|\/cesium$|\.css$)/ }, (a) =>
          a.path.endsWith('.css') ? { path: a.path, namespace: 'empty' } : { path: path.join(here, 'cesium-stub.ts') },
        );
        b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: '', loader: 'js' }));
      },
    },
  ],
  logLevel: 'info',
});
