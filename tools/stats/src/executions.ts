/**
 * Turns the raw job rows of a workflow run into the list of campaign executions that
 * actually happened.
 *
 * ⚠️ The whole point of this module is the dedupe rule. When `gh run rerun --failed`
 * creates attempt N, GitHub re-lists EVERY job of the run under attempt N, including the
 * ones it did not re-run. Those carried-over rows get a NEW job id and a RELABELLED
 * `run_attempt`, but keep their ORIGINAL `started_at`/`completed_at`.
 *
 * Measured on run jolelievre/ga.tests.ui.pr#34473576823 (3 attempts): the API returns 138
 * rows for 51 real jobs, 50 of them campaign executions. Counting rows would report 5
 * failures out of 138 (3.6%) instead of 5 out of 50 (10.0%), and would count a campaign that
 * passed once as passing three times.
 *
 * So: an execution is identified by `(job name, started_at)`, and its true attempt is the
 * LOWEST `run_attempt` among the rows sharing that key. Neither `job.id` (new every
 * attempt) nor `job.run_attempt` (relabelled) can be used.
 */

import type { Execution, FailureKind, JobKind } from './types.js';

/** One row of `GET /runs/{id}/jobs?filter=all`, reduced to what is read here. */
export interface JobRow {
  id?: number | null;
  run_attempt?: number | null;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url?: string | null;
  steps?: Array<{ name?: string | null; conclusion?: string | null }> | null;
}

export interface Classified {
  kind: JobKind;
  campaign?: string;
  branch?: string;
}

