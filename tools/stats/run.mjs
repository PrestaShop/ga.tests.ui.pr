#!/usr/bin/env node
/**
 * Entry point for the stats puller, used both by the scheduled workflow and locally.
 *
 *   GITHUB_TOKEN=$(gh auth token) node tools/stats/run.mjs \
 *     --repo jolelievre/ga.tests.ui.pr --repo Progi1984/ga.tests.ui.pr \
 *     --max-runs 40 --data-dir ./.local/data --record ./.local/fixtures
 *
 *   node tools/stats/run.mjs --aggregate-only --data-dir ./.local/data --out ./.local/site
 *
 * See tools/stats/README.md.
 */

import { GitHub } from './github.js';
import { Store } from './store.js';
import { collect } from './collect.js';
import { aggregate } from './aggregate.js';
import { cachingTransport } from './cache.js';

const USAGE = `
Usage: node tools/stats/run.mjs [options]

  --repo <owner/name>   Only this repository. Repeatable. Default: the root repo and all its forks.
  --root <owner/name>   Repository whose forks are scanned. Default: PrestaShop/ga.tests.ui.pr
  --max-runs <n>        Cap on runs processed in this invocation. Default: 150
  --data-dir <path>     Where run files live. Default: ./data
  --out <path>          Where the site is generated. Default: ./site
  --no-logs             Skip log reads (faster, but the version of recent runs is less precise)
  --aggregate-only      Rebuild the site from stored run files without calling GitHub
  --collect-only        Pull without rebuilding the site
  --record <dir>        Save every API response for later replay
  --replay <dir>        Serve every API response from a recording; no token or network needed
  --rate-floor <n>      Stop when fewer than this many API requests remain. Default: 300
  -h, --help
`;

function parseArgs(argv) {
  const options = {
    repos: [],
    root: 'PrestaShop/ga.tests.ui.pr',
    maxRuns: 150,
    dataDir: './data',
    outDir: './site',
    withLogs: true,
    collect: true,
    aggregate: true,
    record: null,
    replay: null,
    rateFloor: 300,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '--repo': options.repos.push(next()); break;
      case '--root': options.root = next(); break;
      case '--max-runs': options.maxRuns = Number(next()); break;
      case '--data-dir': options.dataDir = next(); break;
      case '--out': options.outDir = next(); break;
      case '--no-logs': options.withLogs = false; break;
      case '--aggregate-only': options.collect = false; break;
      case '--collect-only': options.aggregate = false; break;
      case '--record': options.record = next(); break;
      case '--replay': options.replay = next(); break;
      case '--rate-floor': options.rateFloor = Number(next()); break;
      case '-h':
      case '--help': options.help = true; break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const log = (msg) => console.log(`[stats] ${msg}`);
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

    log(
      `collected: ${stats.runsProcessed}/${stats.runsQueued} queued runs processed, ` +
        `${stats.executions} executions, ${stats.repos} repositories ` +
        `(${stats.reposUnreadable} unreadable), ${github.requestCount} API requests`,
    );
    if (stats.rateLimited) log('stopped on the rate-limit floor; re-run to continue');
    if (stats.error) log(`stopped on an error, progress was saved: ${stats.error}`);
    if (stats.runsQueued > stats.runsProcessed) {
      log(`${stats.runsQueued - stats.runsProcessed} runs still queued for the next invocation`);
    }
  }

  if (options.aggregate) {
    await aggregate({ dataDir: options.dataDir, outDir: options.outDir, log });
  }

  log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
