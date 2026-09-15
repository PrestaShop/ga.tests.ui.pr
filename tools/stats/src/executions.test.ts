import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { classifyJob, executionKey, failureKind, toExecutions, durationSeconds, type JobRow } from './executions.js';

interface JobsFixture {
  _note: string;
  run_id: number;
  repo: string;
  jobs: JobRow[];
}

const fixture = (name: string): JobsFixture =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')) as JobsFixture;

const RETRIED_RUN = fixture('jobs-34473576823.json'); // 3 attempts, current job names
const LEGACY_RUN = fixture('jobs-24509737743.json'); //  1 attempt, legacy names carrying the branch
const PREBUILT_RUN = fixture('jobs-32371081746.json'); // pr_test.yml, nested reusable names
const SECURITY_RUN = fixture('jobs-21282045781.json'); // pr_security_test_one.yml, prefixed names

test('job names are classified across every workflow generation', () => {
  assert.deepEqual(classifyJob('test (functional:API)'), { kind: 'campaign', campaign: 'functional:API' });
  assert.deepEqual(classifyJob('test (audit, develop)'), {
    kind: 'campaign',
    campaign: 'audit',
    branch: 'develop',
  });
  assert.deepEqual(classifyJob('Long functional:BO:design / Test functional:BO:design'), {
    kind: 'campaign',
    campaign: 'functional:BO:design',
  });
  assert.deepEqual(classifyJob('Run short campaign audit / Test audit'), {
    kind: 'campaign',
    campaign: 'audit',
  });
  // `Sanity campaign / Test` carries no campaign in the inner name.
  assert.deepEqual(classifyJob('Sanity campaign / Test'), { kind: 'campaign', campaign: 'sanity' });

  assert.equal(classifyJob('Resolve PR context / Resolve PR + PrestaShop version').kind, 'prep');
  assert.equal(classifyJob('Resolve PR + PrestaShop version').kind, 'prep');
  assert.equal(classifyJob('Prebuild shop and export artifacts / Build shop artifacts').kind, 'build-shop');
  assert.equal(classifyJob('').kind, 'other');
});

