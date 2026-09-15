/**
 * Packs the run files into one small file the dashboard can download whole, and unpacks it
 * again in the browser.
 *
 * The dashboard filters and sorts client-side so that any combination of version, campaign,
 * database, window and fork works without the aggregator having to precompute a
 * cross-product of views. That only works if the whole dataset is small enough to ship:
 * hence dictionary encoding (every repeated string becomes an index) and arrays instead of
 * objects. ~90k executions come to a few MB raw, which GitHub Pages serves gzipped.
 *
 * Pure functions, no imports beyond types: loaded by the aggregator in Node and by the
 * dashboard in the browser.
 */

import type {
  BranchKeySource,
  DecodedRun,
  Execution,
  FailureKind,
  PackedDataset,
  RunFile,
} from './types.js';

export const DATASET_VERSION = 1;

const ABORTED = 1;
const SECURITY = 2;

/** @param runs run files as written by collect.ts */
export function encodeDataset(runs: RunFile[]): PackedDataset {
  const dicts = {
    owner: new Dictionary(),
    workflow: new Dictionary(),
    branch: new Dictionary(),
    db: new Dictionary(),
    campaign: new Dictionary(),
    conclusion: new Dictionary(),
    failureKind: new Dictionary(),
    source: new Dictionary(),
    // Which scenario failed. Repeated heavily by definition: a flaky scenario is one that
    // fails again and again, so these compress well.
    suite: new Dictionary(),
    title: new Dictionary(),
    file: new Dictionary(),
    error: new Dictionary(),
  };

  const packedRuns: number[][] = [];
  const packedExecs: number[][] = [];
  // Sparse: only failing executions have a scenario, so they are kept out of the main rows.
  const packedTests: number[][] = [];

  const ordered = [...runs].sort((a, b) => Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? ''));

  for (const run of ordered) {
    const runIndex = packedRuns.length;
    let flags = 0;
    if (run.aborted) flags |= ABORTED;
    if (run.is_security) flags |= SECURITY;

    packedRuns.push([
      run.run_id,
      dicts.owner.index(run.owner),
      dicts.workflow.index(run.workflow),
      dicts.branch.index(run.branch_key),
      dicts.db.index(run.db),
      Number(run.pr_number) || 0,
      epochSeconds(run.created_at),
      Number(run.run_attempt) || 1,
      flags,
      dicts.source.index(run.branch_key_source),
    ]);

    for (const exec of run.executions ?? []) {
      const execIndex = packedExecs.length;
      // One row per failing scenario: an execution can report several when --bail is off.
      for (const failing of exec.failing_tests ?? []) {
        packedTests.push([
          execIndex,
          dicts.suite.index(failing.suite),
          dicts.title.index(failing.title),
          dicts.file.index(failing.file),
          failing.line ?? 0,
          dicts.error.index(failing.error),
        ]);
      }
      packedExecs.push([
        runIndex,
        dicts.campaign.index(exec.campaign),
        exec.attempt,
        dicts.conclusion.index(exec.conclusion),
        dicts.failureKind.index(exec.failure_kind),
        exec.duration_s ?? 0,
        epochSeconds(exec.started_at),
      ]);
    }
  }

  return {
    v: DATASET_VERSION,
    generated_at: new Date().toISOString(),
    dict: Object.fromEntries(Object.entries(dicts).map(([name, d]) => [name, d.values])),
    runs: packedRuns,
    execs: packedExecs,
    tests: packedTests,
  };
}

