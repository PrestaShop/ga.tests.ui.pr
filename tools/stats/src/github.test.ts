import { test } from 'vitest';
import assert from 'node:assert/strict';

import { GitHub, RateLimitReached, nextPageUrl, type Transport } from './github.js';

/** One scripted answer: a canned response, or a function for the awkward cases. */
type Scripted =
  | { status?: number; body?: string | object; headers?: Record<string, string> }
  | ((url: string) => Response | Promise<Response>);

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A transport that answers from a scripted list and records what was asked for. */
function fakeTransport(responses: Scripted[]): { calls: Call[]; transport: Transport } {
  const calls: Call[] = [];
  return {
    calls,
    transport: {
      async fetch(url, init) {
        calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
        const next = responses.shift();
        if (!next) throw new Error(`No scripted response for ${String(url)}`);
        if (typeof next === 'function') return next(String(url));
        const { status = 200, body = '{}', headers = {} } = next;
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
      },
    },
  };
}

test('a response without rate-limit headers does not look like an exhausted quota', async () => {
  // Regression: Number(null) and Number('') are both 0, so a missing header used to stop
  // the whole invocation after the first request.
  const { transport } = fakeTransport([
    { body: { workflow_runs: [] } },
    { body: { workflow_runs: [] } },
    { body: { workflow_runs: [] } },
  ]);
  const gh = new GitHub({ token: 't', transport });

  await gh.listDispatchRuns('o/r');
  await gh.listDispatchRuns('o/r');
  await gh.listDispatchRuns('o/r');

  assert.equal(gh.remaining, Infinity);
  assert.equal(gh.requestCount, 3);
});

test('the rate-limit floor stops further requests', async () => {
  const { transport } = fakeTransport([
    { body: {}, headers: { 'x-ratelimit-remaining': '305' } },
    { body: {}, headers: { 'x-ratelimit-remaining': '299' } },
  ]);
  const gh = new GitHub({ token: 't', rateFloor: 300, transport });

  await gh.json('/first');
  await gh.json('/second');
  await assert.rejects(() => gh.json('/third'), RateLimitReached);
});

test('pagination follows the Link header and stops at the last page', async () => {
  const { transport, calls } = fakeTransport([
    { body: { jobs: [{ id: 1 }, { id: 2 }] }, headers: { link: '<https://api.github.com/page2>; rel="next"' } },
    { body: { jobs: [{ id: 3 }] } },
  ]);
  const gh = new GitHub({ token: 't', transport });

  const jobs = await gh.listRunJobs('o/r', 42);
  assert.deepEqual(jobs.map((j) => j.id), [1, 2, 3]);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /filter=all/, 'every attempt must be requested, not just the latest');
  assert.equal(calls[1].url, 'https://api.github.com/page2');
});

test('an endpoint returning a bare array paginates too', async () => {
  const { transport } = fakeTransport([
    { body: [{ full_name: 'a/x' }], headers: { link: '<https://api.github.com/f2>; rel="next"' } },
    { body: [{ full_name: 'b/x' }] },
  ]);
  const gh = new GitHub({ token: 't', transport });
  assert.deepEqual(await gh.listForks('o/r'), ['a/x', 'b/x']);
});

test('a repository with Actions disabled is skipped, not fatal', async () => {
  const { transport } = fakeTransport([{ status: 404, body: { message: 'Not Found' } }]);
  const gh = new GitHub({ token: 't', transport });
  assert.equal(await gh.listDispatchRuns('private/repo'), null);
});

test('an expired log reads as null rather than an error', async () => {
  const { transport, calls } = fakeTransport([{ status: 410, body: 'Gone' }]);
  const gh = new GitHub({ token: 't', transport });

  assert.equal(await gh.getJobLog('o/r', 1, { bytes: 1024 }), null);
  assert.equal(calls[0].headers.range, 'bytes=0-1023', 'only the head of the log is fetched');
});

test('a transient failure is retried instead of losing the invocation', async () => {
  let attempts = 0;
  const transport = {
    async fetch() {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return new Response('{"ok":true}', { status: 200 });
    },
  };
  const gh = new GitHub({ token: 't', transport });

  // Backoff would make this slow, so shorten it by retrying directly with 2 attempts left.
  const res = await gh.fetchWithRetry('https://api.github.com/x', {}, 4);
  assert.equal(res.status, 200);
  assert.equal(attempts, 3);
});

test('a deliberate 404 is returned immediately, not retried', async () => {
  let attempts = 0;
  const gh = new GitHub({
    token: 't',
    transport: {
      async fetch() {
        attempts += 1;
        return new Response('{}', { status: 404 });
      },
    },
  });

  const res = await gh.fetchWithRetry('https://api.github.com/x', {}, 4);
  assert.equal(res.status, 404);
  assert.equal(attempts, 1);
});

test('the next page URL is read out of the Link header', () => {
  assert.equal(nextPageUrl('<https://a/2>; rel="next", <https://a/9>; rel="last"'), 'https://a/2');
  assert.equal(nextPageUrl('<https://a/9>; rel="last"'), null);
  assert.equal(nextPageUrl(null), null);
  assert.equal(nextPageUrl(''), null);
});

test('the token is sent, and omitted when there is none', async () => {
  const { transport, calls } = fakeTransport([{ body: {} }, { body: {} }]);
  await new GitHub({ token: 'secret', transport }).json('/a');
  assert.equal(calls[0].headers.authorization, 'Bearer secret');

  await new GitHub({ token: undefined, transport }).json('/b');
  assert.equal(calls[1].headers.authorization, undefined);
});
