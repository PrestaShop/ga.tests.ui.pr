/**
 * Flaky-test statistics. Pure functions, no imports: this module is loaded both by the
 * aggregator in Node and by the dashboard in the browser, so the numbers on the page and
 * the numbers in the generated summary can never drift apart.
 *
 * Vocabulary, per (run, campaign):
 *   - first attempt failed, later attempt passed  -> FLAKY (same code, different result)
 *   - still failing at the last attempt           -> HARD FAILURE (the PR, or a branch that is broken)
 *   - failed before the test step ever ran        -> INFRA (a different problem, counted apart)
 *
 * Time lost is reserved for flakiness. A campaign that fails for a real reason has not
 * wasted anything: it did its job and reported a genuine problem, and that first failure is
 * the signal the run existed to produce. Only a campaign that had to be run again to get the
 * answer it should have given the first time has cost time for nothing. Re-runs of a
 * genuinely broken campaign are reported separately (`hardRetrySeconds`): they are not lost
 * in that sense, but they are still machine time spent re-confirming a known failure.
 */

/** Conclusions that count towards pass/fail rates. `cancelled` and `skipped` do not. */
const OUTCOMES = new Set(['success', 'failure']);

/** `auto_retry_failed_jobs.yml` stops re-running at this attempt; past it, a human did it. */
export const RETRY_CAP = 6;

/**
 * Collapses a run's executions into one outcome per campaign.
 *
 * @param {{executions: Array<object>}} run
 * @returns {Array<{campaign: string, firstAttempt: number, firstFailed: boolean, attempts: number,
 *                  final: string|null, flaky: boolean, hardFailure: boolean, infra: boolean,
 *                  retrySeconds: number, lastFailureAt: string|null}>}
 */
export function campaignOutcomes(run) {
  /** @type {Map<string, Array<object>>} */
  const byCampaign = new Map();
  for (const exec of run.executions ?? []) {
    if (!byCampaign.has(exec.campaign)) byCampaign.set(exec.campaign, []);
    byCampaign.get(exec.campaign).push(exec);
  }

  const out = [];
  for (const [campaign, execs] of byCampaign) {
    const ordered = [...execs].sort((a, b) => a.attempt - b.attempt);
    const rated = ordered.filter((e) => OUTCOMES.has(e.conclusion));
    const first = rated[0];
    const last = rated[rated.length - 1];

    const firstFailed = first?.conclusion === 'failure';
    const final = last?.conclusion ?? null;
    const lastFailure = [...rated].reverse().find((e) => e.conclusion === 'failure');

    const flaky = firstFailed && final === 'success';
    const hardFailure = final === 'failure';
    const totalSeconds = ordered.reduce((sum, e) => sum + (e.duration_s ?? 0), 0);
    const retrySeconds = ordered.filter((e) => e.attempt > 1).reduce((sum, e) => sum + (e.duration_s ?? 0), 0);

    // Had this campaign not been flaky it would have run once and passed, so everything
    // except that one successful execution is time spent for nothing.
    const lostSeconds = flaky ? totalSeconds - (last?.duration_s ?? 0) : 0;

    out.push({
      campaign,
      firstAttempt: first?.attempt ?? ordered[0]?.attempt ?? 1,
      firstFailed,
      attempts: ordered.length ? ordered[ordered.length - 1].attempt : 0,
      final,
      flaky,
      hardFailure,
      infra: ordered.some((e) => e.failure_kind === 'infra'),
      totalSeconds,
      firstAttemptSeconds: ordered.find((e) => e.attempt === first?.attempt)?.duration_s ?? 0,
      retrySeconds,
      lostSeconds,
      // Re-runs of a campaign that never went green: real machine time, but not time lost
      // to flakiness, so it is kept in its own column rather than inflating the headline.
      hardRetrySeconds: hardFailure ? retrySeconds : 0,
      lastFailureAt: lastFailure?.started_at ?? null,
    });
  }
  return out;
}

/**
 * Wall clock of a set of executions: from the first one starting to the last one finishing.
 *
 * Campaigns run in parallel, so this is what somebody waiting on the run actually
 * experiences, not the sum of the jobs.
 *
 * @param {Array<object>} executions
 * @returns {number} seconds, 0 when nothing has usable timestamps
 */
