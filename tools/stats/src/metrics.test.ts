import { test } from 'vitest';
import assert from 'node:assert/strict';

import { campaignOutcomes, campaignStats, runLevelStats, weeklyTrend, filterRuns, isoWeekStart, wallClockSeconds, runTiming, median, mean, scenarioStats } from './metrics.js';
import type { Execution, RunFile } from './types.js';

interface RunOptions extends Partial<RunFile> {
  id?: number;
  pr?: number | null;
  branch?: string;
  attempts?: number;
  created?: string;
}

/** Builds a run file the way collect.ts writes one. */
function run(
  { id = 1, pr = 100, branch = 'develop', attempts = 1, created = '2026-09-10T10:00:00Z', ...rest }: RunOptions,
  executions: Execution[] = [],
): RunFile {
  return {
    repo: 'someone/ga.tests.ui.pr',
    owner: 'someone',
    run_id: id,
    run_attempt: attempts,
    workflow: 'pr_test_one.yml',
    status: 'completed',
    html_url: `https://github.com/someone/ga.tests.ui.pr/actions/runs/${id}`,
    created_at: created,
    pr_number: pr,
    db: 'mysql',
    branch_key: branch,
    branch_key_source: 'resolved-log',
    is_security: false,
    aborted: false,
    ...rest,
    executions,
  };
}

const exec = (
  campaign: string,
  attempt: number,
  conclusion: string,
  extra: Partial<Execution> = {},
): Execution => {
  const duration = extra.duration_s ?? 600;
  const startedAt = extra.started_at ?? '2026-09-10T10:00:00Z';
  return {
    campaign,
    attempt,
    conclusion,
    failure_kind: conclusion === 'failure' ? 'test' : 'none',
    duration_s: duration,
    started_at: startedAt,
    completed_at: `${new Date(Date.parse(startedAt) + duration * 1000).toISOString().slice(0, 19)}Z`,
    ...extra,
  };
};

test('a campaign rescued by a retry is flaky, one that stays red is not', () => {
  const outcomes = campaignOutcomes(
    run({}, [
      exec('flaky-one', 1, 'failure'),
      exec('flaky-one', 2, 'success'),
      exec('broken-one', 1, 'failure'),
      exec('broken-one', 2, 'failure'),
      exec('fine-one', 1, 'success'),
    ]),
  );
  const by = Object.fromEntries(outcomes.map((o) => [o.campaign, o]));

  assert.equal(by['flaky-one'].flaky, true);
  assert.equal(by['flaky-one'].hardFailure, false);

  assert.equal(by['broken-one'].flaky, false);
  assert.equal(by['broken-one'].hardFailure, true);

  assert.equal(by['fine-one'].flaky, false);
  assert.equal(by['fine-one'].firstFailed, false);
});

test('cancelled and skipped executions do not count as outcomes', () => {
  const [outcome] = campaignOutcomes(run({}, [exec('c', 1, 'cancelled'), exec('c', 2, 'success')]));
  assert.equal(outcome.firstFailed, false);
  assert.equal(outcome.final, 'success');
  assert.equal(outcome.flaky, false, 'a cancelled first attempt is not evidence of flakiness');
});

test('run health splits green-first-try, green-after-retry and never-green', () => {
  const runs = [
    run({ id: 1, attempts: 1 }, [exec('a', 1, 'success'), exec('b', 1, 'success')]),
    run({ id: 2, attempts: 2 }, [exec('a', 1, 'failure'), exec('a', 2, 'success'), exec('b', 1, 'success')]),
    run({ id: 3, attempts: 2 }, [exec('a', 1, 'failure'), exec('a', 2, 'failure'), exec('b', 1, 'success')]),
  ];
  const stats = runLevelStats(runs);

  assert.equal(stats.runs, 3);
  assert.equal(stats.greenFirstAttempt, 1);
  assert.equal(stats.greenEventually, 1);
  assert.equal(stats.neverGreen, 1);
  assert.equal(stats.greenFirstAttemptPct, 33.3);
  assert.deepEqual(stats.attemptsHistogram, { 1: 1, 2: 2 });
  assert.equal(stats.avgFailedCampaignsAttempt1, 0.67);
});

