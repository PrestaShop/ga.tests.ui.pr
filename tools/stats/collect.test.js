import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isTestWorkflow, isFinal, TEST_WORKFLOWS } from './collect.js';
import { Store } from './store.js';

test('only the UI test workflows are collected', () => {
  for (const file of TEST_WORKFLOWS) {
    assert.equal(isTestWorkflow({ path: `.github/workflows/${file}` }), true, file);
  }
  assert.equal(isTestWorkflow({ path: '.github/workflows/auto_retry_failed_jobs.yml' }), false);
  assert.equal(isTestWorkflow({ path: '.github/workflows/stats.yml' }), false);
  assert.equal(isTestWorkflow({}), false);
});

test('a run is final once it is green, capped, or simply old', () => {
  const now = Date.parse('2026-09-11T12:00:00Z');
  const base = { status: 'completed', updated_at: '2026-09-11T11:00:00Z' };

  assert.equal(isFinal({ ...base, conclusion: 'success', run_attempt: 1 }, now), true);
  assert.equal(isFinal({ ...base, conclusion: 'failure', run_attempt: 6 }, now), true, 'the auto-retry cap');
  assert.equal(isFinal({ ...base, conclusion: 'failure', run_attempt: 2 }, now), false, 'a retry may still come');
  assert.equal(
    isFinal({ status: 'completed', conclusion: 'failure', run_attempt: 2, updated_at: '2026-09-01T00:00:00Z' }, now),
    true,
    'left alone for days',
  );
  assert.equal(isFinal({ status: 'in_progress', conclusion: null, run_attempt: 1 }, now), false);
});

test('the index decides what still needs processing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stats-store-'));
  try {
    const store = await new Store(dir).load();
    const repo = 'someone/ga.tests.ui.pr';

    const run = { id: 7, run_attempt: 2, status: 'completed' };
    assert.equal(store.isUpToDate(repo, run), false, 'never seen');

    await store.saveRun(repo, { run_id: 7, run_attempt: 2, status: 'completed', executions: [] });
    assert.equal(store.isUpToDate(repo, run), true);

    // A retry landed after it was stored: this is the case a watermark would miss, since
    // re-running does not change created_at and the run never returns to the top of the list.
    assert.equal(store.isUpToDate(repo, { ...run, run_attempt: 3 }), false);

    // It was stored while still running, and has finished since.
    await store.saveRun(repo, { run_id: 8, run_attempt: 1, status: 'in_progress', executions: [] });
    assert.equal(store.isUpToDate(repo, { id: 8, run_attempt: 1, status: 'completed' }), false);

    // Reloading from disk keeps every decision the same.
    await store.saveIndex();
    const reloaded = await new Store(dir).load();
    assert.equal(reloaded.isUpToDate(repo, run), true);
    assert.equal(reloaded.isUpToDate(repo, { ...run, run_attempt: 3 }), false);

    const stored = [];
    for await (const r of reloaded.allRuns()) stored.push(r.run_id);
    assert.deepEqual(stored.sort(), [7, 8]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the pull request cache survives a reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stats-store-'));
  try {
    const store = await new Store(dir).load();
    assert.equal(store.getPr(42816), null);

    store.setPr(42816, { base_ref: '9.2.x' });
    await store.saveIndex();

    const reloaded = await new Store(dir).load();
    assert.deepEqual(reloaded.getPr(42816), { base_ref: '9.2.x' });
    assert.deepEqual(reloaded.getPr('42816'), { base_ref: '9.2.x' }, 'number or string, same entry');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty data directory yields no runs rather than an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stats-store-'));
  try {
    const store = await new Store(dir).load();
    const runs = [];
    for await (const r of store.allRuns()) runs.push(r);
    assert.deepEqual(runs, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
