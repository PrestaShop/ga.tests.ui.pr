/**
 * Reads what the stats need out of a GitHub Actions job log.
 *
 * Three generations of workflow print three different things, so every extractor here is
 * independent and returns undefined when its block is absent:
 *
 *  - `Inputs:` followed by the dispatch inputs as JSON (every generation) -> PR number, DB.
 *  - `Resolved from PR / detected PrestaShop version:` (since prep-pr-context.yml)
 *    -> base branch, branch key, PrestaShop version.
 *  - the mocha report at the end of a failing campaign -> the failing test.
 *
 * Logs are timestamped line by line and carry ANSI colour codes; both are stripped first.
 */

import type { FailingTest, MochaSummary } from './types.js';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** @returns lines without timestamp, ANSI codes, BOM or trailing whitespace */
export function cleanLines(text: string): string[] {
  if (typeof text !== 'string' || text === '') return [];
  return text
    // The BOM, written as an escape rather than as the character itself: a literal one is
    // invisible in every editor and turns up as an irregular-whitespace lint error instead.
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((line) => line.replace(ANSI, '').replace(TIMESTAMP, '').replace(/\r$/, '').trimEnd());
}

export interface ResolvedBlock {
  baseBranch?: string;
  branchKey?: string;
  branchKeyIsVersion?: boolean;
  psVersion?: string;
  phpVersion?: string;
  nodeVersion?: string;
  rebaseOrMerge?: string;
  campaigns?: string[];
}

export interface ParsedLog {
  inputs?: Record<string, unknown>;
  resolved?: ResolvedBlock;
  summary?: MochaSummary;
  failingTests?: FailingTest[];
  failingTest?: FailingTest;
}

/** Everything this module can find, in one pass. */
export function parseLog(text: string): ParsedLog {
  const lines = cleanLines(text);
  const out: ParsedLog = {};
  const inputs = parseInputs(lines);
  if (inputs) out.inputs = inputs;
  const resolved = parseResolved(lines);
  if (resolved) out.resolved = resolved;
  const summary = parseMochaSummary(lines);
  if (summary) out.summary = summary;
  const failingTests = parseFailingTests(lines);
  if (failingTests.length > 0) {
    out.failingTests = failingTests;
    out.failingTest = failingTests[0];
  }
  return out;
}

/**
 * The dispatch inputs, printed as a JSON object by the "Print inputs" step. Present in
 * every generation, which is what makes PR_NUMBER recoverable from old runs.
 */
export function parseInputs(lines: string[]): Record<string, unknown> | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*(echo\s+)?'?\{\s*$/.test(lines[i]!)) continue;
    // Only accept a block that looks like the inputs echo: it must be preceded, within a
    // few lines, by the `Inputs:` label, and must contain quoted "key": "value" pairs.
    const context = lines.slice(Math.max(0, i - 6), i).join('\n');
    if (!/Inputs:/.test(context)) continue;

    const chunk: string[] = [];
    for (let j = i; j < Math.min(lines.length, i + 40); j += 1) {
      chunk.push(lines[j]!.replace(/^\s*echo\s+'/, '').replace(/'\s*$/, ''));
      if (/^\s*\}'?\s*$/.test(lines[j]!)) break;
    }
    const parsed = tryParseJson(chunk.join('\n'));
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  }
  return undefined;
}

/**
 * The `Resolved from PR / detected PrestaShop version:` block, printed since
 * prep-pr-context.yml landed. Keys are `label: value`, one per line, indented.
 */