test('retry minutes count every re-run, whatever the reason', () => {
  const runs = [
    run({ id: 1, attempts: 3 }, [
      exec('a', 1, 'failure', { duration_s: 900 }),
      exec('a', 2, 'failure', { duration_s: 900 }),
      exec('a', 3, 'success', { duration_s: 600 }),
      exec('b', 1, 'success', { duration_s: 1200 }),
    ]),
  ];
  // Attempts 2 and 3 of campaign a: 900 + 600 = 1500s = 25min.
  assert.equal(runLevelStats(runs).retryMinutes, 25);
});

test('time lost is flakiness only: a real failure has not wasted anything', () => {
  const flakyRun = run({ id: 1, attempts: 2 }, [
    exec('flaky', 1, 'failure', { duration_s: 900 }),
    exec('flaky', 2, 'success', { duration_s: 600 }),
  ]);
  const brokenRun = run({ id: 2, attempts: 3 }, [
    exec('broken', 1, 'failure', { duration_s: 900 }),
    exec('broken', 2, 'failure', { duration_s: 900 }),
    exec('broken', 3, 'failure', { duration_s: 900 }),
  ]);

  // Flaky: without the flake it would have run once and passed, so everything but that
  // final 600s success is time bought for nothing.
  assert.equal(runLevelStats([flakyRun]).lostMinutes, 15);

  // A campaign that genuinely fails reported a real problem, so none of it is lost. The
  // two pointless re-runs are still machine time, and are reported on their own.
  const broken = runLevelStats([brokenRun]);
  assert.equal(broken.lostMinutes, 0, 'a real error is not lost time');
  assert.equal(broken.hardRetryMinutes, 30, 'but re-confirming it twice cost 30 minutes');
  assert.equal(broken.retryMinutes, 30);
});

test('a campaign green on the first try costs nothing', () => {
  const stats = runLevelStats([run({ id: 1 }, [exec('a', 1, 'success', { duration_s: 600 })])]);
  assert.equal(stats.lostMinutes, 0);
  assert.equal(stats.retryMinutes, 0);
  assert.equal(stats.computeMinutes, 10);
  assert.equal(stats.firstAttemptMinutes, 10);
});

test('machine time is reported against what it would have cost with no retries', () => {
  const runs = [
    run({ id: 1, attempts: 2 }, [
      exec('a', 1, 'failure', { duration_s: 900 }),
      exec('a', 2, 'success', { duration_s: 600 }),
      exec('b', 1, 'success', { duration_s: 1200 }),
    ]),
  ];
  const stats = runLevelStats(runs);

  assert.equal(stats.computeMinutes, 45, '900 + 600 + 1200 seconds actually spent');
  assert.equal(stats.firstAttemptMinutes, 35, 'the first attempt of each campaign: 900 + 1200');
  assert.equal(stats.lostMinutes, 15, 'the 900s false failure was the only waste');
  assert.equal(stats.lostPct, 33.3);
});

test('wall clock is what someone waits for, not the sum of the jobs', () => {
  // Two campaigns run in parallel for 10 minutes, then a retry an hour later.
  const runs = [
    run({ id: 1, attempts: 2 }, [
      exec('a', 1, 'failure', { duration_s: 600, started_at: '2026-09-10T10:00:00Z' }),
      exec('b', 1, 'success', { duration_s: 600, started_at: '2026-09-10T10:00:00Z' }),
      exec('a', 2, 'success', { duration_s: 600, started_at: '2026-09-10T11:00:00Z' }),
    ]),
  ];
  const stats = runLevelStats(runs);

  assert.equal(stats.computeMinutes, 30, 'three jobs of ten minutes');
  assert.equal(stats.medianFirstAttemptVerdictMinutes, 10, 'the two parallel campaigns');
  assert.equal(stats.medianVerdictMinutes, 70, 'start of the first job to end of the last');
});

test('elapsed time separates running from waiting for a retry', () => {
  // Ten minutes of work, an hour of nothing, ten more minutes of work.
  const timing = runTiming([
    exec('a', 1, 'failure', { duration_s: 600, started_at: '2026-09-10T10:00:00Z' }),
    exec('b', 1, 'success', { duration_s: 600, started_at: '2026-09-10T10:00:00Z' }),
    exec('a', 2, 'success', { duration_s: 600, started_at: '2026-09-10T11:00:00Z' }),
  ]);

  assert.equal(timing.totalSeconds, 4200, '70 minutes end to end');
  assert.equal(timing.runningSeconds, 1200, 'two attempts of ten minutes each');
  assert.equal(timing.waitingSeconds, 3000, 'the 50 minutes of nothing in between');
  assert.equal(timing.firstAttemptSeconds, 600);
  assert.equal(timing.attemptCount, 2);
});

