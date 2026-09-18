import { createReadStream, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Where `npm run collect` and `npm run aggregate` leave a locally built site. */
const LOCAL_DATA = join(HERE, '.local/site/data');

/**
 * Serves the locally generated dataset under /data during `npm run dev`.
 *
 * The page fetches ./data/dataset.json, which in a real deployment sits beside index.html on
 * the stats branch. Without this the dev server would have nothing to answer with, and the
 * whole point of `npm run dev` is editing a component against real numbers without
 * re-running the aggregator to see the change.
 */
function localDataset(): Plugin {
  return {
    name: 'stats-local-dataset',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/data', (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
        const file = join(LOCAL_DATA, rel);
        if (!file.startsWith(LOCAL_DATA) || !existsSync(file)) {
          res.statusCode = 404;
          res.end(
            `No local dataset at ${LOCAL_DATA}. Run \`npm run collect\` or \`npm run aggregate\` first.`,
          );
          return next;
        }
        res.setHeader('content-type', 'application/json; charset=utf-8');
        createReadStream(file).pipe(res);
        return undefined;
      });
    },
  };
}

export default defineConfig({
  root: 'ui',
  // Relative, because GitHub Pages serves the site from /site on the stats branch rather
  // than from a domain root.
  base: './',
  plugins: [vue(), localDataset()],
  build: {
    outDir: '../dist-site',
    emptyOutDir: true,
    // One page, no code splitting to gain from, and the aggregator copies whatever is here.
    chunkSizeWarningLimit: 1024,
  },
});
