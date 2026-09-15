import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store, readJson, writeJson } from './store.js';
import type { RunFile } from './types.js';

/** A stored run file. Only the index fields matter here, but the file is a whole one. */
const storedRun = (id: number, attempt: number, status = 'completed'): RunFile => ({
  repo: 'someone/ga.tests.ui.pr',
  owner: 'someone',
  run_id: id,
  run_attempt: attempt,
  workflow: 'pr_test_one.yml',
  status,
  created_at: '2026-09-10T10:00:00Z',
  html_url: `https://github.com/someone/ga.tests.ui.pr/actions/runs/${id}`,
  is_security: false,
  aborted: false,
  pr_number: null,
  db: null,
  branch_key: 'develop',
  branch_key_source: 'job-name',
  executions: [],
});

/** Runs `fn` against a throwaway data directory. */
async function withStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'stats-store-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the index decides what still needs processing', async () => {
  await withStore(async (dir) => {
    const store = await new Store(dir).load();
    const repo = 'someone/ga.tests.ui.pr';

    const run = { id: 7, run_attempt: 2, status: 'completed' };
    assert.equal(store.isUpToDate(repo, run), false, 'never seen');

    await store.saveRun(repo, storedRun(7, 2));
    assert.equal(store.isUpToDate(repo, run), true);

    // A retry landed after it was stored: this is the case a watermark would miss, since
    // re-running does not change created_at and the run never returns to the top of the list.
    assert.equal(store.isUpToDate(repo, { ...run, run_attempt: 3 }), false);

    // It was stored while still running, and has finished since.
    await store.saveRun(repo, storedRun(8, 1, 'in_progress'));
    assert.equal(store.isUpToDate(repo, { id: 8, run_attempt: 1, status: 'completed' }), false);

    // Reloading from disk keeps every decision the same.
    await store.saveIndex();
    const reloaded = await new Store(dir).load();
    assert.equal(reloaded.isUpToDate(repo, run), true);
    assert.equal(reloaded.isUpToDate(repo, { ...run, run_attempt: 3 }), false);

    const stored: number[] = [];
    for await (const r of reloaded.allRuns()) stored.push(r.run_id);
    assert.deepEqual(stored.sort(), [7, 8]);
  });
});

test('the pull request cache survives a reload', async () => {
  await withStore(async (dir) => {
    const store = await new Store(dir).load();
    assert.equal(store.getPr(42816), null);

    store.setPr(42816, { base_ref: '9.2.x' });
    await store.saveIndex();

    const reloaded = await new Store(dir).load();
    assert.deepEqual(reloaded.getPr(42816), { base_ref: '9.2.x' });
    assert.deepEqual(reloaded.getPr('42816'), { base_ref: '9.2.x' }, 'number or string, same entry');
  });
});

test('an empty data directory yields no runs rather than an error', async () => {
  await withStore(async (dir) => {
    const store = await new Store(dir).load();
    const runs: RunFile[] = [];
    for await (const r of store.allRuns()) runs.push(r);
    assert.deepEqual(runs, []);
  });
});

test('a write is never visible half-finished', async () => {
  await withStore(async (dir) => {
    const path = join(dir, 'index.json');
    await writeJson(path, { runs: { old: 1 } });

    // `writeFile` truncates the target before writing, so an interrupted write used to leave
    // a zero-length or partial file behind, and `readJson` forgives only a missing one. The
    // collector would then throw on every later invocation until somebody deleted it by hand.
    // Writing beside the target and renaming means the file is either the old one or the new
    // one, never something in between.
    const tmp = `${path}.tmp`;
    assert.equal(await readFile(tmp, 'utf8').catch(() => null), null, 'no temporary file is left behind');

    // Simulate the interrupted write: a stray temporary from a killed invocation must not
    // affect what is read back, and must not be mistaken for a run file.
    await writeFile(tmp, '{"runs": {"hal', 'utf8');
    assert.deepEqual(await readJson(path), { runs: { old: 1 } }, 'the committed file is intact');

    await writeJson(path, { runs: { new: 2 } });
    assert.deepEqual(await readJson(path), { runs: { new: 2 } });
  });
});

test('a torn file is an error rather than a silent empty index', async () => {
  await withStore(async (dir) => {
    // If one ever does turn up, losing it quietly would mean recollecting the entire history
    // as though nothing had been stored. Better to stop and say so.
    await writeFile(join(dir, 'index.json'), '{"runs": {"a/b#1"', 'utf8');
    await assert.rejects(() => new Store(dir).load(), /JSON/);
  });
});

test('stray temporary files are not read back as runs', async () => {
  await withStore(async (dir) => {
    const store = await new Store(dir).load();
    await store.saveRun('someone/ga.tests.ui.pr', storedRun(1, 1));
    await writeFile(join(dir, 'runs', 'someone', '2.json.tmp'), '{"run_id": 2, "half', 'utf8');

    const seen = [];
    for await (const r of store.allRuns()) seen.push(r.run_id);
    assert.deepEqual(seen, [1]);
  });
});

test('run files stay diffable and the dataset does not', async () => {
  await withStore(async (dir) => {
    const value = { v: 1, runs: [[1, 2, 3], [4, 5, 6]] };

    await writeJson(join(dir, 'pretty.json'), value);
    const pretty = await readFile(join(dir, 'pretty.json'), 'utf8');
    assert.ok(pretty.includes('\n  '), 'a run file is indented, because its diffs get read');

    // The dataset is dictionary-packed columnar arrays downloaded whole by every visitor and
    // re-committed daily. Indenting puts every integer on its own line and triples the size
    // of the one thing the packing exists to keep small, for a diff nobody can read anyway.
    await writeJson(join(dir, 'packed.json'), value, { pretty: false });
    const packed = await readFile(join(dir, 'packed.json'), 'utf8');
    assert.equal(packed, `${JSON.stringify(value)}\n`);
    assert.ok(packed.length * 2 < pretty.length);
    assert.deepEqual(JSON.parse(packed), JSON.parse(pretty), 'same content either way');
  });
});