test('an automatic retry shows almost no waiting', () => {
  // What auto_retry_failed_jobs.yml actually produces: the next attempt starts seconds later.
  const timing = runTiming([
    exec('a', 1, 'failure', { duration_s: 600, started_at: '2026-09-10T10:00:00Z' }),
    exec('a', 2, 'success', { duration_s: 600, started_at: '2026-09-10T10:10:20Z' }),
  ]);
  assert.equal(timing.waitingSeconds, 20);
});

test('overlapping attempts never produce negative waiting', () => {
  const timing = runTiming([
    exec('slow', 1, 'success', { duration_s: 3600, started_at: '2026-09-10T10:00:00Z' }),
    exec('quick', 2, 'success', { duration_s: 60, started_at: '2026-09-10T10:30:00Z' }),
  ]);
  assert.equal(timing.waitingSeconds, 0);
});

test('elapsed time is reported as a median, because a few manual re-runs wreck the mean', () => {
  // Nine runs retried automatically within a minute, one restarted by hand a week later.
  const quick = Array.from({ length: 9 }, (_, i) =>
    run({ id: i + 1, attempts: 2 }, [
      exec('a', 1, 'failure', { duration_s: 600, started_at: '2026-09-10T10:00:00Z' }),
      exec('a', 2, 'success', { duration_s: 600, started_at: '2026-09-10T10:11:00Z' }),
    ]),
  );
  const abandoned = run({ id: 99, attempts: 7 }, [
    exec('a', 1, 'failure', { duration_s: 600, started_at: '2026-09-10T10:00:00Z' }),
    exec('a', 7, 'success', { duration_s: 600, started_at: '2026-09-17T10:00:00Z' }),
  ]);
  const stats = runLevelStats([...quick, abandoned]);

  assert.equal(stats.medianVerdictMinutes, 21, 'what nearly every run actually takes');
  assert.ok(stats.avgVerdictMinutes > 1000, `the mean is wrecked by one outlier (${stats.avgVerdictMinutes})`);
  assert.equal(stats.medianWaitingMinutes, 1, 'automatic retries wait about a minute');
  assert.equal(stats.beyondRetryCap, 1, 'one run went past the six-attempt cap');
});

test('wall clock survives missing timestamps', () => {
  assert.equal(wallClockSeconds([]), 0);
  assert.equal(wallClockSeconds([exec('a', 1, 'success', { started_at: null, duration_s: 100 })]), 0);
  assert.equal(
    wallClockSeconds([exec('a', 1, 'success', { started_at: '2026-09-10T10:00:00Z', completed_at: null, duration_s: 120 })]),
    120,
    'falls back on the duration when there is no end timestamp',
  );
});

test('per campaign, time lost drives the ranking and the typical duration is shown', () => {
  const runs = [
    run({ id: 1, pr: 1, attempts: 2 }, [
      // Slow and flaky: the expensive problem.
      exec('slow-flaky', 1, 'failure', { duration_s: 1800 }),
      exec('slow-flaky', 2, 'success', { duration_s: 1800 }),
      // Flaky but quick: annoying, cheap.
      exec('fast-flaky', 1, 'failure', { duration_s: 60 }),
      exec('fast-flaky', 2, 'success', { duration_s: 60 }),
      // Genuinely broken: costs time, but none of it is lost.
      exec('broken', 1, 'failure', { duration_s: 1200 }),
      exec('broken', 2, 'failure', { duration_s: 1200 }),
    ]),
  ];
  const rows = campaignStats(runs);

  assert.equal(rows[0].campaign, 'slow-flaky', 'ranked by time lost, not by failure count');
  assert.equal(rows[0].lostMinutes, 30);
  assert.equal(rows[0].medianDurationMin, 30, 'measured on successful runs only');

  const by = Object.fromEntries(rows.map((r) => [r.campaign, r]));
  assert.equal(by['fast-flaky'].lostMinutes, 1);
  assert.equal(by['fast-flaky'].flakyPct, 100, 'just as flaky, far cheaper');

  assert.equal(by.broken.lostMinutes, 0);
  assert.equal(by.broken.hardRetryMinutes, 20);
  assert.equal(by.broken.computeMinutes, 40);
});

