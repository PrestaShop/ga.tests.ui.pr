/**
 * One invocation of the puller: list every repository's runs, work out which ones are new
 * or have gained an attempt, and store what happened in each.
 *
 * There is deliberately no watermark or cursor. Re-enumerating every run of every fork
 * costs ~127 requests, which is cheap enough that the puller can diff the full list against
 * the stored index each time. A watermark would permanently skip any run that was still in
 * progress when it was first seen, and would never notice a retry of an older run, because
 * re-running does not change `created_at`.
 */

import { GitHub, RateLimitReached } from './github.js';
import { Store } from './store.js';
import { toExecutions } from './executions.js';
import { parseLog } from './parse-log.js';
import { branchKeyFromRef, UNKNOWN_BRANCH_KEY } from './branch-key.js';

/** Workflows whose runs are UI test campaigns. Anything else in a fork is ignored. */
export const TEST_WORKFLOWS = [
  'pr_test_one.yml',
  'pr_test.yml',
  'pr_test_single_campaign.yml',
  'pr_security_test_one.yml',
];

/** Security runs are counted, but nothing identifying the PR is stored and logs are not read. */
const SECURITY_WORKFLOW = 'pr_security_test_one.yml';

/** The repository pull requests are opened against; used to resolve a run's target branch. */
const UPSTREAM = 'PrestaShop/PrestaShop';

/** A head slice this big holds the inputs and the resolved-version block (a whole log is ~274 KB). */
const LOG_HEAD_BYTES = 64 * 1024;

/** Retries stop at attempt 6 (auto_retry_failed_jobs.yml), so a failure there is final. */
const MAX_ATTEMPTS = 6;

/**
 * @param {object} options
 * @param {GitHub} options.github
 * @param {Store} options.store
 * @param {string} [options.rootRepo]
 * @param {string[]} [options.repos]      explicit list, skips fork discovery
 * @param {number} [options.maxRuns]      cap on runs processed, not on runs listed
 * @param {boolean} [options.withLogs]    read a log head to resolve the PrestaShop version
 * @param {boolean} [options.withTests]   also read failing jobs' logs for the scenario that failed
 * @param {(msg: string) => void} [options.log]
 */
export async function collect({
  github,
  store,
  rootRepo = 'PrestaShop/ga.tests.ui.pr',
  repos,
  maxRuns = 150,
  withLogs = true,
  withTests = true,
  log = () => {},
}) {
  const stats = {
    repos: 0,
    reposUnreadable: 0,
    runsListed: 0,
    runsQueued: 0,
    runsProcessed: 0,
    executions: 0,
    rateLimited: false,
  };

  const targets = repos ?? [rootRepo, ...(await github.listForks(rootRepo))];
  log(`${targets.length} repositories to scan`);

  /** @type {Array<{repo: string, run: object}>} */
  const queue = [];

  try {
    for (const repo of targets) {
      const runs = await github.listDispatchRuns(repo);
      if (runs === null) {
        stats.reposUnreadable += 1;
        continue;
      }
      stats.repos += 1;

      for (const run of runs) {
        if (!isTestWorkflow(run)) continue;
        stats.runsListed += 1;
        // A run still queued or in progress will be listed again next time, so it can never
        // be stranded by being skipped now.
        if (run.status !== 'completed') continue;
        if (store.isUpToDate(repo, run)) continue;
        queue.push({ repo, run });
      }
    }

    stats.runsQueued = queue.length;
    // Newest first: fresh data lands before a long backfill drains.
    queue.sort((a, b) => Date.parse(b.run.created_at) - Date.parse(a.run.created_at));
    log(`${stats.runsListed} runs listed, ${stats.runsQueued} to process, cap ${maxRuns}`);

    for (const { repo, run } of queue.slice(0, maxRuns)) {
      const runFile = await processRun({ github, store, repo, run, withLogs, withTests, log });
      await store.saveRun(repo, runFile);
      stats.runsProcessed += 1;
      stats.executions += runFile.executions.length;
    }
  } catch (err) {
    // Whatever went wrong, every run already written stays written and the index below
    // records it, so the next invocation resumes instead of starting over. The queue is
    // rebuilt from scratch each time, so nothing is lost by stopping here.
    if (err instanceof RateLimitReached) {
      stats.rateLimited = true;
      log(`stopping early: ${err.message}`);
    } else {
      stats.error = err.message;
      log(`stopping early after an unexpected error: ${err.message}`);
    }
  } finally {
    await store.saveIndex();
  }

  return stats;
}

/** @param {{path?: string}} run */
export function isTestWorkflow(run) {
  const file = (run?.path ?? '').split('/').pop();
  return TEST_WORKFLOWS.includes(file);
}

/**
 * Everything worth keeping about one run.
 */
async function processRun({ github, store, repo, run, withLogs, withTests, log }) {
  const jobs = await github.listRunJobs(repo, run.id);
  const { executions, branchFromJobName, buildShopFailed, rawRows } = toExecutions(jobs);
  const isSecurity = (run.path ?? '').endsWith(SECURITY_WORKFLOW);

  const version = await resolveVersion({
    github,
    store,
    repo,
    jobs,
    branchFromJobName,
    withLogs: withLogs && !isSecurity,
    log,
  });

  if (withTests && !isSecurity) {
    await attachFailingTests({ github, repo, executions, log });
  }

  // A failed shop prebuild means the campaigns never ran. Recording them as failures would
  // invent ~45 phantom failures per run, so the run is marked and left out of the rates.
  const aborted = buildShopFailed || executions.length === 0;

  return {
    repo,
    owner: repo.split('/')[0],
    run_id: run.id,
    run_number: run.run_number,
    run_attempt: Number(run.run_attempt) || 1,
    workflow: (run.path ?? '').split('/').pop(),
    status: run.status,
    conclusion: run.conclusion,
    created_at: run.created_at,
    updated_at: run.updated_at,
    html_url: run.html_url,
    is_security: isSecurity,
    aborted,
    final: isFinal(run),
    // Always a number: the logs print it as a string, and PR identity is used as a Set key
    // when measuring how many distinct pull requests a campaign fails on.
    pr_number: isSecurity ? null : (Number(version.prNumber) || null),
    db: version.db ?? null,
    branch_key: version.branchKey,
    branch_key_source: version.source,
    base_branch: version.baseBranch ?? null,
    ps_version: version.psVersion ?? null,
    raw_job_rows: rawRows,
    executions,
  };
}