export function wallClockSeconds(executions) {
  let first = Infinity;
  let last = -Infinity;
  for (const exec of executions) {
    const start = Date.parse(exec.started_at ?? '');
    if (!Number.isFinite(start)) continue;
    const end = Date.parse(exec.completed_at ?? '') || start + (exec.duration_s ?? 0) * 1000;
    if (start < first) first = start;
    if (end > last) last = end;
  }
  return Number.isFinite(first) && Number.isFinite(last) && last > first
    ? Math.round((last - first) / 1000)
    : 0;
}

/**
 * Splits the elapsed time of one run into the part where something was running and the part
 * spent waiting between attempts.
 *
 * Worth separating, because the two have different causes and different fixes. Attempts
 * fired by `auto_retry_failed_jobs.yml` follow each other within seconds, so waiting is
 * near zero for any run inside the retry cap. Waiting only appears once the cap is reached
 * and somebody re-runs by hand, which can be days later.
 *
 * @param {Array<object>} executions
 * @returns {{totalSeconds: number, runningSeconds: number, waitingSeconds: number,
 *            firstAttemptSeconds: number, attemptCount: number}}
 */
export function runTiming(executions) {
  /** @type {Map<number, Array<object>>} */
  const byAttempt = new Map();
  for (const exec of executions ?? []) {
    if (!exec.started_at) continue;
    if (!byAttempt.has(exec.attempt)) byAttempt.set(exec.attempt, []);
    byAttempt.get(exec.attempt).push(exec);
  }

  const attempts = [...byAttempt.entries()].sort(([a], [b]) => a - b);
  if (attempts.length === 0) {
    return { totalSeconds: 0, runningSeconds: 0, waitingSeconds: 0, firstAttemptSeconds: 0, attemptCount: 0 };
  }

  const runningSeconds = attempts.reduce((sum, [, execs]) => sum + wallClockSeconds(execs), 0);
  const totalSeconds = wallClockSeconds(executions);

  return {
    totalSeconds,
    runningSeconds,
    // Never negative: attempts can overlap slightly when a carried-over job is still going.
    waitingSeconds: Math.max(0, totalSeconds - runningSeconds),
    firstAttemptSeconds: wallClockSeconds(attempts[0][1]),
    attemptCount: attempts.length,
  };
}

/**
 * How healthy a whole test run is, independent of which campaign misbehaved.
 *
 * @param {Array<object>} runs run files (already filtered)
 */
export function runLevelStats(runs) {
  const usable = runs.filter((r) => !r.aborted && (r.executions?.length ?? 0) > 0);

  let greenFirstAttempt = 0;
  let greenEventually = 0;
  let neverGreen = 0;
  let failedAttempt1Total = 0;
  let attemptsTotal = 0;
  let retrySeconds = 0;
  let lostSeconds = 0;
  let hardRetrySeconds = 0;
  let computeSeconds = 0;
  let firstAttemptSeconds = 0;
  /** Per-run elapsed times, kept as samples so they can be reported as medians. */
  const elapsed = { total: [], running: [], waiting: [], firstAttempt: [] };
  /** @type {Record<number, number>} */
  const attemptsHistogram = {};

  for (const run of usable) {
    const outcomes = campaignOutcomes(run);
    const failedFirst = outcomes.filter((o) => o.firstFailed).length;
    const anyHard = outcomes.some((o) => o.hardFailure);

    if (anyHard) neverGreen += 1;
    else if (failedFirst > 0) greenEventually += 1;
    else greenFirstAttempt += 1;

    failedAttempt1Total += failedFirst;
    const attempts = Number(run.run_attempt) || 1;
    attemptsTotal += attempts;
    attemptsHistogram[attempts] = (attemptsHistogram[attempts] ?? 0) + 1;

    for (const o of outcomes) {
      retrySeconds += o.retrySeconds;
      lostSeconds += o.lostSeconds;
      hardRetrySeconds += o.hardRetrySeconds;
      computeSeconds += o.totalSeconds;
      firstAttemptSeconds += o.firstAttemptSeconds;
    }

    const timing = runTiming(run.executions ?? []);
    elapsed.total.push(timing.totalSeconds);
    elapsed.running.push(timing.runningSeconds);
    elapsed.waiting.push(timing.waitingSeconds);
    elapsed.firstAttempt.push(timing.firstAttemptSeconds);
  }

  const n = usable.length;
  return {
    runs: n,
    aborted: runs.length - n,
    greenFirstAttempt,
    greenEventually,
    neverGreen,
    greenFirstAttemptPct: pct(greenFirstAttempt, n),
    greenEventuallyPct: pct(greenEventually, n),
    neverGreenPct: pct(neverGreen, n),
    avgFailedCampaignsAttempt1: round(divide(failedAttempt1Total, n), 2),
    avgAttempts: round(divide(attemptsTotal, n), 2),
    attemptsHistogram,

    // Machine time. `computeMinutes` is what was actually spent, `firstAttemptMinutes` is
    // what the same runs would have cost had nothing needed a second go.
    computeMinutes: minutes(computeSeconds),
    firstAttemptMinutes: minutes(firstAttemptSeconds),
    retryMinutes: minutes(retrySeconds),
    // The headline: machine time that bought nothing, because a retry of the same code
    // produced the answer the first attempt should have given.
    lostMinutes: minutes(lostSeconds),
    lostPct: pct(lostSeconds, computeSeconds),
    // Re-runs of campaigns that never went green. Real time, but not lost: the failure was
    // genuine, only the repetition was avoidable.
    hardRetryMinutes: minutes(hardRetrySeconds),

    // Elapsed time to a final verdict, which is what a contributor waits for. Campaigns run
    // in parallel, so this is far below the machine time.
    //
    // Reported as a median, not a mean. The distribution has a long tail: once a run passes
    // the auto-retry cap of 6 attempts somebody has to re-run it by hand, which can happen
    // days later, and a handful of those drag an average far above anything anybody
    // experiences. The mean is kept beside it so the gap between them is visible.
    medianVerdictMinutes: minutes(median(elapsed.total)),
    avgVerdictMinutes: minutes(mean(elapsed.total)),
    medianFirstAttemptVerdictMinutes: minutes(median(elapsed.firstAttempt)),
    // The split that says which of the two is to blame.
    medianRunningMinutes: minutes(median(elapsed.running)),
    medianWaitingMinutes: minutes(median(elapsed.waiting)),
    avgWaitingMinutes: minutes(mean(elapsed.waiting)),
    // Runs that went past the retry cap, so a human had to restart them.
    beyondRetryCap: usable.filter((r) => (Number(r.run_attempt) || 1) > RETRY_CAP).length,
  };
}