test('aborted runs are set aside instead of counted as failures', () => {
  const runs = [
    run({ id: 1 }, [exec('a', 1, 'success')]),
    run({ id: 2, aborted: true }, [exec('a', 1, 'skipped'), exec('b', 1, 'skipped')]),
  ];
  const stats = runLevelStats(runs);

  assert.equal(stats.runs, 1);
  assert.equal(stats.aborted, 1);
  assert.equal(stats.neverGreen, 0, 'a failed shop prebuild is not 45 failing campaigns');
});

test('campaign ranking puts the flakiest first and counts the PR spread', () => {
  const runs = [
    // Same campaign fails first-try on three unrelated PRs, and a retry always rescues it.
    run({ id: 1, pr: 101 }, [exec('flaky', 1, 'failure'), exec('flaky', 2, 'success'), exec('solid', 1, 'success')]),
    run({ id: 2, pr: 102 }, [exec('flaky', 1, 'failure'), exec('flaky', 2, 'success'), exec('solid', 1, 'success')]),
    run({ id: 3, pr: 103 }, [exec('flaky', 1, 'failure'), exec('flaky', 2, 'success'), exec('solid', 1, 'success')]),
    // A campaign broken by one PR only: same failure count, but confined to a single PR.
    run({ id: 4, pr: 104 }, [exec('solid', 1, 'failure'), exec('solid', 2, 'failure'), exec('flaky', 1, 'success')]),
  ];
  const [first, second] = campaignStats(runs);

  assert.equal(first.campaign, 'flaky');
  assert.equal(first.flakyPct, 75);
  assert.equal(first.distinctPrsFailed, 3, 'fails across unrelated PRs -> flaky');
  assert.equal(first.distinctPrsRun, 4);

  assert.equal(second.campaign, 'solid');
  assert.equal(second.neverGreen, 1);
  assert.equal(second.distinctPrsFailed, 1, 'confined to one PR -> that PR broke it');
});

test('infra failures are tallied apart from test failures', () => {
  const runs = [
    run({ id: 1 }, [
      exec('a', 1, 'failure', { failure_kind: 'infra' }),
      exec('a', 2, 'success'),
      exec('b', 1, 'failure', { failure_kind: 'test' }),
      exec('b', 2, 'success'),
    ]),
  ];
  const by = Object.fromEntries(campaignStats(runs).map((r) => [r.campaign, r]));

  assert.equal(by.a.infraFailures, 1);
  assert.equal(by.b.infraFailures, 0);
  assert.equal(by.a.flakyPct, 100, 'still flaky, but for an environment reason');
});

test('an explicit date range overrides the rolling window', () => {
  const runs = [
    run({ id: 1, created: '2026-09-01T12:00:00Z' }, [exec('a', 1, 'success')]),
    run({ id: 2, created: '2026-09-05T12:00:00Z' }, [exec('a', 1, 'success')]),
    run({ id: 3, created: '2026-09-10T12:00:00Z' }, [exec('a', 1, 'success')]),
  ];

  const inRange = filterRuns(runs, { from: '2026-09-02T00:00:00Z', to: '2026-09-08T00:00:00Z' });
  assert.deepEqual(inRange.map((r) => r.run_id), [2]);

  // Open-ended on either side.
  assert.equal(filterRuns(runs, { from: '2026-09-04T00:00:00Z' }).length, 2);
  assert.equal(filterRuns(runs, { to: '2026-09-04T00:00:00Z' }).length, 1);

  // A range wins over sinceDays, so the two controls cannot contradict each other.
  assert.equal(filterRuns(runs, { sinceDays: 1, from: '2026-09-01T00:00:00Z' }).length, 3);
  // A malformed value is ignored rather than hiding everything.
  assert.equal(filterRuns(runs, { from: 'not a date' }).length, 3);
});

