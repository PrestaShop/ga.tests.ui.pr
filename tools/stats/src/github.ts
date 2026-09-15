/**
 * Minimal GitHub REST client for the stats puller. No dependencies, native fetch.
 *
 * Everything it reads is public, so a plain user token or a fine-grained PAT with
 * read-only Actions access on public repositories is enough — including for runs that
 * live on a contributor's fork.
 */

import type { JobRow } from './executions.js';

const API = 'https://api.github.com';

/** Stop before the limit is actually reached, so an invocation always ends cleanly. */
export const DEFAULT_RATE_FLOOR = 300;

export class RateLimitReached extends Error {
  readonly remaining: number;

  constructor(remaining: number) {
    super(`GitHub rate limit floor reached (${remaining} requests left)`);
    this.name = 'RateLimitReached';
    this.remaining = remaining;
  }
}

/** A transport can mark a failure as permanent, so it is not retried. See cache.ts. */
export interface MaybeRetryable {
  retryable?: boolean;
}

export interface Transport {
  fetch: typeof globalThis.fetch;
}

export interface GitHubOptions {
  token?: string | undefined;
  /** Stop when fewer than this many requests remain. */
  rateFloor?: number;
  onRequest?: (event: { url: string; status: number; remaining: number }) => void;
  transport?: Transport | undefined;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Non-2xx codes to return instead of throwing. */
  allow?: number[];
}

/** One `workflow_dispatch` run, reduced to what the collector reads. */
export interface WorkflowRun {
  id: number;
  run_number?: number;
  run_attempt?: number;
  path?: string;
  status?: string;
  conclusion?: string | null;
  created_at: string;
  updated_at?: string;
  html_url?: string;
}

export class GitHub {
  private readonly token: string | undefined;
  private readonly rateFloor: number;
  private readonly onRequest: GitHubOptions['onRequest'];
  private readonly fetch: typeof globalThis.fetch;
  remaining = Infinity;
  requestCount = 0;

