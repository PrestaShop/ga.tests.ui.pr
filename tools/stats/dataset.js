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
 * Pure functions, no imports: loaded by the aggregator in Node and by the dashboard in the
 * browser.
 */

export const DATASET_VERSION = 1;

const ABORTED = 1;
const SECURITY = 2;

/**
 * @param {Array<object>} runs run files as written by collect.js
 * @returns {object} compact dataset
 */
export function encodeDataset(runs) {
  const dicts = {
    owner: new Dictionary(),
    workflow: new Dictionary(),
    branch: new Dictionary(),
    db: new Dictionary(),
    campaign: new Dictionary(),
    conclusion: new Dictionary(),
    failureKind: new Dictionary(),
    source: new Dictionary(),
  };

  const packedRuns = [];
  const packedExecs = [];

  const ordered = [...runs].sort((a, b) => Date.parse(a.created_at ?? 0) - Date.parse(b.created_at ?? 0));

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
  };
}

/**
 * @param {object} dataset
 * @returns {Array<object>} runs in the shape metrics.js expects
 */
export function decodeDataset(dataset) {
  if (!dataset || dataset.v !== DATASET_VERSION) {
    throw new Error(`Unsupported dataset version: ${dataset?.v}`);
  }
  const d = dataset.dict;
  const runs = dataset.runs.map((r) => ({
    run_id: r[0],
    owner: d.owner[r[1]],
    repo: `${d.owner[r[1]]}/ga.tests.ui.pr`,
    workflow: d.workflow[r[2]],
    branch_key: d.branch[r[3]],
    db: d.db[r[4]],
    pr_number: r[5] || null,
    created_at: isoString(r[6]),
    run_attempt: r[7],
    aborted: Boolean(r[8] & ABORTED),
    is_security: Boolean(r[8] & SECURITY),
    branch_key_source: d.source[r[9]],
    html_url: `https://github.com/${d.owner[r[1]]}/ga.tests.ui.pr/actions/runs/${r[0]}`,
    executions: [],
  }));

  for (const e of dataset.execs) {
    const startedAt = e[6];
    const duration = e[5] || null;
    runs[e[0]]?.executions.push({
      campaign: d.campaign[e[1]],
      attempt: e[2],
      conclusion: d.conclusion[e[3]],
      failure_kind: d.failureKind[e[4]],
      duration_s: duration,
      started_at: isoString(startedAt),
      // Rebuilt rather than stored: the duration was computed from exactly these two
      // timestamps, so this is lossless and saves a column on every execution.
      completed_at: startedAt && duration !== null ? isoString(startedAt + duration) : null,
    });
  }

  return runs;
}

/** Assigns a stable index to each distinct value; null and undefined share index 0. */
class Dictionary {
  constructor() {
    this.values = [null];
    this.lookup = new Map();
  }

  index(value) {
    if (value === null || value === undefined) return 0;
    const existing = this.lookup.get(value);
    if (existing !== undefined) return existing;
    const next = this.values.length;
    this.values.push(value);
    this.lookup.set(value, next);
    return next;
  }
}

function epochSeconds(timestamp) {
  const t = Date.parse(timestamp ?? '');
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

/**
 * Second precision with no milliseconds, which is how GitHub writes timestamps. Keeping
 * the exact same shape matters: these values are compared as strings when ranking the most
 * recent failure, and `...13.000Z` sorts before `...13Z` even though they are the same
 * instant.
 */
function isoString(seconds) {
  return seconds ? `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z` : null;
}

/**
 * Flat export, one row per campaign execution, for spreadsheets and ad-hoc analysis.
 *
 * @param {Array<object>} runs
 * @returns {string}
 */
export function toCsv(runs) {
  const header = [
    'owner', 'run_id', 'run_url', 'workflow', 'pr_number', 'branch_key', 'branch_key_source',
    'db', 'created_at', 'aborted', 'campaign', 'attempt', 'conclusion', 'failure_kind',
    'duration_s', 'started_at',
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
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return `${rows.join('\n')}\n`;
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