test('filters narrow by version, database, owner and age', () => {
  const runs = [
    run({ id: 1, branch: 'develop' }),
    run({ id: 2, branch: '9.2.x' }),
    run({ id: 3, branch: '9.2.x', db: 'mariadb' }),
    run({ id: 4, branch: '9.2.x', created: '2020-01-01T00:00:00Z' }),
    run({ id: 5, branch: '9.2.x', is_security: true }),
  ].map((r) => ({ ...r, executions: [exec('a', 1, 'success')] }));

  assert.equal(filterRuns(runs, { branchKey: '9.2.x' }).length, 3);
  assert.equal(filterRuns(runs, { branchKey: '9.2.x', db: 'mariadb' }).length, 1);
  assert.equal(filterRuns(runs, { sinceDays: 3650 }).length, 4, 'the 2020 run is outside the window');
  assert.equal(filterRuns(runs, { includeSecurity: true }).length, 5);
  assert.equal(filterRuns(runs, {}).length, 4, 'security runs are out unless asked for');
});

test('weeks are bucketed from Monday', () => {
  assert.equal(isoWeekStart('2026-09-10T10:00:00Z'), '2026-09-07'); // a Thursday
  assert.equal(isoWeekStart('2026-09-07T00:00:00Z'), '2026-09-07'); // the Monday itself
  assert.equal(isoWeekStart('nonsense'), null);

  const trend = weeklyTrend([
    run({ id: 1, created: '2026-09-07T10:00:00Z' }, [exec('a', 1, 'success')]),
    run({ id: 2, created: '2026-09-09T10:00:00Z' }, [exec('a', 1, 'failure')]),
    run({ id: 3, created: '2026-09-14T10:00:00Z' }, [exec('a', 1, 'success')]),
  ]);
  assert.deepEqual(trend.map((w) => [w.week, w.runs]), [
    ['2026-09-07', 2],
    ['2026-09-14', 1],
  ]);
});

test('empty input yields zeros rather than NaN', () => {
  const stats = runLevelStats([]);
  assert.equal(stats.runs, 0);
  assert.equal(stats.greenFirstAttemptPct, 0);
  assert.equal(stats.avgAttempts, 0);
  assert.equal(stats.lostMinutes, 0);
  assert.equal(stats.lostPct, 0);
  assert.equal(stats.medianVerdictMinutes, 0);
  assert.equal(stats.medianWaitingMinutes, 0);
  assert.equal(mean([]), 0);
  assert.deepEqual(campaignStats([]), []);
  assert.equal(median([]), 0);
});

test('the median duration ignores the order it was given in', () => {
  assert.equal(median([300]), 300);
  assert.equal(median([900, 100, 500]), 500);
  assert.equal(median([400, 200]), 300);
});

interface ScenarioSeed {
  title: string;
  suite?: string;
  file?: string | null;
  line?: number | null;
  error?: string;
}

const withScenario = (
  campaign: string,
  attempt: number,
  conclusion: string,
  scenario: ScenarioSeed | null,
  extra: Partial<Execution> = {},
): Execution => ({
  ...exec(campaign, attempt, conclusion, extra),
  ...(scenario
    ? { failing_tests: [{ title: scenario.title, suite: scenario.suite ?? 'Suite', file: scenario.file, line: scenario.line ?? 1, error: scenario.error ?? 'AssertionError: nope' }] }
    : {}),
});

