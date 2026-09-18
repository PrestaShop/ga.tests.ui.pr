#!/usr/bin/env node
/**
 * Entry point for the stats puller, used both by the scheduled workflow and locally.
 *
 *   GITHUB_TOKEN=$(gh auth token) node tools/stats/dist/run.js \
 *     --repo jolelievre/ga.tests.ui.pr --repo Progi1984/ga.tests.ui.pr \
 *     --max-runs 40 --data-dir ./.local/data --record ./.local/fixtures
 *
 *   node tools/stats/dist/run.js --aggregate-only --data-dir ./.local/data --out ./.local/site
 *
 * See tools/stats/README.md. `npm run collect` and `npm run aggregate` wrap the common forms.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { aggregate } from './aggregate.js';
import { cachingTransport } from './cache.js';
import { collect } from './collect.js';
import { GitHub } from './github.js';
import { Store } from './store.js';

const USAGE = `
Usage: node tools/stats/dist/run.js [options]

  --repo <owner/name>   Only this repository. Repeatable. Default: the root repo and all its forks.
  --root <owner/name>   Repository whose forks are scanned. Default: PrestaShop/ga.tests.ui.pr
  --max-runs <n>        Cap on runs processed in this invocation. Default: 150
  --data-dir <path>     Where run files live. Default: ./data
  --out <path>          Where the site is generated. Default: ./site
  --csv <path>          Also write the flat one-row-per-execution CSV export there
  --no-logs             Skip log reads (faster, but the version of recent runs is less precise)
  --aggregate-only      Rebuild the site from stored run files without calling GitHub
  --collect-only        Pull without rebuilding the site
  --record <dir>        Save every API response for later replay
  --replay <dir>        Serve every API response from a recording; no token or network needed
  --rate-floor <n>      Stop when fewer than this many API requests remain. Default: 300
  -h, --help
`;

export interface Options {
  repos: string[];
  root: string;
  maxRuns: number;
  dataDir: string;
  outDir: string;
  csvPath: string | null;
  withLogs: boolean;
  collect: boolean;
  aggregate: boolean;
  record: string | null;
  replay: string | null;
  rateFloor: number;
  help?: boolean;
}

/**
 * `Number('all')` is NaN, and NaN poisons quietly: `queue.slice(0, NaN)` is empty, so a cap
 * of `all` collects nothing and still exits green, while `remaining <= NaN` is always false,
 * so a bad floor turns the rate-limit guard off altogether. Both are reachable from the
 * workflow_dispatch inputs, so both are rejected loudly here instead.
 */
