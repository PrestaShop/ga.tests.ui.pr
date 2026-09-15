import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collect, isTestWorkflow, isFinal, TEST_WORKFLOWS, type CollectOptions } from './collect.js';
import type { JobRow } from './executions.js';
import { RateLimitReached, type GitHub, type WorkflowRun } from './github.js';
import { Store } from './store.js';
import type { RunFile } from './types.js';

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

/**
 * A GitHub the tests can steer. Only the five methods `collect()` calls are implemented, and
 * each one can be told to fail, so the paths that only appear when something goes wrong —
 * which is where the isolation and the index flushing live — can be driven deliberately.
 */
interface FakeOptions {
  forks?: string[];
  /** repo -> run rows, or null for "unreadable" */
  runs?: Record<string, WorkflowRun[] | null>;
  /** run id -> job rows */
  jobs?: Record<number, JobRow[]>;
  /** repo -> Error to throw when listing */
  failRepos?: Record<string, Error>;
  /** run id -> Error to throw when reading jobs */
  failRuns?: Record<number, Error>;
}

class FakeGitHub {
  readonly forks: string[];
  readonly runs: Record<string, WorkflowRun[] | null>;
  readonly jobs: Record<number, JobRow[]>;
  readonly failRepos: Record<string, Error>;
  readonly failRuns: Record<number, Error>;
  requestCount = 0;
  readonly seenRuns: number[] = [];
  onListJobs: ((runId: number) => Promise<void>) | null = null;

  constructor({ forks = [], runs = {}, jobs = {}, failRepos = {}, failRuns = {} }: FakeOptions = {}) {
    this.forks = forks;
    this.runs = runs;
    this.jobs = jobs;
    this.failRepos = failRepos;
    this.failRuns = failRuns;
  }

  async listForks(): Promise<string[]> {
    return this.forks;
  }

  async listDispatchRuns(repo: string): Promise<WorkflowRun[] | null> {
    this.requestCount += 1;
    const failure = this.failRepos[repo];
    if (failure) throw failure;
    return this.runs[repo] ?? null;
  }

  async listRunJobs(_repo: string, runId: number): Promise<JobRow[]> {
    this.requestCount += 1;
    this.seenRuns.push(runId);
    await this.onListJobs?.(runId);
    const failure = this.failRuns[runId];
    if (failure) throw failure;
    return this.jobs[runId] ?? [];
  }

  async getJobLog(): Promise<string | null> {
    return null;
  }

  async getPullRequest(): Promise<null> {
    return null;
  }
}

/** A completed `pr_test_one.yml` run row. */
const runRow = (id: number, extra: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  run_number: id,
  run_attempt: 1,
  path: '.github/workflows/pr_test_one.yml',
  status: 'completed',
  conclusion: 'success',
  created_at: `2026-09-${String((id % 28) + 1).padStart(2, '0')}T10:00:00Z`,
  updated_at: `2026-09-${String((id % 28) + 1).padStart(2, '0')}T11:00:00Z`,
  html_url: `https://github.com/o/r/actions/runs/${id}`,
  ...extra,
});

/** One green campaign job, which is all `toExecutions` needs to produce an execution. */
const jobRows = (id: number, name = 'test (audit, develop)'): JobRow[] => [
  {
    id: id * 10,
    run_attempt: 1,
    name,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-09-10T11:58:23Z',
    completed_at: '2026-09-10T12:06:03Z',
    html_url: `https://github.com/o/r/actions/runs/${id}/job/${id * 10}`,
  },
];