test('one scenario is blamed for the share of the campaign failures it caused', () => {
  const runs = [
    run({ id: 1, pr: 11, attempts: 2 }, [
      withScenario('functional:BO:catalog:03-04', 1, 'failure', { title: 'should filter by name', file: 'campaigns/functional/BO/03_catalog/01_filter.ts', line: 42 }),
      withScenario('functional:BO:catalog:03-04', 2, 'success', null),
    ]),
    run({ id: 2, pr: 12, attempts: 2 }, [
      withScenario('functional:BO:catalog:03-04', 1, 'failure', { title: 'should filter by name', file: 'campaigns/functional/BO/03_catalog/01_filter.ts', line: 42 }),
      withScenario('functional:BO:catalog:03-04', 2, 'success', null),
    ]),
    run({ id: 3, pr: 13, attempts: 2 }, [
      withScenario('functional:BO:catalog:03-04', 1, 'failure', { title: 'should open the product', file: 'campaigns/functional/BO/03_catalog/02_product.ts', line: 7 }),
      withScenario('functional:BO:catalog:03-04', 2, 'success', null),
    ]),
  ];

  const { scenarios, campaignFailures, unattributed } = scenarioStats(runs, 'functional:BO:catalog:03-04');

  assert.equal(campaignFailures, 3);
  assert.equal(unattributed, 0);
  assert.equal(scenarios.length, 2);

  const [worst, second] = scenarios;
  assert.equal(worst.title, 'should filter by name');
  assert.equal(worst.failures, 2);
  assert.equal(worst.shareOfFailuresPct, 66.7, 'two of the three failures of this campaign');
  assert.equal(worst.file, 'campaigns/functional/BO/03_catalog/01_filter.ts');
  assert.equal(worst.line, 42);
  assert.equal(worst.distinctPrs, 2, 'failed on two unrelated pull requests');
  assert.equal(worst.flakyFailures, 2, 'the campaign went green on a later attempt both times');

  assert.equal(second.title, 'should open the product');
  assert.equal(second.shareOfFailuresPct, 33.3);
});

test('two scenarios with the same title in different files stay apart', () => {
  const runs = [
    run({ id: 1 }, [
      withScenario('a', 1, 'failure', { title: 'should log in', file: 'campaigns/functional/BO/00_login/01.ts' }),
    ]),
    run({ id: 2 }, [
      withScenario('b', 1, 'failure', { title: 'should log in', file: 'campaigns/functional/FO/01_login/01.ts' }),
    ]),
  ];
  const { scenarios } = scenarioStats(runs);
  assert.equal(scenarios.length, 2, 'the spec file distinguishes them, the title alone does not');
  assert.deepEqual(scenarios.map((s) => s.campaigns).flat().sort(), ['a', 'b']);
});

test('failures whose log has expired are reported as unattributed, not dropped', () => {
  const runs = [
    run({ id: 1 }, [
      withScenario('a', 1, 'failure', { title: 'should do a thing', file: 'campaigns/x.ts' }),
      // Older than 90 days: the log is gone, so no scenario could be read.
      withScenario('a', 1, 'failure', null),
    ]),
  ];
  const stats = scenarioStats(runs, 'a');

  assert.equal(stats.campaignFailures, 2);
  assert.equal(stats.attributed, 1);
  assert.equal(stats.unattributed, 1);
  assert.equal(stats.scenarios[0].shareOfFailuresPct, 50, 'the share is of every failure, attributed or not');
});

test('the most common error message is kept for each scenario', () => {
  const runs = [
    run({ id: 1 }, [withScenario('a', 1, 'failure', { title: 't', file: 'f.ts', error: 'TimeoutError: waiting for selector' })]),
    run({ id: 2 }, [withScenario('a', 1, 'failure', { title: 't', file: 'f.ts', error: 'TimeoutError: waiting for selector' })]),
    run({ id: 3 }, [withScenario('a', 1, 'failure', { title: 't', file: 'f.ts', error: 'AssertionError: expected 1 to equal 2' })]),
  ];
  assert.equal(scenarioStats(runs, 'a').scenarios[0].topError, 'TimeoutError: waiting for selector');
});

test('a campaign with no failure at all yields nothing to blame', () => {
  const runs = [run({ id: 1 }, [exec('a', 1, 'success')])];
  const stats = scenarioStats(runs, 'a');
  assert.deepEqual(stats.scenarios, []);
  assert.equal(stats.campaignFailures, 0);
  assert.equal(stats.unattributed, 0);
});

test('an execution that reported several failing scenarios credits all of them', () => {
  // --bail is not always on, so one red campaign can name more than one scenario.
  const runs = [
    run({ id: 1, pr: 5 }, [
      {
        ...exec('a', 1, 'failure'),
        failing_tests: [
          { title: 'first scenario', suite: 'S', file: 'campaigns/a.ts', line: 1, error: 'boom' },
          { title: 'second scenario', suite: 'S', file: 'campaigns/b.ts', line: 2, error: 'bang' },
        ],
      },
    ]),
  ];
  const { scenarios, campaignFailures, attributed, unattributed } = scenarioStats(runs, 'a');

  assert.equal(scenarios.length, 2);
  assert.deepEqual(scenarios.map((s) => s.title).sort(), ['first scenario', 'second scenario']);
  assert.equal(campaignFailures, 1, 'still one failing execution');
  assert.equal(attributed, 1);
  assert.equal(unattributed, 0);

  // Each scenario was named once, so each shows one failure — but there was only ever one
  // failing execution between them, so they split it rather than claiming it twice. Counting
  // both as whole failures against a denominator of executions is what once reported three
  // campaigns at 175%, 150% and 105% of their own failures.
  assert.deepEqual(scenarios.map((s) => s.failures), [1, 1]);
  assert.deepEqual(scenarios.map((s) => s.shareOfFailuresPct), [50, 50]);
});

