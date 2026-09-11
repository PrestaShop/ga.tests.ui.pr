#!/usr/bin/env node
/**
 * Serves a generated site directory. Only here so the dashboard can be looked at without
 * installing anything: opening index.html from the filesystem does not work, because the
 * page loads its data with fetch and imports ES modules, both of which browsers refuse
 * over file://.
 *
 *   node tools/stats/serve.mjs .local/site [port]
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.argv[2] ?? './site';
const port = Number(process.argv[3] ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const requested = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // Keep the server inside the directory it was pointed at.
  const relative = normalize(requested === '/' ? '/index.html' : requested).replace(/^(\.\.[/\\])+/, '');
  const path = join(root, relative);

  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, () => {
  console.log(`Serving ${root} at http://localhost:${port}/  (ctrl+c to stop)`);
});