export function parseResolved(lines: string[]): ResolvedBlock | undefined {
  // The marker appears twice: once in the echoed script of the `##[group]Run ...` header
  // (where each line is `echo "  base_branch ...: x"`), then again in the step's real
  // output. Try every occurrence and keep the first that actually yields fields.
  const fields: Record<string, string> = {};
  const qualifiers: Record<string, string> = {};
  for (let start = 0; start < lines.length; start += 1) {
    if (!/Resolved from PR \/ detected PrestaShop version:/.test(lines[start]!)) continue;

    for (let i = start + 1; i < Math.min(lines.length, start + 40); i += 1) {
      const line = lines[i]!;
      if (line.trim() === '') continue;
      // The block is indented; the first unindented line ends it.
      if (!/^\s{2,}\S/.test(line)) break;
      const m = line.match(/^\s+([a-z_]+)(?:\s*\(([^)]*)\))?:\s*(.*)$/);
      if (!m) continue;
      fields[m[1]!] = m[3]!.trim();
      if (m[2]) qualifiers[m[1]!] = m[2].trim();
    }
    if (Object.keys(fields).length > 0) break;
  }
  if (Object.keys(fields).length === 0) return undefined;

  const out: ResolvedBlock = {};
  if (fields.base_branch) out.baseBranch = fields.base_branch;
  // ⚠️ `branch_key` does not mean the same thing in every generation: an older one printed
  // `branch_key (matrix key): develop` on a run whose `base_branch (PR target)` was 9.2.x,
  // because it named the workflow's matrix axis rather than the version line. Only the
  // label `(version)` means the version line. Callers should derive the key from
  // `baseBranch` instead; this field is kept for cross-checking.
  if (fields.branch_key) {
    out.branchKey = fields.branch_key;
    out.branchKeyIsVersion = qualifiers.branch_key === 'version';
  }
  if (fields.ps_version) out.psVersion = fields.ps_version;
  if (fields.php_version) out.phpVersion = fields.php_version;
  if (fields.node_version) out.nodeVersion = fields.node_version;
  if (fields.rebase_or_merge) out.rebaseOrMerge = fields.rebase_or_merge;
  if (fields.campaigns) out.campaigns = fields.campaigns.split(',').map((c) => c.trim()).filter(Boolean);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `62 passing (3m)` / `1 failing` / `2 pending`. */
export function parseMochaSummary(lines: string[]): MochaSummary | undefined {
  return epilogue(lines)?.counts;
}

/**
 * The mocha epilogue and the line its failure count sits on.
 *
 * Only the FIRST one counts, and only the few lines it spans. A job log does not stop at the
 * report: teardown, container logs and `##[endgroup]` markers follow it, and the counts must
 * not be redefined by whatever down there happens to read as `3 failing`. This is also the
 * anchor `parseFailingTests` uses, so the two can never disagree about which report they are
 * describing.
 */
function epilogue(lines: string[]): { counts: MochaSummary; failingAt: number } | undefined {
  const start = lines.findIndex((line) => /^\s*\d+\s+(?:passing|failing)\b/.test(line));
  if (start === -1) return undefined;

  let passing: number | undefined;
  let failing: number | undefined;
  let pending: number | undefined;
  let failingAt = -1;
  for (let i = start; i < Math.min(lines.length, start + EPILOGUE_LINES); i += 1) {
    const line = lines[i]!;
    const p = line.match(/^\s*(\d+)\s+passing\b/);
    if (p && passing === undefined) passing = Number(p[1]);
    const g = line.match(/^\s*(\d+)\s+pending\b/);
    if (g && pending === undefined) pending = Number(g[1]);
    const f = line.match(/^\s*(\d+)\s+failing\b/);
    if (f && failing === undefined) {
      failing = Number(f[1]);
      failingAt = i;
    }
  }
  return {
    counts: { passing: passing ?? 0, failing: failing ?? 0, pending: pending ?? 0 },
    failingAt,
  };
}

/** `62 passing (3m)` / `2 pending` / `1 failing`, with at most a blank line between them. */
const EPILOGUE_LINES = 6;

/**
 * The first failure block of a mocha spec report.
 *
 * With `--bail` (the default on pr_test_one.yml) there is only ever one.
 */
export function parseFailingTest(lines: string[]): FailingTest | undefined {
  return parseFailingTests(lines)[0];
}

/**
 * Every failure block of a mocha spec report.
 *
 * With `--bail` (the default on pr_test_one.yml) there is only one, but the flag is not
 * always on, and a campaign that reports three failing scenarios should be credited with
 * three rather than only its first.
 */