test('a retried run is deduped to the executions that really happened', () => {
  const { executions, rawRows, maxAttempt } = toExecutions(RETRIED_RUN.jobs);

  // The headline guard: the API hands back 138 rows for 51 real executions.
  assert.equal(rawRows, 138);
  assert.equal(maxAttempt, 3);
  // 51 rows minus the prep job, which is not a campaign.
  assert.equal(executions.length, 50);

  const perAttempt = executions.reduce<Record<number, number>>((acc, e) => {
    acc[e.attempt] = (acc[e.attempt] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(perAttempt, { 1: 45, 2: 3, 3: 2 });
});

test('a campaign carried over across attempts is counted once, in the attempt it ran', () => {
  const { executions } = toExecutions(RETRIED_RUN.jobs);
  const login = executions.filter((e) => e.campaign === 'functional:BO:login');

  assert.equal(login.length, 1, 'passed on attempt 1 and was never re-run');
  assert.equal(login[0].attempt, 1);
  assert.equal(login[0].conclusion, 'success');
  assert.equal(login[0].started_at, '2026-09-10T11:58:23Z');
});

test('a campaign that failed then passed is kept as separate executions', () => {
  const { executions } = toExecutions(RETRIED_RUN.jobs);

  const api = executions.filter((e) => e.campaign === 'functional:API');
  assert.deepEqual(
    api.map((e) => [e.attempt, e.conclusion]),
    [
      [1, 'failure'],
      [2, 'success'],
    ],
  );

  // Failed twice before going green: the shape that makes a campaign look flaky.
  const catalog = executions.filter((e) => e.campaign === 'functional:BO:catalog:03-04');
  assert.deepEqual(
    catalog.map((e) => [e.attempt, e.conclusion]),
    [
      [1, 'failure'],
      [2, 'failure'],
      [3, 'success'],
    ],
  );
});

test('the run totals match what the Actions UI shows', () => {
  const { executions } = toExecutions(RETRIED_RUN.jobs);
  const failed = (attempt: number) =>
    executions.filter((e) => e.attempt === attempt && e.conclusion === 'failure').length;

  assert.equal(failed(1), 3);
  assert.equal(failed(2), 2);
  assert.equal(failed(3), 0);

  // Counting raw rows instead would claim 5 failures out of 138 (3.6%) rather than
  // 5 out of 50 (10%). This assertion is the regression guard for that.
  assert.equal(executions.filter((e) => e.conclusion === 'failure').length, 5);
});

test('failures are split between the test run and the environment', () => {
  assert.equal(failureKind({ conclusion: 'success' }), 'none');
  assert.equal(
    failureKind({ conclusion: 'failure', steps: [{ name: 'Run Tests', conclusion: 'failure' }] }),
    'test',
  );
  assert.equal(
    failureKind({
      conclusion: 'failure',
      steps: [
        { name: 'Setup Environment', conclusion: 'failure' },
        { name: 'Run Tests', conclusion: 'skipped' },
      ],
    }),
    'infra',
  );
  assert.equal(
    failureKind({
      conclusion: 'failure',
      steps: [{ name: 'Run campaign functional:API on prebuilt shop', conclusion: 'failure' }],
    }),
    'test',
  );
  assert.equal(failureKind({ conclusion: 'failure', steps: [] }), 'unknown');

  // Every failure in the retried run is a real test failure, not a broken runner.
  const { executions } = toExecutions(RETRIED_RUN.jobs);
  const kinds = new Set(executions.filter((e) => e.conclusion === 'failure').map((e) => e.failure_kind));
  assert.deepEqual([...kinds], ['test']);
});

test('legacy job names hand over the branch for free', () => {
  const { executions, branchFromJobName, maxAttempt } = toExecutions(LEGACY_RUN.jobs);

  assert.equal(branchFromJobName, 'develop');
  assert.equal(maxAttempt, 1);
  assert.equal(executions.length, 44);
  assert.ok(executions.every((e) => e.branch === 'develop'));
  assert.ok(executions.some((e) => e.campaign === 'audit'));
});

test('a prebuilt-shop run keeps only its campaign jobs', () => {
  const { executions, branchFromJobName } = toExecutions(PREBUILT_RUN.jobs);

  assert.equal(branchFromJobName, null, 'this generation resolves the branch elsewhere');
  assert.ok(executions.length > 0);
  assert.ok(
    executions.every((e) => !/^(Prebuild|Resolve)/.test(e.campaign)),
    'build-shop and prep jobs are not campaigns',
  );
  assert.ok(executions.some((e) => e.campaign === 'functional:BO:catalog:01-02'));
  assert.ok(executions.some((e) => e.campaign === 'sanity'));
});

test('a failed shop prebuild is reported so the run can be discarded', () => {
  const jobs = [
    {
      name: 'Prebuild shop and export artifacts / Build shop artifacts',
      run_attempt: 1,
      conclusion: 'failure',
      steps: [{ name: 'Build and run shop with docker', conclusion: 'failure' }],
    },
    { name: 'Long functional:BO:design / Test functional:BO:design', run_attempt: 1, conclusion: 'skipped' },
  ];
  const { buildShopFailed, executions } = toExecutions(jobs);

  assert.equal(buildShopFailed, true);
  assert.equal(executions.length, 1, 'the campaign row exists but never ran');
  assert.equal(executions[0].conclusion, 'skipped');
});

test('duration is null while a job is unfinished', () => {
  assert.equal(durationSeconds({ started_at: '2026-09-10T11:58:23Z', completed_at: '2026-09-10T12:06:03Z' }), 460);
  assert.equal(durationSeconds({ started_at: '2026-09-10T11:58:23Z' }), null);
  assert.equal(durationSeconds({}), null);
});

test('empty and malformed input do not throw', () => {
  assert.deepEqual(toExecutions([]).executions, []);
  assert.deepEqual(toExecutions(undefined).executions, []);
  assert.equal(toExecutions([{}, { name: null }]).executions.length, 0);
});

test('the execution key separates its two parts with a NUL', () => {
  const key = executionKey({ name: 'test (audit)', started_at: '2026-09-10T11:58:23Z' });

  // A campaign name can contain anything a matrix value can, so the separator has to be a
  // byte that cannot appear in either half. It is spelled `\0` rather than written as a raw
  // byte: a literal NUL makes the file binary, which is how it once reached a pull request
  // as `Bin 0 -> 7295 bytes` with no diff to review, and some editors silently strip it on
  // save, which would quietly change the identity the whole dedupe rests on.
  assert.ok(key.includes('\0'), 'the separator is a NUL');
  assert.equal(key, 'test (audit)\u00002026-09-10T11:58:23Z');

  // Why a NUL and not something readable: a job name contains spaces, commas, colons and
  // parentheses, so any of those as a separator would let two different rows produce the
  // same key and be collapsed into one execution.
  for (const { jobs } of [RETRIED_RUN, LEGACY_RUN, PREBUILT_RUN, SECURITY_RUN]) {
    for (const job of jobs) {
      assert.ok(!String(job.name ?? '').includes('\0'), `a job name never contains one: ${job.name}`);
      assert.ok(!String(job.started_at ?? '').includes('\0'), 'nor does a timestamp');
    }
  }
});

test('a job name the workflow gave a display name is still a campaign', () => {
  // pr_security_test_one.yml calls its matrix job `Security PR test`, so the rows arrive as
  // `Security PR test (audit, 9.0.x)`. Requiring the name to start with `test (` dropped
  // every one of them, which left the run with no executions at all and therefore counted
  // as aborted: a run that worked, filed as a run that never started.
  assert.deepEqual(classifyJob('Security PR test (audit, 9.0.x)'), {
    kind: 'campaign',
    campaign: 'audit',
    branch: '9.0.x',
  });
  assert.deepEqual(classifyJob('Security PR test (audit)'), { kind: 'campaign', campaign: 'audit' });
  assert.deepEqual(classifyJob('test (audit)'), { kind: 'campaign', campaign: 'audit' });

  // The prefix stops at the reusable-workflow separator, so a nested name is still read by
  // the rules below rather than being mistaken for a flat matrix row.
  assert.deepEqual(classifyJob('Prebuild shop and export artifacts / Build shop artifacts'), { kind: 'build-shop' });
  assert.deepEqual(classifyJob('Resolve PR context / Resolve PR + PrestaShop version'), { kind: 'prep' });
});

test('a matrix that never expanded is known, not unrecognised', () => {
  // A run cancelled before `prep` returned the campaign list lists a single job under the
  // bare `name:` of the matrix job. Nothing ran, so it is not a campaign — but it is a state
  // this repository produces regularly, and treating it as an unknown name would cry
  // workflow-rename on every collection that happens to include one.
  for (const name of ['test', 'Test', 'Security PR test']) {
    assert.deepEqual(classifyJob(name), { kind: 'campaign-unexpanded' }, name);
  }
  assert.deepEqual(classifyJob('latest'), { kind: 'other' }, 'not just any short name');

  const { executions, unclassified } = toExecutions([
    { name: 'Resolve PR context / Resolve PR + PrestaShop version', run_attempt: 1, conclusion: 'cancelled' },
    { name: 'test', run_attempt: 1, conclusion: 'cancelled' },
  ]);
  assert.deepEqual(executions, [], 'no campaign ran, so the run is still aborted');
  assert.deepEqual(unclassified, []);
});

test('a real security run yields its campaigns rather than nothing', () => {
  const { executions, branchFromJobName, unclassified } = toExecutions(SECURITY_RUN.jobs);

  assert.equal(SECURITY_RUN.jobs.length, 44);
  assert.equal(executions.length, 44, 'one execution per matrix row, none dropped');
  assert.equal(branchFromJobName, '9.0.x', 'the second matrix axis still carries the version');
  assert.deepEqual(unclassified, []);
  assert.ok(executions.some((e) => e.campaign === 'audit'));
  assert.ok(executions.every((e) => e.attempt === 1));
});

test('job names that match no rule are reported instead of vanishing', () => {
  // A workflow rename turns every campaign of a run into nothing, and a run with no
  // executions is recorded as aborted. That reads as a run that never started rather than
  // as a bug in here, so the names come back out to be counted.
  const { executions, unclassified } = toExecutions([
    { name: 'Run the tests, why not (audit)', run_attempt: 1, conclusion: 'success' },
    { name: 'Run the tests, why not (audit)', run_attempt: 1, conclusion: 'success' },
    { name: 'something else entirely', run_attempt: 1, conclusion: 'success' },
    { name: 'test (audit)', run_attempt: 1, conclusion: 'success', started_at: '2026-09-10T11:58:23Z' },
  ]);

  assert.equal(executions.length, 1);
  assert.deepEqual(unclassified, ['Run the tests, why not (audit)', 'something else entirely'],
    'distinct names, so a 45-job matrix is one problem rather than 45');
});

test('the known fixtures classify every one of their rows', () => {
  const fixtures: Array<[string, JobsFixture]> = [
    ['retried', RETRIED_RUN], ['legacy', LEGACY_RUN], ['prebuilt', PREBUILT_RUN], ['security', SECURITY_RUN],
  ];
  for (const [name, run] of fixtures) {
    assert.deepEqual(toExecutions(run.jobs).unclassified, [], `${name}: nothing unrecognised`);
  }
});