/** @returns runs in the shape metrics.ts expects */
export function decodeDataset(dataset: PackedDataset): DecodedRun[] {
  if (!dataset || dataset.v !== DATASET_VERSION) {
    throw new Error(`Unsupported dataset version: ${dataset?.v}`);
  }
  const d = dataset.dict;
  const text = (name: string, index: number | undefined): string =>
    (d[name]?.[index ?? 0] ?? '') as string;
  const maybe = (name: string, index: number | undefined): string | null =>
    (d[name]?.[index ?? 0] ?? null) as string | null;

  const runs: DecodedRun[] = dataset.runs.map((r) => {
    const owner = text('owner', r[1]);
    return {
      run_id: r[0]!,
      owner,
      repo: `${owner}/ga.tests.ui.pr`,
      workflow: text('workflow', r[2]),
      branch_key: text('branch', r[3]),
      db: maybe('db', r[4]),
      pr_number: r[5] || null,
      created_at: isoString(r[6]) ?? '',
      run_attempt: r[7]!,
      status: 'completed',
      aborted: Boolean((r[8] ?? 0) & ABORTED),
      is_security: Boolean((r[8] ?? 0) & SECURITY),
      branch_key_source: text('source', r[9]) as BranchKeySource,
      html_url: `https://github.com/${owner}/ga.tests.ui.pr/actions/runs/${r[0]}`,
      executions: [],
    };
  });

  /** Execution objects in the same order they were packed, so `tests` can point at them. */
  const flatExecs: Execution[] = [];

  for (const e of dataset.execs) {
    const startedAt = e[6] ?? 0;
    const duration = e[5] || null;
    const exec: Execution = {
      campaign: text('campaign', e[1]),
      attempt: e[2]!,
      conclusion: maybe('conclusion', e[3]),
      failure_kind: (maybe('failureKind', e[4]) ?? 'none') as FailureKind,
      duration_s: duration,
      started_at: isoString(startedAt),
      // Rebuilt rather than stored: the duration was computed from exactly these two
      // timestamps, so this is lossless and saves a column on every execution.
      completed_at: startedAt && duration !== null ? isoString(startedAt + duration) : null,
    };
    flatExecs.push(exec);
    runs[e[0]!]?.executions.push(exec);
  }

  for (const t of dataset.tests ?? []) {
    const exec = flatExecs[t[0]!];
    if (!exec) continue;
    (exec.failing_tests ??= []).push({
      suite: text('suite', t[1]),
      title: text('title', t[2]),
      file: maybe('file', t[3]),
      line: t[4] || null,
      error: text('error', t[5]),
    });
  }

  return runs;
}

/** Assigns a stable index to each distinct value; null and undefined share index 0. */
class Dictionary {
  readonly values: Array<string | null> = [null];
  private readonly lookup = new Map<string, number>();

  index(value: string | null | undefined): number {
    if (value === null || value === undefined) return 0;
    const existing = this.lookup.get(value);
    if (existing !== undefined) return existing;
    const next = this.values.length;
    this.values.push(value);
    this.lookup.set(value, next);
    return next;
  }
}

function epochSeconds(timestamp: string | null | undefined): number {
  const t = Date.parse(timestamp ?? '');
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

/**
 * Second precision with no milliseconds, which is how GitHub writes timestamps. Keeping
 * the exact same shape matters: these values are compared as strings when ranking the most
 * recent failure, and `...13.000Z` sorts before `...13Z` even though they are the same
 * instant.
 */
function isoString(seconds: number): string | null {
  return seconds ? `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z` : null;
}

/** Flat export, one row per campaign execution, for spreadsheets and ad-hoc analysis. */
export function toCsv(runs: DecodedRun[]): string {
  const header = [
    'owner', 'run_id', 'run_url', 'workflow', 'pr_number', 'branch_key', 'branch_key_source',
    'db', 'created_at', 'aborted', 'campaign', 'attempt', 'conclusion', 'failure_kind',
    'duration_s', 'started_at', 'failed_scenarios', 'failed_scenario_files',
  ];
  const rows = [header.join(',')];

  for (const run of runs) {
    for (const exec of run.executions ?? []) {
      rows.push(
        [
          run.owner, run.run_id, run.html_url, run.workflow, run.pr_number ?? '', run.branch_key,
          run.branch_key_source, run.db ?? '', run.created_at, run.aborted ? 'yes' : 'no',
          exec.campaign, exec.attempt, exec.conclusion ?? '', exec.failure_kind ?? '',
          exec.duration_s ?? '', exec.started_at ?? '',
          (exec.failing_tests ?? []).map((t) => t.title).join(' | '),
          (exec.failing_tests ?? []).map((t) => (t.line ? `${t.file}:${t.line}` : t.file)).join(' | '),
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return `${rows.join('\n')}\n`;
}

function csvCell(value: unknown): string {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