  constructor({
    token = process.env.GITHUB_TOKEN,
    rateFloor = DEFAULT_RATE_FLOOR,
    onRequest,
    transport,
  }: GitHubOptions = {}) {
    this.token = token;
    this.rateFloor = rateFloor;
    this.onRequest = onRequest;
    this.fetch = transport?.fetch ?? globalThis.fetch;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ga.tests.ui.pr-stats',
      ...extra,
    };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  /** @param path absolute URL, or a path like `/repos/o/r/actions/runs` */
  async request(path: string, { headers = {}, allow = [] }: RequestOptions = {}): Promise<Response> {
    if (this.remaining <= this.rateFloor) throw new RateLimitReached(this.remaining);

    const url = path.startsWith('http') ? path : `${API}${path}`;
    const res = await this.fetchWithRetry(url, { headers: this.headers(headers) });
    this.requestCount += 1;

    // Careful: `Number(null)` and `Number('')` are both 0, so a response without the header
    // would otherwise look like an exhausted quota and stop the run immediately.
    const header = res.headers.get('x-ratelimit-remaining');
    if (header !== null && header !== '') {
      const remaining = Number(header);
      if (Number.isFinite(remaining)) this.remaining = remaining;
    }
    this.onRequest?.({ url, status: res.status, remaining: this.remaining });

    if (res.status === 403 && this.remaining === 0) throw new RateLimitReached(0);
    if (!res.ok && !allow.includes(res.status)) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub ${res.status} on ${url}${body ? `: ${body.slice(0, 300)}` : ''}`);
    }
    return res;
  }

  /**
   * A single dropped connection or a brief 5xx must not throw away an invocation that has
   * already made hundreds of requests, so transient failures are retried with backoff.
   * Anything the server answers deliberately (404, 410, 422, ...) is returned untouched.
   */
  async fetchWithRetry(url: string, init: RequestInit, attempts = 4): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const res = await this.fetch(url, init);
        const retryable = res.status >= 500 || res.status === 429 || isSecondaryRateLimit(res);
        if (!retryable || attempt === attempts) return res;
        await sleep(backoffMs(attempt, res));
      } catch (err) {
        // Network-level failure: ECONNRESET, socket hang up, DNS, TLS. A transport can opt
        // out when it knows better — a replay miss will never resolve itself.
        lastError = err;
        if ((err as MaybeRetryable)?.retryable === false || attempt === attempts) break;
        await sleep(backoffMs(attempt));
      }
    }
    throw lastError;
  }

  async json<T>(path: string, options?: RequestOptions): Promise<T | null> {
    const res = await this.request(path, options);
    if (options?.allow?.includes(res.status) && !res.ok) return null;
    return res.json() as Promise<T>;
  }

  /**
   * Walks every page of a list endpoint.
   *
   * @param key the array property in the response (`workflow_runs`, `jobs`, ...). Omit it
   *            for endpoints that return a bare array, such as forks.
   */
  async *paginate<T>(path: string, key?: string): AsyncGenerator<T> {
    let url: string | null = path;
    while (url) {
      const res: Response = await this.request(url);
      const body = (await res.json()) as unknown;
      const items: T[] = Array.isArray(body)
        ? (body as T[])
        : (((body as Record<string, unknown>)?.[key ?? ''] as T[]) ?? []);
      for (const item of items) yield item;

      url = nextPageUrl(res.headers.get('link'));
    }
  }

  /** Direct forks of a repository. Repos with Actions disabled are filtered out later, on 404. */
  async listForks(repo: string): Promise<string[]> {
    const out: string[] = [];
    for await (const fork of this.paginate<{ full_name?: string }>(`/repos/${repo}/forks?per_page=100&sort=oldest`)) {
      if (fork?.full_name) out.push(fork.full_name);
    }
    return out;
  }

  /**
   * Every `workflow_dispatch` run of a repository, newest first.
   * Returns null when the repository is unreadable (private, Actions disabled).
   */
  async listDispatchRuns(repo: string): Promise<WorkflowRun[] | null> {
    const runs: WorkflowRun[] = [];
    let url: string | null =
      `/repos/${repo}/actions/runs?per_page=100&event=workflow_dispatch&exclude_pull_requests=true`;
    while (url) {
      // Only these two answers mean the repository itself cannot be read. Everything else —
      // a 502, a dropped connection, a secondary rate limit that outlasted the retries — is
      // a transport failure and must not be laundered into "Actions disabled", which is how
      // a cascade of throttling once made every remaining fork look deliberately closed
      // while the invocation finished green with nothing collected.
      const res: Response = await this.request(url, { allow: [404, 403] });
      if (res.status === 404 || res.status === 403) return null;
      const body = (await res.json()) as { workflow_runs?: WorkflowRun[] };
      for (const run of body?.workflow_runs ?? []) runs.push(run);
      url = nextPageUrl(res.headers.get('link'));
    }
    return runs;
  }

  /**
   * All job rows of a run, across every attempt.
   *
   * ⚠️ These rows contain carried-over duplicates and must go through
   * `toExecutions()` before being counted. See executions.ts.
   */
  async listRunJobs(repo: string, runId: number): Promise<JobRow[]> {
    const jobs: JobRow[] = [];
    for await (const job of this.paginate<JobRow>(
      `/repos/${repo}/actions/runs/${runId}/jobs?filter=all&per_page=100`,
      'jobs',
    )) {
      jobs.push(job);
    }
    return jobs;
  }

  /** A pull request, used to resolve the target branch of old runs. Null when it is gone. */
  async getPullRequest(repo: string, number: number): Promise<{ base?: { ref?: string } } | null> {
    return this.json(`/repos/${repo}/pulls/${number}`, { allow: [404, 410] });
  }

  /**
   * Job log text, optionally only the first `bytes` (a 64 KB head holds the inputs and the
   * resolved-version block, versus ~274 KB for a whole log).
   *
   * Note: suffix ranges (`bytes=-N`) are not honoured by the log store, which answers 200
   * with the full body, so only head ranges are offered here.
   *
   * @returns null when the log has expired (410, after 90 days).
   */
  async getJobLog(repo: string, jobId: number, { bytes }: { bytes?: number } = {}): Promise<string | null> {
    const headers: Record<string, string> = bytes ? { range: `bytes=0-${bytes - 1}` } : {};
    const res = await this.request(`/repos/${repo}/actions/jobs/${jobId}/logs`, {
      headers,
      allow: [404, 410],
    });
    if (res.status === 404 || res.status === 410) return null;
    return res.text();
  }
}

/** GitHub answers 403 with this header when a client is going too fast, which is retryable. */
function isSecondaryRateLimit(res: Response): boolean {
  return res.status === 403 && res.headers.get('retry-after') !== null;
}

/** Honours `Retry-After` when the server sends one, otherwise backs off exponentially. */
function backoffMs(attempt: number, res?: Response): number {
  const retryAfter = Number(res?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000);
  return Math.min(1000 * 2 ** (attempt - 1), 15_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param link value of the `Link` response header
 * @returns the `rel="next"` URL, or null on the last page
 */
export function nextPageUrl(link: string | null): string | null {
  if (!link) return null;
  const next = link.split(',').find((part) => part.includes('rel="next"'));
  if (!next) return null;
  const start = next.indexOf('<');
  const end = next.indexOf('>');
  return start === -1 || end === -1 ? null : next.slice(start + 1, end);
}