/**
 * Per campaign: how often it fails, how often a retry rescues it, and across how many
 * different pull requests. The last one matters: a campaign failing across many unrelated
 * PRs is flaky or broken on the branch, while one failing only on a single PR's runs is
 * that PR's own fault. It is the more robust signal, because it does not depend on anyone
 * having clicked retry.
 *
 * @param {Array<object>} runs
 */
export function campaignStats(runs) {
  /** @type {Map<string, any>} */
  const acc = new Map();

  /** Durations of successful executions only: `--bail` cuts a failing campaign short. */
  const successDurations = new Map();
  for (const run of runs) {
    if (run.aborted) continue;
    for (const exec of run.executions ?? []) {
      if (exec.conclusion !== 'success' || !exec.duration_s) continue;
      if (!successDurations.has(exec.campaign)) successDurations.set(exec.campaign, []);
      successDurations.get(exec.campaign).push(exec.duration_s);
    }
    for (const outcome of campaignOutcomes(run)) {
      let row = acc.get(outcome.campaign);
      if (!row) {
        row = {
          campaign: outcome.campaign,
          runs: 0,
          greenFirstTry: 0,
          flaky: 0,
          neverGreen: 0,
          infraFailures: 0,
          attemptsTotal: 0,
          lostSeconds: 0,
          hardRetrySeconds: 0,
          computeSeconds: 0,
          durations: [],
          prsRun: new Set(),
          prsFailed: new Set(),
          lastFailureAt: null,
        };
        acc.set(outcome.campaign, row);
      }

      row.runs += 1;
      if (outcome.final === 'success' && !outcome.firstFailed) row.greenFirstTry += 1;
      if (outcome.flaky) row.flaky += 1;
      if (outcome.hardFailure) row.neverGreen += 1;
      // Runs affected, not executions. `scenarioStats` counts infra *executions*, because
      // its remainder arithmetic is per execution, so the same campaign can legitimately
      // read 3 here and 4 there when one run failed its environment on two attempts.
      if (outcome.infra) row.infraFailures += 1;
      row.attemptsTotal += outcome.attempts;
      row.lostSeconds += outcome.lostSeconds;
      row.hardRetrySeconds += outcome.hardRetrySeconds;
      row.computeSeconds += outcome.totalSeconds;

      if (run.pr_number) {
        row.prsRun.add(run.pr_number);
        if (outcome.firstFailed) row.prsFailed.add(run.pr_number);
      }
      if (outcome.lastFailureAt && (!row.lastFailureAt || outcome.lastFailureAt > row.lastFailureAt)) {
        row.lastFailureAt = outcome.lastFailureAt;
      }
    }
  }

  return [...acc.values()]
    .map((row) => ({
      campaign: row.campaign,
      runs: row.runs,
      greenFirstTryPct: pct(row.greenFirstTry, row.runs),
      flakyPct: pct(row.flaky, row.runs),
      neverGreenPct: pct(row.neverGreen, row.runs),
      flaky: row.flaky,
      neverGreen: row.neverGreen,
      infraFailures: row.infraFailures,
      avgAttempts: round(divide(row.attemptsTotal, row.runs), 2),
      // How long the campaign takes when it passes, which is also the price of each retry.
      medianDurationMin: minutes(median(successDurations.get(row.campaign) ?? [])),
      computeMinutes: minutes(row.computeSeconds),
      lostMinutes: minutes(row.lostSeconds),
      lostMinutesPerRun: round(divide(row.lostSeconds, row.runs) / 60, 1),
      hardRetryMinutes: minutes(row.hardRetrySeconds),
      distinctPrsRun: row.prsRun.size,
      distinctPrsFailed: row.prsFailed.size,
      prSpreadPct: pct(row.prsFailed.size, row.prsRun.size),
      lastFailureAt: row.lastFailureAt,
    }))
    .sort((a, b) => b.lostMinutes - a.lostMinutes || b.flakyPct - a.flakyPct || b.runs - a.runs);
}

