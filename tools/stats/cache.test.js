import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cachingTransport } from './cache.js';
import { GitHub } from './github.js';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'stats-cache-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** An upstream that answers from a script and counts how often it was asked. */
function fakeUpstream(answers) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url: String(url), range: init?.headers?.range });
      const answer = answers[String(url)];
      if (!answer) throw new Error(`unexpected request: ${url}`);
      return new Response(answer.body, { status: answer.status ?? 200, headers: answer.headers ?? {} });
    },
  };
}

test('what is recorded is what is replayed', async () => {
  await withDir(async (dir) => {
    const upstream = fakeUpstream({
      'https://api.github.com/repos/o/r/actions/runs': {
        body: JSON.stringify({ workflow_runs: [{ id: 1 }] }),
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4321' },
      },
    });

    const recorder = cachingTransport({ dir, mode: 'record', upstream: upstream.fetch });
    const recorded = await recorder.fetch('https://api.github.com/repos/o/r/actions/runs', { headers: {} });
    assert.equal(recorded.status, 200);
    assert.deepEqual(await recorded.json(), { workflow_runs: [{ id: 1 }] });
    assert.equal(upstream.calls.length, 1);
    assert.equal((await readdir(dir)).length, 1, 'one file per response');

    const replayer = cachingTransport({ dir, mode: 'replay', upstream: upstream.fetch });
    const replayed = await replayer.fetch('https://api.github.com/repos/o/r/actions/runs', { headers: {} });
    assert.equal(replayed.status, 200);
    assert.deepEqual(await replayed.json(), { workflow_runs: [{ id: 1 }] });
    assert.equal(upstream.calls.length, 1, 'a replay never reaches the network');
  });
});

test('a replay does not inherit the recording session quota', async () => {
  await withDir(async (dir) => {
    // The recording was made near the floor, but a replay consumes nothing, so carrying the
    // header over would stop the very invocation the recording exists to make repeatable.
    const upstream = fakeUpstream({
      'https://api.github.com/x': { body: '{}', headers: { 'x-ratelimit-remaining': '7' } },
    });
    await cachingTransport({ dir, mode: 'record', upstream: upstream.fetch }).fetch('https://api.github.com/x', {});

    const transport = cachingTransport({ dir, mode: 'replay', upstream: upstream.fetch });
    const replayed = await transport.fetch('https://api.github.com/x', {});
    assert.equal(replayed.headers.get('x-ratelimit-remaining'), null);

    // End to end: a client with a floor of 300 would refuse the second request if it
    // believed 7 requests were left.
    const github = new GitHub({ rateFloor: 300, transport, token: 'x' });
    await github.json('/x');
    await github.json('/x');
    assert.equal(github.requestCount, 2);
  });
});

test('a head slice and a whole log are different recordings', async () => {
  await withDir(async (dir) => {
    // The collector reads a 64 KB head of one job and the whole log of another. They share a
    // URL, so keying on the URL alone would replay the truncated one as though it were whole.
    const upstream = fakeUpstream({
      'https://api.github.com/logs': { body: 'WHOLE LOG' },
    });
    const recorder = cachingTransport({ dir, mode: 'record', upstream: upstream.fetch });
    await recorder.fetch('https://api.github.com/logs', { headers: { range: 'bytes=0-65535' } });
    await recorder.fetch('https://api.github.com/logs', { headers: {} });

    assert.equal((await readdir(dir)).length, 2);

    const replayer = cachingTransport({ dir, mode: 'replay', upstream: upstream.fetch });
    const head = await replayer.fetch('https://api.github.com/logs', { headers: { range: 'bytes=0-65535' } });
    assert.equal(await head.text(), 'WHOLE LOG');
  });
});

test('a missing recording says which request it was', async () => {
  await withDir(async (dir) => {
    const replayer = cachingTransport({ dir, mode: 'replay' });
    await assert.rejects(
      () => replayer.fetch('https://api.github.com/never-recorded', {}),
      /No recorded response for https:\/\/api\.github\.com\/never-recorded/,
    );
  });
});

test('a non-2xx answer is recorded and replayed as itself', async () => {
  await withDir(async (dir) => {
    // 410 is how an expired log arrives, and the collector has to see it to know the run is
    // past the 90 day retention rather than broken.
    const upstream = fakeUpstream({ 'https://api.github.com/gone': { body: 'Gone', status: 410 } });
    await cachingTransport({ dir, mode: 'record', upstream: upstream.fetch }).fetch('https://api.github.com/gone', {});

    const replayed = await cachingTransport({ dir, mode: 'replay' }).fetch('https://api.github.com/gone', {});
    assert.equal(replayed.status, 410);
  });
});

test('a missing recording fails at once rather than after four retries', async () => {
  await withDir(async (dir) => {
    // A replay is meant to be offline and instant. Reading the miss as a dropped connection
    // made every gap in a recording cost seven seconds of backoff for a file that was never
    // going to appear.
    const transport = cachingTransport({ dir, mode: 'replay' });
    const github = new GitHub({ rateFloor: 0, transport, token: 'x' });

    const started = Date.now();
    await assert.rejects(() => github.json('/never-recorded'), /No recorded response/);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms, so it was retried`);
  });
});
