/**
 * Turns the stored run files into what the dashboard downloads.
 *
 * Everything is rebuilt from scratch on every invocation: there is no incremental
 * aggregation state that could drift out of sync with the run files, and the whole job
 * takes well under a second for the entire history.
 */

import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeDataset, toCsv } from './dataset.js';
import { campaignStats, filterRuns, runLevelStats, weeklyTrend } from './metrics.js';
import { Store, writeJson } from './store.js';
import type { RunFile } from './types.js';

/** dist/ at runtime, because this file is executed compiled. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** Where `vite build` leaves the dashboard. Built by `npm run build:ui`. */
const BUILT_SITE = join(HERE, '..', 'dist-site');

export interface AggregateOptions {
  /** Where collect.ts wrote its run files. */
  dataDir: string;
  /** The site directory to (re)generate. */
  outDir: string;
  /** Also write the flat CSV export here. */
  csvPath?: string | null;
  log?: (msg: string) => void;
}

export async function aggregate({ dataDir, outDir, csvPath, log = () => {} }: AggregateOptions) {
  const store = new Store(dataDir);
  const runs: RunFile[] = [];
  for await (const run of store.allRuns()) runs.push(run);
  log(`${runs.length} runs loaded from ${dataDir}`);

  const dataOut = join(outDir, 'data');
  await mkdir(dataOut, { recursive: true });

  const dataset = encodeDataset(runs);
  // Not pretty-printed: this is the one file every visitor downloads whole, and it is
  // dictionary-packed columnar arrays, so indenting puts each integer on its own line and
  // triples the size of exactly the thing the packing exists to keep small. It is also
  // re-committed daily, where no amount of indentation makes a diff of renumbered arrays
  // readable. The per-run files stay pretty-printed, because those diffs are worth reading.
  await writeJson(join(dataOut, 'dataset.json'), dataset, { pretty: false });

  // The flat CSV is a full-history rebuild every time, so committing it would add a
  // megabyte-scale file to the data branch daily for a convenience nobody reads from the
  // page. It is written only when asked for, with `--csv <path>`. Earlier builds published
  // one here unconditionally, and the site directory is merged rather than replaced, so the
  // stale copy is cleared out or it would sit on the data branch for good.
  await rm(join(outDir, 'executions.csv'), { force: true });

  if (csvPath) {
    await mkdir(dirname(csvPath), { recursive: true });
    await writeFile(csvPath, toCsv(runs), 'utf8');
    log(`wrote ${csvPath}`);
  }

  // A precomputed snapshot for the default view, so the page shows numbers immediately and
  // so the figures are greppable in the repository without opening a browser.
  const withoutSecurity = filterRuns(runs, {});
  const summary = {
    generated_at: dataset.generated_at,
    coverage: coverage(runs),
    last90: {
      runLevel: runLevelStats(filterRuns(runs, { sinceDays: 90 })),
      campaigns: campaignStats(filterRuns(runs, { sinceDays: 90 })).slice(0, 20),
    },
    last30: {
      runLevel: runLevelStats(filterRuns(runs, { sinceDays: 30 })),
      campaigns: campaignStats(filterRuns(runs, { sinceDays: 30 })).slice(0, 20),
    },
    allTime: { runLevel: runLevelStats(withoutSecurity) },
    weekly: weeklyTrend(filterRuns(runs, { sinceDays: 180 })),
  };
  await writeJson(join(dataOut, 'summary.json'), summary);

  await copySite(outDir);

  log(
    `wrote ${outDir}: ${dataset.runs.length} runs, ${dataset.execs.length} executions, ` +
      `${summary.last90.runLevel.runs} runs in the last 90 days`,
  );
  return summary;
}

/** What the dataset actually covers, so the dashboard can be honest about its gaps. */
function coverage(runs: RunFile[]) {
  const sources: Record<string, number> = {};
  const owners = new Set<string>();
  const branches: Record<string, number> = {};
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const run of runs) {
    const source = run.branch_key_source ?? 'none';
    sources[source] = (sources[source] ?? 0) + 1;
    const branch = run.branch_key ?? 'unknown';
    branches[branch] = (branches[branch] ?? 0) + 1;
    owners.add(run.owner);
    if (!earliest || run.created_at < earliest) earliest = run.created_at;
    if (!latest || run.created_at > latest) latest = run.created_at;
  }

  return {
    runs: runs.length,
    executions: runs.reduce((n, r) => n + (r.executions?.length ?? 0), 0),
    owners: owners.size,
    earliest_run: earliest,
    latest_run: latest,
    aborted: runs.filter((r) => r.aborted).length,
    security: runs.filter((r) => r.is_security).length,
    branch_key_sources: sources,
    branch_keys: branches,
  };
}

/**
 * Copies the built dashboard in.
 *
 * Before the Vue refactor this copied the page source plus the two modules it imported at
 * runtime; now Vite has already bundled all of that, so there is a build to depend on and
 * its absence is worth saying out loud rather than publishing a data directory with no page
 * in front of it.
 */
async function copySite(outDir: string): Promise<void> {
  const built = await stat(join(BUILT_SITE, 'index.html')).catch(() => null);
  if (!built) {
    throw new Error(
      `No built dashboard at ${BUILT_SITE}. Run \`npm run build:ui\` (or \`npm run build\`) first.`,
    );
  }
  await cp(BUILT_SITE, outDir, { recursive: true });
}