/** @param {number[]} values */
export function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/** @param {number[]} values */
export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Groups runs into weekly buckets so a trend is visible over a quarter of work.
 *
 * @param {Array<object>} runs
 */
export function weeklyTrend(runs) {
  /** @type {Map<string, Array<object>>} */
  const weeks = new Map();
  for (const run of runs) {
    const week = isoWeekStart(run.created_at);
    if (!week) continue;
    if (!weeks.has(week)) weeks.set(week, []);
    weeks.get(week).push(run);
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, bucket]) => ({ week, ...runLevelStats(bucket) }));
}

/**
 * @param {Array<object>} runs
 * @param {object} filters
 * @param {string} [filters.branchKey]
 * @param {string} [filters.db]
 * @param {string} [filters.owner]
 * @param {string} [filters.workflow]
 * @param {number} [filters.sinceDays] rolling window, ignored when `from`/`to` are given
 * @param {string} [filters.from]      ISO timestamp, inclusive
 * @param {string} [filters.to]        ISO timestamp, inclusive
 * @param {boolean} [filters.includeSecurity]
 */
export function filterRuns(runs, filters = {}) {
  const from = Date.parse(filters.from ?? '');
  const to = Date.parse(filters.to ?? '');
  const explicitRange = Number.isFinite(from) || Number.isFinite(to);
  // An explicit range wins over the rolling window, so the two controls cannot fight.
  const cutoff = !explicitRange && filters.sinceDays ? Date.now() - filters.sinceDays * 86400000 : null;

  return runs.filter((run) => {
    if (filters.branchKey && run.branch_key !== filters.branchKey) return false;
    if (filters.db && run.db !== filters.db) return false;
    if (filters.owner && run.owner !== filters.owner) return false;
    if (filters.workflow && run.workflow !== filters.workflow) return false;
    if (!filters.includeSecurity && run.is_security) return false;

    const created = Date.parse(run.created_at ?? '');
    if (cutoff && created < cutoff) return false;
    if (Number.isFinite(from) && created < from) return false;
    if (Number.isFinite(to) && created > to) return false;
    return true;
  });
}

