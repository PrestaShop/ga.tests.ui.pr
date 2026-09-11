import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { classifyJob, failureKind, toExecutions, durationSeconds } from './executions.js';

const fixture = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

const RETRIED_RUN = fixture('jobs-34473576823.json'); // 3 attempts, current job names
const LEGACY_RUN = fixture('jobs-24509737743.json'); //  1 attempt, legacy names carrying the branch
const PREBUILT_RUN = fixture('jobs-32371081746.json'); // pr_test.yml, nested reusable names

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

  const perAttempt = executions.reduce((acc, e) => {
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
  const failed = (attempt) =>
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