/** Job name shapes, by workflow generation. */
// pr_test_one.yml names its matrix jobs `test (audit)` / `test (audit, develop)`, but a
// workflow is free to give the job a display name, and pr_security_test_one.yml does:
// `Security PR test (audit, 9.0.x)`. The prefix is therefore optional. It may not contain
// `/`, which is the reusable-workflow separator handled further down, nor `(`, so the
// campaign is always read from the last parenthesised group.
const FLAT_MATRIX = /^(?:[^/(]*\s)?test \(([^,)]+?)(?:\s*,\s*([^)]+?))?\)$/i;
// The same job before its matrix expanded. A run cancelled before `prep` produced the
// campaign list lists one job under the bare `name:` of the matrix job — `test`, or
// `Security PR test` — with no campaign in it, because no campaign ever started.
const UNEXPANDED_MATRIX = /^(?:[^/(]*\s)?tests?$/i;
const INNER_TEST = /^Test\s+(.+)$/; //   reusable inner job: `Test functional:BO:design`
const CALLER_CAMPAIGN = /^(?:Long|Run short campaign|Run single campaign)\s+(.+)$/; // pr_test.yml caller jobs

/** Step names that mean "the test campaign itself ran here", across all workflow shapes. */
const TEST_STEP = [
  /^Run Tests?$/i, //                            pr_test_one.yml, pr_security_test_one.yml
  /^Run campaign .+ on prebuilt shop$/i, //      pr_test.yml -> test-with-prebuilt-shop.yml
  /^Run sanity campaign$/i, //                   test-sanity.yml
];

/** Classifies a job by its name. */
export function classifyJob(name: string | null | undefined): Classified {
  const full = typeof name === 'string' ? name.trim() : '';
  if (!full) return { kind: 'other' };

  // Flat matrix form. The legacy generation carries the branch as a second matrix axis,
  // which is the cheapest source of the version for most of the historical backfill.
  const flat = full.match(FLAT_MATRIX);
  if (flat) {
    const out: Classified = { kind: 'campaign', campaign: flat[1]!.trim() };
    if (flat[2]) out.branch = flat[2].trim();
    return out;
  }

  // Known, and deliberately not a campaign: the matrix never expanded, so nothing ran.
  // Recognised rather than ignored, so it does not read as a workflow rename.
  if (UNEXPANDED_MATRIX.test(full)) return { kind: 'campaign-unexpanded' };

  // Reusable-workflow form: `<caller job> / <inner job>`.
  const sep = full.indexOf(' / ');
  const caller = sep === -1 ? full : full.slice(0, sep).trim();
  const inner = sep === -1 ? '' : full.slice(sep + 3).trim();

  if (/^Prebuild shop/i.test(caller) || /^Build shop artifacts$/i.test(inner)) {
    return { kind: 'build-shop' };
  }
  if (/^Resolve PR/i.test(caller)) return { kind: 'prep' };

  // `Sanity campaign / Test` has no campaign in the inner name, so fall back on the caller.
  if (/^Sanity campaign$/i.test(caller)) return { kind: 'campaign', campaign: 'sanity' };

  const innerMatch = inner.match(INNER_TEST);
  if (innerMatch) return { kind: 'campaign', campaign: innerMatch[1]!.trim() };

  const callerMatch = caller.match(CALLER_CAMPAIGN);
  if (callerMatch) return { kind: 'campaign', campaign: callerMatch[1]!.trim() };

  return { kind: 'other' };
}

/** Finds the step that ran the campaign, whatever the workflow shape. */
export function findTestStep(steps: JobRow['steps']): { name?: string | null; conclusion?: string | null } | undefined {
  if (!Array.isArray(steps)) return undefined;
  return steps.find((s) => s && typeof s.name === 'string' && TEST_STEP.some((re) => re.test(s.name!.trim())));
}

/**
 * Tells a failing test apart from a broken environment, which need different fixes and
 * must not be mixed in the flaky ranking.
 */
export function failureKind(job: JobRow | null | undefined): FailureKind {
  if (!job || job.conclusion !== 'failure') return 'none';
  // Steps are dropped from successful jobs in the fixtures, and absent while a job runs.
  if (!Array.isArray(job.steps) || job.steps.length === 0) return 'unknown';
  const testStep = findTestStep(job.steps);
  if (testStep && testStep.conclusion === 'failure') return 'test';
  const failedBefore = job.steps.some((s) => s && s.conclusion === 'failure');
  return failedBefore ? 'infra' : 'unknown';
}

/** The execution identity: same job, same start = same execution. */
export function executionKey(job: Pick<JobRow, 'name' | 'started_at'> | null | undefined): string {
  return `${job?.name ?? ''}\0${job?.started_at ?? ''}`;
}

export interface ToExecutionsResult {
  executions: Execution[];
  branchFromJobName: string | null;
  buildShopFailed: boolean;
  maxAttempt: number;
  rawRows: number;
  unclassified: string[];
}

/** Collapses raw job rows into real campaign executions. */
export function toExecutions(jobs: JobRow[] | null | undefined): ToExecutionsResult {
  const rows = Array.isArray(jobs) ? jobs : [];
  const byExecution = new Map<string, Execution>();
  // Job names that matched no known shape. A workflow rename silently turns every campaign
  // of a run into nothing, which reads downstream as an aborted run rather than as a bug,
  // so the names are carried out and counted instead of being dropped here.
  const unclassified = new Set<string>();
  let branchFromJobName: string | null = null;
  let buildShopFailed = false;
  let maxAttempt = 0;

  for (const job of rows) {
    const attempt = Number(job?.run_attempt) || 1;
    if (attempt > maxAttempt) maxAttempt = attempt;

    const classified = classifyJob(job?.name);
    if (classified.branch && !branchFromJobName) branchFromJobName = classified.branch;
    if (classified.kind === 'build-shop' && job?.conclusion === 'failure') buildShopFailed = true;
    if (classified.kind !== 'campaign') {
      if (classified.kind === 'other' && job?.name) unclassified.add(String(job.name));
      continue;
    }

    const key = executionKey(job);
    const existing = byExecution.get(key);
    if (existing) {
      // Same execution seen again under a later attempt: keep the lowest attempt, which is
      // the one it really ran in.
      if (attempt < existing.attempt) existing.attempt = attempt;
      continue;
    }

    byExecution.set(key, {
      campaign: classified.campaign!,
      branch: classified.branch ?? null,
      attempt,
      status: job?.status ?? 'completed',
      conclusion: job?.conclusion ?? null,
      started_at: job?.started_at ?? null,
      completed_at: job?.completed_at ?? null,
      duration_s: durationSeconds(job),
      failure_kind: failureKind(job),
      job_id: job?.id ?? null,
      job_url: job?.html_url ?? null,
    });
  }

  const executions = [...byExecution.values()].sort(
    (a, b) => a.attempt - b.attempt || String(a.campaign).localeCompare(String(b.campaign)),
  );

  return {
    executions,
    branchFromJobName,
    buildShopFailed,
    maxAttempt,
    rawRows: rows.length,
    unclassified: [...unclassified].sort(),
  };
}

/** @returns whole seconds, or null when the job has not finished. */
export function durationSeconds(job: Pick<JobRow, 'started_at' | 'completed_at'> | null | undefined): number | null {
  const start = Date.parse(job?.started_at ?? '');
  const end = Date.parse(job?.completed_at ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}