export function parseFailingTests(lines: string[]): FailingTest[] {
  // The spec reporter already prints `1) <title>` inline where the test ran, so anchor on
  // the `N failing` summary and read the blocks that follow it. Without that anchor the
  // inline line matches first and yields a heading with no suite.
  const found = epilogue(lines);
  if (!found || found.failingAt === -1 || found.counts.failing === 0) return [];

  /** Indices of each `N) ...` heading after the summary. */
  const starts: number[] = [];
  for (let i = found.failingAt; i < lines.length; i += 1) {
    if (/^\s*\d+\)\s+\S/.test(lines[i]!)) starts.push(i);
  }
  if (starts.length === 0) return [];

  // mocha prints exactly as many failure blocks as it counted, and the log keeps going
  // afterwards. A teardown line of the shape `1) restart mysql container` reads as another
  // heading, and the block parser would then name the scenario after whatever followed it —
  // `##[endgroup]`, in the case that turned up in review — and rank that phantom alongside
  // real failures. The count is the authority on how many there are.
  const real = starts.slice(0, found.counts.failing);

  // The end bound still comes from the full list, so the last real block stops where the
  // next heading-shaped line begins rather than running to the end of the log.
  return real
    .map((start, n) => parseOneFailure(lines, start, starts[n + 1] ?? lines.length))
    .filter((t): t is FailingTest => t !== null);
}

/**
 * One failure block:
 *
 *     1) API : Check endpoints
 *          Check endpoints
 *            should check endpoints:
 *
 *         AssertionError: expected [ ... ] to deeply equal [ ... ]
 *         at Context.<anonymous> (campaigns/functional/API/02_checkEndpoints.ts:553:33)
 */
function parseOneFailure(lines: string[], start: number, end: number): FailingTest | null {
  const first = lines[start]!.replace(/^\s*\d+\)\s*/, '').trim();
  const heading = [first];
  let i = start + 1;

  // A hook failure puts everything on the heading line, ending in a colon:
  //     1) "after each" hook for "should click on the PDF button":
  // Without this the loop would keep swallowing lines and end up calling the scenario
  // "Call log", which is part of Playwright's error output rather than a test name.
  const headingComplete = /:$/.test(first);

  for (; !headingComplete && i < Math.min(end, start + 12); i += 1) {
    const line = lines[i]!;
    if (line.trim() === '') break;
    heading.push(line.trim());
    if (/:$/.test(line.trim())) {
      i += 1;
      break;
    }
  }

  const titleRaw = heading[heading.length - 1] ?? '';
  const title = titleRaw.replace(/:$/, '').trim();
  if (!title) return null;
  const suite = heading.slice(0, -1).join(' > ');

  // First non-empty line after the heading is the assertion message. It can be enormous
  // (a full endpoint-list diff runs to 10 KB on one line), and only its head is useful for
  // grouping failures, so it is capped.
  let error = '';
  for (let j = i; j < Math.min(end, i + 10); j += 1) {
    if (lines[j]!.trim() !== '') {
      error = truncate(lines[j]!.trim(), 400);
      break;
    }
  }

  const where = findSpecLocation(lines, start, end);
  return { suite, title, error, file: where?.file ?? null, line: where?.line ?? null };
}

/**
 * Where the failure happened, preferring the campaign spec.
 *
 * A timeout inside a page object reports the helper first
 * (`tests/UI/node_modules/@prestashop-core/ui-testing/dist/pages/commonPage.js:8`), which
 * names no scenario and is the same file for every such failure. The first frame under
 * `campaigns/` is the spec somebody would actually open, so it wins whenever the stack has
 * one.
 */
function findSpecLocation(lines: string[], from: number, to = lines.length): { file: string; line: number } | null {
  let fallback: { file: string; line: number } | null = null;
  for (let i = from; i < to; i += 1) {
    const m = lines[i]!.match(/\(?((?:campaigns|tests)\/[^\s():]+\.[tj]s):(\d+):(\d+)\)?/);
    if (!m) continue;
    const found = { file: m[1]!, line: Number(m[2]) };
    if (found.file.startsWith('campaigns/')) return found;
    if (!fallback) fallback = found;
  }
  return fallback;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