/**
 * A run stops changing once it went green, hit the retry cap, or has simply been left
 * alone for a while. Non-final runs are re-listed and re-diffed on every invocation
 * anyway, so this is informational rather than load-bearing.
 */
export function isFinal(run, now = Date.now()) {
  if (run.status !== 'completed') return false;
  if (run.conclusion === 'success') return true;
  if ((Number(run.run_attempt) || 1) >= MAX_ATTEMPTS) return true;
  const age = now - Date.parse(run.updated_at ?? run.created_at ?? '');
  return Number.isFinite(age) && age > 2 * 24 * 3600 * 1000;
}

/**
 * Works out which PrestaShop version line a run tested.
 *
 * Order matters, and it is not the cheapest-first order: the log's
 * `base_branch (PR target)` is the only source that is unambiguous in every generation.
 * An older workflow printed `branch_key (matrix key): develop` on a run whose PR targeted
 * 9.2.x, and named its matrix jobs `test (<campaign>, develop)` to match, so trusting
 * either would file those runs under the wrong version. The job name is therefore only a
 * last resort, used when the log has expired (past 90 days).
 */
async function resolveVersion({ github, store, repo, jobs, branchFromJobName, withLogs, log }) {
  const out = { branchKey: UNKNOWN_BRANCH_KEY, source: 'none' };

  if (withLogs) {
    const parsed = await readRunLog({ github, repo, jobs });
    if (parsed) {
      if (parsed.inputs) {
        out.prNumber = parsed.inputs.PR_NUMBER ?? parsed.inputs.pr_number ?? null;
        out.db = parsed.inputs.DB_SERVER ?? parsed.inputs.database ?? null;
      }
      if (parsed.resolved?.baseBranch) {
        out.baseBranch = parsed.resolved.baseBranch;
        out.psVersion = parsed.resolved.psVersion ?? null;
        out.branchKey = branchKeyFromRef(parsed.resolved.baseBranch, parsed.resolved.psVersion);
        out.source = 'resolved-log';
        return out;
      }
      // A log without the resolved block still gives the PR number, and a pull request
      // never expires, so its target branch is still reachable.
      if (out.prNumber) {
        const pr = await lookupPr({ github, store, number: out.prNumber, log });
        if (pr?.base_ref) {
          out.baseBranch = pr.base_ref;
          out.branchKey = branchKeyFromRef(pr.base_ref);
          out.source = 'pr-lookup';
          return out;
        }
      }
    }
  }

  if (branchFromJobName) {
    out.baseBranch = branchFromJobName;
    out.branchKey = branchKeyFromRef(branchFromJobName);
    out.source = 'job-name';
    return out;
  }

  return out;
}

/**
 * Reads which scenario failed inside each red campaign.
 *
 * The mocha report sits at the very end of the log, and the store does not honour suffix
 * ranges, so finding it with a range would mean one request to learn the size and another
 * to fetch the tail. The whole log is one request for about seven times the bytes, and the
 * rate limit is the scarce resource here, not bandwidth.
 *
 * Only campaigns whose test step failed are read: an environment failure has no mocha
 * report to find, and a passing campaign has nothing to say.
 */
async function attachFailingTests({ github, repo, executions, log }) {
  for (const exec of executions) {
    if (exec.failure_kind !== 'test' || !exec.job_id) continue;
    try {
      const text = await github.getJobLog(repo, exec.job_id);
      if (text === null) continue; // expired past 90 days
      const { failingTests, summary } = parseLog(text);
      // `--bail` usually stops at the first, but it is not always on, and a campaign that
      // reported three failing scenarios should be credited with three.
      if (failingTests?.length) exec.failing_tests = failingTests;
      if (summary) exec.test_counts = summary;
    } catch (err) {
      if (err instanceof RateLimitReached) throw err;
      log(`could not read the log of job ${exec.job_id}: ${err.message}`);
    }
  }
}

/**
 * The inputs and resolved-version blocks live near the top of every job of a run, so one
 * 64 KB head slice of any job is enough.
 */
async function readRunLog({ github, repo, jobs }) {
  for (const job of jobs.slice(0, 3)) {
    if (!job?.id) continue;
    const text = await github.getJobLog(repo, job.id, { bytes: LOG_HEAD_BYTES });
    if (text === null) return null; // expired (410): every job of the run is equally gone
    const parsed = parseLog(text);
    if (parsed.inputs || parsed.resolved) return parsed;
  }
  return null;
}

async function lookupPr({ github, store, number, log }) {
  const cached = store.getPr(number);
  if (cached) return cached;

  const pr = await github.getPullRequest(UPSTREAM, number);
  const value = pr?.base?.ref ? { base_ref: pr.base.ref } : { base_ref: null };
  store.setPr(number, value);
  if (!value.base_ref) log(`PR #${number} not found on ${UPSTREAM}`);
  return value;
}
