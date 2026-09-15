/**
 * Reads and writes the data directory: one JSON file per run, plus an index that says what
 * has already been processed.
 *
 * One file per run is what makes an invocation restartable: a run that gains an attempt
 * later is a single small file rewritten, and a crash or a rate-limit stop leaves
 * everything already written intact.
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** @typedef {{run_attempt: number, status: string, updated_at?: string}} IndexEntry */

const INDEX_FILE = 'index.json';
const RUNS_DIR = 'runs';

export class Store {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    /** @type {{runs: Record<string, IndexEntry>, pr_cache: Record<string, object>, updated_at?: string}} */
    this.index = { runs: {}, pr_cache: {} };
    this.dirty = new Set();
  }

  async load() {
    const raw = await readJson(join(this.dataDir, INDEX_FILE));
    if (raw) this.index = { runs: raw.runs ?? {}, pr_cache: raw.pr_cache ?? {} };
    return this;
  }

  /** @param {string} repo @param {number|string} runId */
  static key(repo, runId) {
    return `${repo}#${runId}`;
  }

  /**
   * Has this run already been processed, at this attempt count and status?
   *
   * @param {{repository?: {full_name?: string}, id: number, run_attempt: number, status: string}} run
   * @param {string} repo
   */
  isUpToDate(repo, run) {
    const entry = this.index.runs[Store.key(repo, run.id)];
    if (!entry) return false;
    if ((Number(run.run_attempt) || 1) > (entry.run_attempt ?? 0)) return false;
    if (run.status === 'completed' && entry.status !== 'completed') return false;
    return true;
  }

  /** @param {string} repo @param {object} runFile */
  async saveRun(repo, runFile) {
    const owner = repo.split('/')[0];
    const path = join(this.dataDir, RUNS_DIR, owner, `${runFile.run_id}.json`);
    await writeJson(path, runFile);
    this.index.runs[Store.key(repo, runFile.run_id)] = {
      run_attempt: runFile.run_attempt,
      status: runFile.status,
      updated_at: runFile.updated_at ?? null,
    };
  }

  /** @param {number|string} prNumber */
  getPr(prNumber) {
    return this.index.pr_cache[String(prNumber)] ?? null;
  }

  /** @param {number|string} prNumber @param {object} value */
  setPr(prNumber, value) {
    this.index.pr_cache[String(prNumber)] = value;
  }

  async saveIndex() {
    this.index.updated_at = new Date().toISOString();
    await writeJson(join(this.dataDir, INDEX_FILE), this.index);
  }

  /** Every stored run, for the aggregation step. */
  async *allRuns() {
    const root = join(this.dataDir, RUNS_DIR);
    let owners;
    try {
      owners = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const owner of owners) {
      if (!owner.isDirectory()) continue;
      const files = await readdir(join(root, owner.name));
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const run = await readJson(join(root, owner.name, file));
        if (run) yield run;
      }
    }
  }
}

/** @param {string} path */
export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Writes JSON without ever leaving a half-written file behind.
 *
 * `writeFile` truncates the target first, so a kill between the truncate and the flush
 * leaves a zero-length or partial file. `readJson` forgives a missing file but not a
 * corrupt one, so a torn `index.json` would stop every later invocation until somebody
 * deleted it by hand. Writing beside the target and renaming makes the swap atomic.
 *
 * @param {string} path
 * @param {any} value
 * @param {{pretty?: boolean}} [options] pretty prints by default, so run files stay diffable
 */
export async function writeJson(path, value, { pretty = true } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const body = pretty ? `${JSON.stringify(value, null, 2)}\n` : `${JSON.stringify(value)}\n`;
  const tmp = `${path}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
}
