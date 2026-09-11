/**
 * Turns the stored run files into what the dashboard downloads.
 *
 * Everything is rebuilt from scratch on every invocation: there is no incremental
 * aggregation state that could drift out of sync with the run files, and the whole job
 * takes well under a second for the entire history.
 */

import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store, writeJson } from './store.js';
import { encodeDataset, toCsv } from './dataset.js';
import { campaignStats, filterRuns, runLevelStats, weeklyTrend } from './metrics.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} options
 * @param {string} options.dataDir  where collect.js wrote its run files
 * @param {string} options.outDir   the site directory to (re)generate
 * @param {(msg: string) => void} [options.log]
 */
export async function aggregate({ dataDir, outDir, log = () => {} }) {
  const store = new Store(dataDir);
  const runs = [];
  for await (const run of store.allRuns()) runs.push(run);
  log(`${runs.length} runs loaded from ${dataDir}`);

  const dataOut = join(outDir, 'data');
  await mkdir(dataOut, { recursive: true });

  const dataset = encodeDataset(runs);
  await writeJson(join(dataOut, 'dataset.json'), dataset);
  await writeFile(join(outDir, 'executions.csv'), toCsv(runs), 'utf8');

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

  // The page and the metric code it imports are versioned with the puller, not with the
  // data, so they are copied in on every build.
  await copySite(outDir);

  log(
    `wrote ${outDir}: ${dataset.runs.length} runs, ${dataset.execs.length} executions, ` +
      `${summary.last90.runLevel.runs} runs in the last 90 days`,
  );
  return summary;
}

/** What the dataset actually covers, so the dashboard can be honest about its gaps. */
function coverage(runs) {
  const sources = {};
  const owners = new Set();
  const branches = {};
  let earliest = null;
  let latest = null;

  for (const run of runs) {
    sources[run.branch_key_source ?? 'none'] = (sources[run.branch_key_source ?? 'none'] ?? 0) + 1;
    branches[run.branch_key ?? 'unknown'] = (branches[run.branch_key ?? 'unknown'] ?? 0) + 1;
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

/** Copies the static page and the modules it imports at runtime. */
async function copySite(outDir) {
  await cp(join(HERE, 'site'), outDir, { recursive: true });
  // The dashboard imports these directly, so the browser runs exactly the code the tests cover.
  await cp(join(HERE, 'metrics.js'), join(outDir, 'metrics.js'));
  await cp(join(HERE, 'dataset.js'), join(outDir, 'dataset.js'));
}
