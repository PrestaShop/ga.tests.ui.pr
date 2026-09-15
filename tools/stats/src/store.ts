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

import type { RunFile } from './types.js';

export interface IndexEntry {
  run_attempt: number;
  status: string;
  updated_at?: string | null;
}

export interface StoreIndex {
  runs: Record<string, IndexEntry>;
  pr_cache: Record<string, { base_ref: string | null }>;
  updated_at?: string;
}

/** What `isUpToDate` needs off a listed run. */
export interface ListedRun {
  id: number;
  run_attempt?: number | null;
  status?: string;
}

const INDEX_FILE = 'index.json';
const RUNS_DIR = 'runs';

export class Store {
  readonly dataDir: string;
  index: StoreIndex = { runs: {}, pr_cache: {} };

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async load(): Promise<this> {
    const raw = await readJson<Partial<StoreIndex>>(join(this.dataDir, INDEX_FILE));
    if (raw) this.index = { runs: raw.runs ?? {}, pr_cache: raw.pr_cache ?? {} };
    return this;
  }

  static key(repo: string, runId: number | string): string {
    return `${repo}#${runId}`;
  }

  /** Has this run already been processed, at this attempt count and status? */
  isUpToDate(repo: string, run: ListedRun): boolean {
    const entry = this.index.runs[Store.key(repo, run.id)];
    if (!entry) return false;
    if ((Number(run.run_attempt) || 1) > (entry.run_attempt ?? 0)) return false;
    if (run.status === 'completed' && entry.status !== 'completed') return false;
    return true;
  }

  async saveRun(repo: string, runFile: RunFile): Promise<void> {
    const owner = repo.split('/')[0]!;
    const path = join(this.dataDir, RUNS_DIR, owner, `${runFile.run_id}.json`);
    await writeJson(path, runFile);
    this.index.runs[Store.key(repo, runFile.run_id)] = {
      run_attempt: runFile.run_attempt,
      status: runFile.status,
      updated_at: runFile.updated_at ?? null,
    };
  }

  getPr(prNumber: number | string): { base_ref: string | null } | null {
    return this.index.pr_cache[String(prNumber)] ?? null;
  }

  setPr(prNumber: number | string, value: { base_ref: string | null }): void {
    this.index.pr_cache[String(prNumber)] = value;
  }

  async saveIndex(): Promise<void> {
    this.index.updated_at = new Date().toISOString();
    await writeJson(join(this.dataDir, INDEX_FILE), this.index);
  }

  /** Every stored run, for the aggregation step. */
  async *allRuns(): AsyncGenerator<RunFile> {
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
        const run = await readJson<RunFile>(join(root, owner.name, file));
        if (run) yield run;
      }
    }
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
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
 * @param options pretty prints by default, so run files stay diffable
 */
export async function writeJson(
  path: string,
  value: unknown,
  { pretty = true }: { pretty?: boolean } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = pretty ? `${JSON.stringify(value, null, 2)}\n` : `${JSON.stringify(value)}\n`;
  const tmp = `${path}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
}