/** Monday of the week a timestamp falls in, as `YYYY-MM-DD`. */
export function isoWeekStart(timestamp) {
  const t = Date.parse(timestamp ?? '');
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export function pct(part, total) {
  return total > 0 ? round((part / total) * 100, 1) : 0;
}

/** @param {number} seconds */
function minutes(seconds) {
  return Math.round(seconds / 60);
}

function divide(a, b) {
  return b > 0 ? a / b : 0;
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Which scenario inside a campaign is responsible for its failures.
 *
 * The share below is a share of that campaign's failing executions, which is the number that
 * says where to start: a campaign failing 47% of the time because of one scenario is a
 * different job from one failing for a dozen reasons.
 *
 * ⚠️ Two different units meet here. `--bail` is usually on, so a red execution names exactly
 * one scenario and the two coincide — but it is not always on, and an execution that names
 * three scenarios produces three rows. Counting each of them as a whole failure against a
 * denominator of failing *executions* is what once made three campaigns report 175%, 150%
 * and 105% of their own failures. So a scenario's `failures` stays an honest integer count
 * of the times it was named, while the share divides `executionShare` — the execution
 * credited as `1/n` across the n scenarios it blamed — by the execution total. Those two
 * are in the same unit, so the shares sum to at most 100, and what is left over is exactly
 * the infra and expired-log remainder the caveat line reports.
 *
 * Only available inside the 90 days that job logs survive; older failures contribute to the
 * campaign totals but have no scenario, and are counted as `unattributed`.
 *
 * @param {Array<object>} runs
 * @param {string} [campaign] restrict to one campaign; omit for every campaign at once
 */
export function scenarioStats(runs, campaign) {
  /** @type {Map<string, any>} */
  const acc = new Map();
  let campaignFailures = 0;
  let attributed = 0;
  let infraFailures = 0;

  for (const run of runs) {
    if (run.aborted) continue;
    for (const exec of run.executions ?? []) {
      if (campaign && exec.campaign !== campaign) continue;
      if (exec.conclusion !== 'failure') continue;
      campaignFailures += 1;
      // A campaign that died in its environment never reached mocha, so it has no scenario
      // to name. That is not a gap in the data, and counting it as one would suggest logs
      // were missing when nothing was.
      if (exec.failure_kind === 'infra') {
        infraFailures += 1;
        continue;
      }

      const failing = (exec.failing_tests ?? []).filter((t) => t?.title);
      if (failing.length === 0) continue;
      attributed += 1;

      for (const test of failing) {
      // The spec file identifies a scenario better than its title, which is not unique
      // across campaigns; the title alone is what a person recognises.
      const key = `${test.file ?? ''}::${test.title}`;
      let row = acc.get(key);
      if (!row) {
        row = {
          title: test.title,
          suite: test.suite ?? '',
          file: test.file ?? null,
          line: test.line ?? null,
          campaigns: new Set(),
          failures: 0,
          // Execution-equivalents: `1/n` per scenario of an execution that named n of them,
          // so this column and `campaignFailures` are in the same unit.
          executionShare: 0,
          flakyFailures: 0,
          prs: new Set(),
          errors: new Map(),
          lastFailureAt: null,
        };
        acc.set(key, row);
      }

      row.failures += 1;
      row.executionShare += 1 / failing.length;
      row.campaigns.add(exec.campaign);
      if (run.pr_number) row.prs.add(run.pr_number);
      if (test.error) row.errors.set(test.error, (row.errors.get(test.error) ?? 0) + 1);
      if (!row.lastFailureAt || (exec.started_at ?? '') > row.lastFailureAt) {
        row.lastFailureAt = exec.started_at ?? null;
      }
      // A failure inside a campaign that went green later is flakiness by the same rule
      // used everywhere else: the code did not change between attempts.
      const outcome = campaignOutcomes(run).find((o) => o.campaign === exec.campaign);
      if (outcome?.flaky) row.flakyFailures += 1;
      }
    }
  }

  const scenarios = [...acc.values()]
    .map((row) => ({
      title: row.title,
      suite: row.suite,
      file: row.file,
      line: row.line,
      campaigns: [...row.campaigns].sort(),
      // How many times this scenario was named by a failing execution.
      failures: row.failures,
      // Share of this campaign's failing executions it accounts for. See the unit note above.
      shareOfFailuresPct: pct(row.executionShare, campaignFailures),
      flakyFailures: row.flakyFailures,
      distinctPrs: row.prs.size,
      topError: [...row.errors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      lastFailureAt: row.lastFailureAt,
    }))
    .sort((a, b) => b.failures - a.failures || a.title.localeCompare(b.title));

  return {
    scenarios,
    campaignFailures,
    attributed,
    // Environment failures: no mocha report exists, so no scenario is expected. Counted per
    // execution, unlike the campaign table's column, which counts runs affected.
    infraFailures,
    // Test failures whose log has expired past the 90 day retention, so the scenario could
    // not be read. Shown rather than hidden, otherwise the shares silently stop adding up.
    unattributed: campaignFailures - attributed - infraFailures,
  };
}
