/**
 * Minimal GitHub REST client for the stats puller. No dependencies, native fetch.
 *
 * Everything it reads is public, so a plain user token or a fine-grained PAT with
 * read-only Actions access on public repositories is enough — including for runs that
 * live on a contributor's fork.
 */

const API = 'https://api.github.com';

/** Stop before the limit is actually reached, so an invocation always ends cleanly. */
export const DEFAULT_RATE_FLOOR = 300;

export class RateLimitReached extends Error {
  constructor(remaining) {
    super(`GitHub rate limit floor reached (${remaining} requests left)`);
    this.name = 'RateLimitReached';
    this.remaining = remaining;
  }
}

export class GitHub {
  /**
   * @param {object} [options]
   * @param {string} [options.token]      defaults to GITHUB_TOKEN
   * @param {number} [options.rateFloor]  stop when fewer than this many requests remain
   * @param {(event: object) => void} [options.onRequest] called after each request, for logging
   * @param {object} [options.transport]  { fetch } override, used by the record/replay cache
   */
  constructor({ token = process.env.GITHUB_TOKEN, rateFloor = DEFAULT_RATE_FLOOR, onRequest, transport } = {}) {
    this.token = token;
    this.rateFloor = rateFloor;
    this.onRequest = onRequest;
    this.fetch = transport?.fetch ?? globalThis.fetch;
    this.remaining = Infinity;
    this.requestCount = 0;
  }

  headers(extra = {}) {
    const h = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ga.tests.ui.pr-stats',
      ...extra,
    };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  /**
   * @param {string} path absolute URL, or a path like `/repos/o/r/actions/runs`
   * @param {object} [options] { headers, allow: number[] of non-2xx codes to return instead of throwing }
   */
  async request(path, { headers = {}, allow = [] } = {}) {
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
  async fetchWithRetry(url, init, attempts = 4) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const res = await this.fetch(url, init);
        const retryable = res.status >= 500 || res.status === 429 || isSecondaryRateLimit(res);
        if (!retryable || attempt === attempts) return res;
        await sleep(backoffMs(attempt, res));
      } catch (err) {
        // Network-level failure: ECONNRESET, socket hang up, DNS, TLS.
        lastError = err;
        if (attempt === attempts) break;
        await sleep(backoffMs(attempt));
      }
    }
    throw lastError;
  }

  async json(path, options) {
    const res = await this.request(path, options);
    if (options?.allow?.includes(res.status) && !res.ok) return null;
    return res.json();
  }

  /**
   * Walks every page of a list endpoint.
   *
   * @param {string} path
   * @param {string} [key] the array property in the response (`workflow_runs`, `jobs`, ...).
   *                       Omit it for endpoints that return a bare array, such as forks.
   */
  async *paginate(path, key) {
    let url = path;
    while (url) {
      const res = await this.request(url);
      const body = await res.json();
      const items = Array.isArray(body) ? body : (body?.[key] ?? []);
      for (const item of items) yield item;

      url = nextPageUrl(res.headers.get('link'));
    }
  }

  /** Direct forks of a repository. Repos with Actions disabled are filtered out later, on 404. */
  async listForks(repo) {
    const out = [];
    for await (const fork of this.paginate(`/repos/${repo}/forks?per_page=100&sort=oldest`)) {
      if (fork?.full_name) out.push(fork.full_name);
    }
    return out;
  }

  /**
   * Every `workflow_dispatch` run of a repository, newest first.
   * Returns null when the repository is unreadable (private, Actions disabled).
   */
  async listDispatchRuns(repo) {
    const runs = [];
    try {
      let url = `/repos/${repo}/actions/runs?per_page=100&event=workflow_dispatch&exclude_pull_requests=true`;
      while (url) {
        const res = await this.request(url, { allow: [404, 403] });
        if (res.status === 404 || res.status === 403) return null;
        const body = await res.json();
        for (const run of body?.workflow_runs ?? []) runs.push(run);
        url = nextPageUrl(res.headers.get('link'));
      }
    } catch (err) {
      if (err instanceof RateLimitReached) throw err;
      return null;
    }
    return runs;
  }

  /**
   * All job rows of a run, across every attempt.
   *
   * ⚠️ These rows contain carried-over duplicates and must go through
   * `toExecutions()` before being counted. See executions.js.
   */
  async listRunJobs(repo, runId) {
    const jobs = [];
    for await (const job of this.paginate(
      `/repos/${repo}/actions/runs/${runId}/jobs?filter=all&per_page=100`,
      'jobs',
    )) {
      jobs.push(job);
    }
    return jobs;
  }

  /** A pull request, used to resolve the target branch of old runs. Null when it is gone. */
  async getPullRequest(repo, number) {
    return this.json(`/repos/${repo}/pulls/${number}`, { allow: [404, 410] });
  }

  /**
   * Job log text, optionally only the first `bytes` (a 64 KB head holds the inputs and the
   * resolved-version block, versus ~274 KB for a whole log).
   *
   * Note: suffix ranges (`bytes=-N`) are not honoured by the log store, which answers 200
   * with the full body, so only head ranges are offered here.
   *
   * @returns {Promise<string|null>} null when the log has expired (410, after 90 days).
   */
  async getJobLog(repo, jobId, { bytes } = {}) {
    const headers = bytes ? { range: `bytes=0-${bytes - 1}` } : {};
    const res = await this.request(`/repos/${repo}/actions/jobs/${jobId}/logs`, {
      headers,
      allow: [404, 410],
    });
    if (res.status === 404 || res.status === 410) return null;
    return res.text();
  }
}

/** GitHub answers 403 with this header when a client is going too fast, which is retryable. */
function isSecondaryRateLimit(res) {
  return res.status === 403 && res.headers.get('retry-after') !== null;
}

/** Honours `Retry-After` when the server sends one, otherwise backs off exponentially. */
function backoffMs(attempt, res) {
  const retryAfter = Number(res?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000);
  return Math.min(1000 * 2 ** (attempt - 1), 15_000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string|null} link value of the `Link` response header
 * @returns {string|null} the `rel="next"` URL, or null on the last page
 */
export function nextPageUrl(link) {
  if (!link) return null;
  const next = link.split(',').find((part) => part.includes('rel="next"'));
  if (!next) return null;
  const start = next.indexOf('<');
  const end = next.indexOf('>');
  return start === -1 || end === -1 ? null : next.slice(start + 1, end);
}