async function withStore<T>(fn: (dir: string, store: Store) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'stats-collect-'));
  try {
    return await fn(dir, await new Store(dir).load());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const REPO = 'someone/ga.tests.ui.pr';

/** A stored run file, for seeding the index before a collection. */
const storedRun = (id: number, attempt: number): RunFile => ({
  repo: REPO,
  owner: REPO.split('/')[0]!,
  run_id: id,
  run_attempt: attempt,
  workflow: 'pr_test_one.yml',
  status: 'completed',
  created_at: '2026-09-10T10:00:00Z',
  html_url: `https://github.com/${REPO}/actions/runs/${id}`,
  is_security: false,
  aborted: false,
  pr_number: null,
  db: null,
  branch_key: 'develop',
  branch_key_source: 'job-name',
  executions: [],
});
const collectFrom = (github: FakeGitHub, store: Store, extra: Partial<CollectOptions> = {}) =>
  collect({
    github: github as unknown as GitHub,
    store,
    repos: [REPO],
    withLogs: false,
    withTests: false,
    ...extra,
  });

test('only what is new or has gained an attempt is queued', async () => {
  await withStore(async (_dir, store) => {
    const github = new FakeGitHub({
      runs: {
        [REPO]: [
          runRow(1),
          runRow(2, { run_attempt: 2 }),
          runRow(3, { status: 'in_progress', conclusion: null }),
          { ...runRow(4), path: '.github/workflows/auto_retry_failed_jobs.yml' },
        ],
      },
      jobs: { 1: jobRows(1), 2: jobRows(2) },
    });

    // Run 1 is already stored at this attempt; run 2 is stored a retry behind.
    await store.saveRun(REPO, storedRun(1, 1));
    await store.saveRun(REPO, storedRun(2, 1));

    const stats = await collectFrom(github, store);

    assert.equal(stats.runsListed, 3, 'the retry workflow is not a test campaign');
    assert.equal(stats.runsQueued, 1, 'run 1 is current, run 3 is unfinished');
    assert.deepEqual(github.seenRuns, [2]);
    assert.equal(stats.runsProcessed, 1);
    assert.equal(stats.executions, 1);
    assert.equal(stats.runsFailed, 0);
  });
});

test('the cap limits what is processed, not what is listed, newest first', async () => {
  await withStore(async (_dir, store) => {
    const rows = [1, 2, 3, 4, 5].map((id) => runRow(id, { created_at: `2026-09-0${id}T10:00:00Z` }));
    const github = new FakeGitHub({
      runs: { [REPO]: rows },
      jobs: Object.fromEntries(rows.map((r) => [r.id, jobRows(r.id)])),
    });

    const stats = await collectFrom(github, store, { maxRuns: 2 });

    assert.equal(stats.runsListed, 5);
    assert.equal(stats.runsQueued, 5, 'the whole diff is known, so the backlog is reportable');
    assert.equal(stats.runsProcessed, 2);
    assert.deepEqual(github.seenRuns, [5, 4], 'fresh data lands before a long backfill drains');
  });
});

test('one run that throws does not strand the rest of the queue', async () => {
  await withStore(async (_dir, store) => {
    const rows = [1, 2, 3].map((id) => runRow(id, { created_at: `2026-09-0${id}T10:00:00Z` }));
    const github = new FakeGitHub({
      runs: { [REPO]: rows },
      jobs: Object.fromEntries(rows.map((r) => [r.id, jobRows(r.id)])),
      failRuns: { 2: new Error('GitHub 502 on /jobs') },
    });

    const stats = await collectFrom(github, store);

    // The queue is newest first, so unwinding here would keep fresh runs flowing while every
    // older run stalled behind the same broken one for good.
    assert.equal(stats.runsProcessed, 2);
    assert.equal(stats.runsFailed, 1);
    assert.deepEqual(github.seenRuns, [3, 2, 1], 'run 1 was still reached');
    assert.deepEqual(stats.failures, [{ repo: REPO, run_id: 2, message: 'GitHub 502 on /jobs' }]);

    const stored = [];
    for await (const r of store.allRuns()) stored.push(r.run_id);
    assert.deepEqual(stored.sort(), [1, 3]);
  });
});

test('hitting the rate-limit floor stops everything and keeps what was written', async () => {
  await withStore(async (dir, store) => {
    const rows = [1, 2, 3].map((id) => runRow(id, { created_at: `2026-09-0${id}T10:00:00Z` }));
    const github = new FakeGitHub({
      runs: { [REPO]: rows },
      jobs: Object.fromEntries(rows.map((r) => [r.id, jobRows(r.id)])),
      failRuns: { 2: new RateLimitReached(12) },
    });

    const stats = await collectFrom(github, store);

    assert.equal(stats.rateLimited, true);
    assert.equal(stats.runsProcessed, 1, 'nothing further could have succeeded');
    assert.equal(stats.runsFailed, 0, 'a quota stop is not a broken run');
    assert.deepEqual(github.seenRuns, [3, 2]);

    // Everything already written stays written, and the index records it, so the next
    // invocation resumes instead of starting over.
    const reloaded = await new Store(dir).load();
    assert.equal(reloaded.isUpToDate(REPO, { id: 3, run_attempt: 1, status: 'completed' }), true);
    assert.equal(reloaded.isUpToDate(REPO, { id: 2, run_attempt: 1, status: 'completed' }), false);
  });
});

test('the index reaches disk before the queue is finished', async () => {
  await withStore(async (dir, store) => {
    const rows = Array.from({ length: 30 }, (_, i) => runRow(i + 1));
    const github = new FakeGitHub({
      runs: { [REPO]: rows },
      jobs: Object.fromEntries(rows.map((r) => [r.id, jobRows(r.id)])),
    });

    // Flushing only at the end survives a throw but not SIGKILL, an OOM kill or the
    // `timeout-minutes` the workflow sets on exactly the long backfill invocations. Reading
    // the index from disk part-way through is what a next invocation would see after one.
    let seenPartWay: number | null = null;
    github.onListJobs = async () => {
      if (github.seenRuns.length === 28 && seenPartWay === null) {
        seenPartWay = Object.keys((await new Store(dir).load()).index.runs).length;
      }
    };

    const stats = await collectFrom(github, store);

    assert.equal(stats.runsProcessed, 30);
    assert.equal(seenPartWay, 25, 'a kill at run 28 would cost 2 runs, not all 27');
    assert.equal(Object.keys((await new Store(dir).load()).index.runs).length, 30);
  });
});

test('a repository that cannot be read and one that failed are counted apart', async () => {
  await withStore(async (_dir, store) => {
    const github = new FakeGitHub({
      runs: {
        'a/r': [runRow(1)],
        'b/r': null, //                          404 or 403: private, deleted, Actions off
        'd/r': [runRow(4)],
      },
      jobs: { 1: jobRows(1), 4: jobRows(4) },
      failRepos: { 'c/r': new Error('GitHub 502 on /runs') },
    });

    const stats = await collect({
      github: github as unknown as GitHub,
      store,
      repos: ['a/r', 'b/r', 'c/r', 'd/r'],
      withLogs: false,
      withTests: false,
    });

    assert.equal(stats.repos, 2);
    assert.equal(stats.reposUnreadable, 1, 'deliberately closed, and expected');
    assert.equal(stats.reposErrored, 1, 'a transport failure, which means data is missing');
    assert.equal(stats.runsProcessed, 2, 'the scan carried on past the broken one');
    assert.deepEqual(stats.failures, [{ repo: 'c/r', message: 'GitHub 502 on /runs' }]);
  });
});

test('a workflow rename surfaces as job names rather than as aborted runs', async () => {
  await withStore(async (_dir, store) => {
    const github = new FakeGitHub({
      runs: { [REPO]: [runRow(1)] },
      jobs: { 1: jobRows(1, 'run the campaign [audit]') },
    });

    const stats = await collectFrom(github, store);

    assert.deepEqual(stats.unclassifiedJobNames, ['run the campaign [audit]']);
    const runs = [];
    for await (const r of store.allRuns()) runs.push(r);
    const [stored] = runs;
    assert.deepEqual(stored.executions, []);
    assert.equal(stored.aborted, true, 'which is why the names have to come out with it');
    assert.deepEqual(stored.unclassified_job_names, ['run the campaign [audit]']);
  });
});
