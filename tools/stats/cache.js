/**
 * Record and replay for GitHub responses.
 *
 * `--record` saves every response to disk; `--replay` serves them back. That makes the
 * dashboard and the aggregations iterable with no token, no network and no rate limit, and
 * it is how the run files behind the screenshots are produced once and reused.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Wraps fetch so it can be handed to `new GitHub({ transport })`.
 *
 * @param {object} options
 * @param {string} options.dir
 * @param {'record'|'replay'} options.mode
 * @param {typeof fetch} [options.upstream]
 * @returns {{fetch: typeof fetch}}
 */
export function cachingTransport({ dir, mode, upstream = globalThis.fetch }) {
  return {
    async fetch(url, init) {
      const file = join(dir, `${keyFor(url, init)}.json`);

      if (mode === 'replay') {
        const stored = await readFile(file, 'utf8').catch(() => null);
        if (stored === null) {
          const missing = new Error(`No recorded response for ${url} (looked in ${file})`);
          // Not a transient failure: the file will not appear between attempts. Without this
          // the client reads it as a dropped connection and backs off four times, so every
          // gap in a recording costs seven seconds of a run that is supposed to be offline
          // and instant.
          missing.retryable = false;
          throw missing;
        }
        return toResponse(JSON.parse(stored));
      }

      const res = await upstream(url, init);
      const body = await res.text();
      await mkdir(dir, { recursive: true });
      await writeFile(
        file,
        JSON.stringify(
          {
            url: String(url),
            status: res.status,
            headers: Object.fromEntries(res.headers.entries()),
            body,
          },
          null,
          0,
        ),
        'utf8',
      );
      return toResponse({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body });
    },
  };
}

/** The range header is part of the identity: a head slice is not the same response as a whole log. */
function keyFor(url, init) {
  const range = init?.headers?.range ?? init?.headers?.Range ?? '';
  return createHash('sha256').update(`${url}\n${range}`).digest('hex').slice(0, 32);
}

function toResponse({ status, headers, body }) {
  // Rate-limit headers are replayed too, which would make a replay stop early once the
  // recording got close to the floor. Replays never consume quota, so they are dropped.
  const clean = { ...headers };
  delete clean['x-ratelimit-remaining'];
  return new Response(body, { status, headers: clean });
}