function wholeNumber(value: string, flag: string, min: number): number {
  // `Number('')` is 0, which would pass a floor of zero as a deliberate "never stop" when it
  // is really an unset shell variable.
  const n = String(value).trim() === '' ? NaN : Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(
      `${flag} needs a whole number >= ${min}, got: ${JSON.stringify(value)}`
        + (flag === '--max-runs' ? ' (there is no "no cap" value; pass a large number)' : ''),
    );
  }
  return n;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    repos: [],
    root: 'PrestaShop/ga.tests.ui.pr',
    maxRuns: 150,
    dataDir: './data',
    outDir: './site',
    csvPath: null,
    withLogs: true,
    collect: true,
    aggregate: true,
    record: null,
    replay: null,
    rateFloor: 300,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '--repo': options.repos.push(next()); break;
      case '--root': options.root = next(); break;
      case '--max-runs': options.maxRuns = wholeNumber(next(), arg, 1); break;
      case '--data-dir': options.dataDir = next(); break;
      case '--out': options.outDir = next(); break;
      case '--csv': options.csvPath = next(); break;
      case '--no-logs': options.withLogs = false; break;
      case '--aggregate-only': options.collect = false; break;
      case '--collect-only': options.aggregate = false; break;
      case '--record': options.record = next(); break;
      case '--replay': options.replay = next(); break;
      case '--rate-floor': options.rateFloor = wholeNumber(next(), arg, 0); break;
      case '-h':
      case '--help': options.help = true; break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const log = (msg: string) => console.log(`[stats] ${msg}`);
  const started = Date.now();

  if (options.collect) {
    const replaying = Boolean(options.replay);
    if (!process.env.GITHUB_TOKEN && !replaying) {
      log('warning: GITHUB_TOKEN is not set, the unauthenticated rate limit is 60 requests/hour');
    }

    const transport = options.replay
      ? cachingTransport({ dir: options.replay, mode: 'replay' })
      : options.record
        ? cachingTransport({ dir: options.record, mode: 'record' })
        : undefined;

    const github = new GitHub({ rateFloor: replaying ? 0 : options.rateFloor, transport });
    const store = await new Store(options.dataDir).load();

    const stats = await collect({
      github,
      store,
      rootRepo: options.root,
      repos: options.repos.length > 0 ? options.repos : undefined,
      maxRuns: options.maxRuns,
      withLogs: options.withLogs,
      log,
    });

    const mins = Math.round(stats.elapsedMs / 1000 / 60);
    log(
      `collected: ${stats.runsProcessed}/${stats.runsQueued} queued runs processed, ` +
        `${stats.executions} executions, ${stats.repos} repositories ` +
        `(${stats.reposUnreadable} unreadable, ${stats.reposErrored} errored), ` +
        `${github.requestCount} API requests, ` +
        `${(stats.bytesRead / 1024 / 1024).toFixed(1)} MB of logs, in ${mins} min`,
    );
    // Almost all of the wall clock is spent pulling job logs one at a time, so this is the
    // number that says whether an invocation was slow or merely large.
    if (stats.runsProcessed > 0) {
      log(
        `  ${(stats.bytesRead / 1024 / stats.runsProcessed).toFixed(0)} KB and `
          + `${(github.requestCount / stats.runsProcessed).toFixed(1)} requests per run`,
      );
    }
    if (stats.rateLimited) log('stopped on the rate-limit floor; re-run to continue');
    if (stats.runsQueued > stats.runsProcessed) {
      log(`${stats.runsQueued - stats.runsProcessed} runs still queued for the next invocation`);
    }

    // A partial failure used to be a log line in a green job, which is how a permanently
    // stalled backfill can look like a working one for weeks. Anything that lost data is
    // now an annotation, so it shows on the run itself.
    if (stats.reposErrored > 0) {
      warn(`${stats.reposErrored} repositories could not be listed; their runs are missing from this collection`);
    }
    if (stats.runsFailed > 0) {
      warn(`${stats.runsFailed} runs failed to process and will be retried next time`);
    }
    if (stats.unclassifiedJobNames.length > 0) {
      warn(
        `${stats.unclassifiedJobNames.length} job names matched no known shape, so their campaigns `
          + `were not counted: ${stats.unclassifiedJobNames.slice(0, 10).join(', ')}`,
      );
    }
    // A token that can list a fork's runs but not read its logs produces exactly this
    // shape: listing is public and succeeds, then every log read is forbidden. It is the
    // likeliest misconfiguration here — an organisation-scoped token does not reach a
    // contributor's personal fork — and on its own the symptom reads as an outage rather
    // than as a permissions problem.
    const forbidden = stats.failures.filter((f) => /GitHub 403/.test(f.message));
    if (forbidden.length > 0) {
      const owners = [...new Set(forbidden.map((f) => f.repo.split('/')[0]))];
      warn(
        `${forbidden.length} failures were 403 Forbidden, on: ${owners.slice(0, 5).join(', ')}. `
          + 'A token that lists runs but cannot read job logs needs read access to public '
          + 'repositories owned by anyone, not only by this organisation.',
      );
    }

    for (const f of stats.failures.slice(0, 20)) {
      log(`  failed: ${f.repo}${f.run_id ? `#${f.run_id}` : ''}: ${f.message}`);
    }

    // Nothing at all got through, or the scan itself died: that is not a partial result, and
    // a green job would hide it. Partial progress is still on disk and still committed,
    // because failing the job there would throw away the runs that did succeed.
    if (stats.error) {
      fail(`the collection stopped on an error, progress was saved: ${stats.error}`);
    } else if (stats.runsQueued > 0 && stats.runsProcessed === 0 && !stats.rateLimited) {
      fail(`${stats.runsQueued} runs were queued and none could be processed`);
    }
  }

  if (options.aggregate) {
    await aggregate({
      dataDir: options.dataDir,
      outDir: options.outDir,
      csvPath: options.csvPath,
      log,
    });
  }

  log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
}

/** GitHub Actions renders these on the run itself; elsewhere they are just prefixed lines. */
const IN_ACTIONS = Boolean(process.env.GITHUB_ACTIONS);

function warn(message: string): void {
  console.log(IN_ACTIONS ? `::warning::${message}` : `[stats] warning: ${message}`);
}

function fail(message: string): void {
  console.error(IN_ACTIONS ? `::error::${message}` : `[stats] error: ${message}`);
  process.exitCode = 1;
}

// Only when run as a command. The argument parsing is imported by the tests, and importing
// this file must not start a collection.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