test('scenario shares never add up to more than the campaign failed', () => {
  const runs = [
    // Three failing executions. One names a single scenario, one names three at once, and
    // one died in its environment before mocha ran.
    run({ id: 1 }, [withScenario('a', 1, 'failure', { title: 'solo', file: 'campaigns/a.ts' })]),
    run({ id: 2 }, [
      {
        ...exec('a', 1, 'failure'),
        failing_tests: [
          { title: 'one', suite: 'S', file: 'campaigns/b.ts' },
          { title: 'two', suite: 'S', file: 'campaigns/c.ts' },
          { title: 'three', suite: 'S', file: 'campaigns/d.ts' },
        ],
      },
    ]),
    run({ id: 3 }, [{ ...exec('a', 1, 'failure'), failure_kind: 'infra' }]),
  ];
  const { scenarios, campaignFailures, attributed, infraFailures, unattributed } = scenarioStats(runs, 'a');

  assert.equal(campaignFailures, 3);
  assert.equal(attributed, 2);
  assert.equal(infraFailures, 1);
  assert.equal(unattributed, 0);
  assert.equal(scenarios.length, 4, 'four scenarios named across two executions');

  const total = scenarios.reduce((n, s) => n + s.shareOfFailuresPct, 0);
  assert.ok(total <= 100, `shares sum to ${total}, which must not exceed 100`);
  // 2 of the 3 failures are attributed; the remaining third is the environment failure the
  // caveat line reports. The shares account for exactly that attributed two thirds, less a
  // tenth lost to rounding each row to one decimal (33.3 + 11.1 + 11.1 + 11.1).
  assert.equal(round(total, 1), 66.6);
  assert.equal(scenarios.find((s) => s.title === 'solo')!.shareOfFailuresPct, 33.3);
  assert.equal(scenarios.find((s) => s.title === 'one')!.shareOfFailuresPct, 11.1, 'a third of a third');
});

test('scenario shares add up to 100 when every failure names a scenario', () => {
  const runs = [
    run({ id: 1 }, [withScenario('a', 1, 'failure', { title: 'solo', file: 'campaigns/a.ts' })]),
    run({ id: 2 }, [
      {
        ...exec('a', 1, 'failure'),
        failing_tests: [
          { title: 'one', suite: 'S', file: 'campaigns/b.ts' },
          { title: 'two', suite: 'S', file: 'campaigns/c.ts' },
        ],
      },
    ]),
  ];
  const { scenarios, campaignFailures, unattributed, infraFailures } = scenarioStats(runs, 'a');

  assert.equal(campaignFailures, 2);
  assert.equal(unattributed, 0);
  assert.equal(infraFailures, 0);
  assert.equal(scenarios.reduce((n, s) => n + s.shareOfFailuresPct, 0), 100);
});

/** Rounds the way pct() does, so summing rounded shares can be compared without drift. */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

test('an environment failure is not counted as a missing scenario', () => {
  const runs = [
    run({ id: 1 }, [
      withScenario('a', 1, 'failure', { title: 'a real scenario', file: 'campaigns/x.ts' }),
      // Died in setup: mocha never ran, so there is no scenario to find and nothing missing.
      { ...exec('a', 1, 'failure', { failure_kind: 'infra' }), started_at: '2026-09-10T11:00:00Z' },
    ]),
  ];
  const stats = scenarioStats(runs, 'a');

  assert.equal(stats.campaignFailures, 2);
  assert.equal(stats.attributed, 1);
  assert.equal(stats.infraFailures, 1);
  assert.equal(stats.unattributed, 0, 'no log was missing, the campaign simply never started');
});
