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

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * @param {string} text raw log
 * @returns {string[]} lines without timestamp, ANSI codes, BOM or trailing whitespace
 */
export function cleanLines(text) {
  if (typeof text !== 'string' || text === '') return [];
  return text
    .replace(/^﻿/, '')
    .split('\n')
    .map((line) => line.replace(ANSI, '').replace(TIMESTAMP, '').replace(/\r$/, '').trimEnd());
}

/**
 * Everything this module can find, in one pass.
 *
 * @param {string} text
 * @returns {{inputs?: object, resolved?: object, failingTest?: object, summary?: object}}
 */
export function parseLog(text) {
  const lines = cleanLines(text);
  const out = {};
  const inputs = parseInputs(lines);
  if (inputs) out.inputs = inputs;
  const resolved = parseResolved(lines);
  if (resolved) out.resolved = resolved;
  const summary = parseMochaSummary(lines);
  if (summary) out.summary = summary;
  const failingTest = parseFailingTest(lines);
  if (failingTest) out.failingTest = failingTest;
  return out;
}

/**
 * The dispatch inputs, printed as a JSON object by the "Print inputs" step. Present in
 * every generation, which is what makes PR_NUMBER recoverable from old runs.
 *
 * @param {string[]} lines
 * @returns {object|undefined}
 */
export function parseInputs(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*(echo\s+)?'?\{\s*$/.test(lines[i])) continue;
    // Only accept a block that looks like the inputs echo: it must be preceded, within a
    // few lines, by the `Inputs:` label, and must contain quoted "key": "value" pairs.
    const context = lines.slice(Math.max(0, i - 6), i).join('\n');
    if (!/Inputs:/.test(context)) continue;

    const chunk = [];
    for (let j = i; j < Math.min(lines.length, i + 40); j += 1) {
      chunk.push(lines[j].replace(/^\s*echo\s+'/, '').replace(/'\s*$/, ''));
      if (/^\s*\}'?\s*$/.test(lines[j])) break;
    }
    const parsed = tryParseJson(chunk.join('\n'));
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return undefined;
}

/**
 * The `Resolved from PR / detected PrestaShop version:` block, printed since
 * prep-pr-context.yml landed. Keys are `label: value`, one per line, indented.
 *
 * @param {string[]} lines
 * @returns {object|undefined}
 */
export function parseResolved(lines) {
  // The marker appears twice: once in the echoed script of the `##[group]Run ...` header
  // (where each line is `echo "  base_branch ...: x"`), then again in the step's real
  // output. Try every occurrence and keep the first that actually yields fields.
  const fields = {};
  const qualifiers = {};
  for (let start = 0; start < lines.length; start += 1) {
    if (!/Resolved from PR \/ detected PrestaShop version:/.test(lines[start])) continue;

    for (let i = start + 1; i < Math.min(lines.length, start + 40); i += 1) {
      const line = lines[i];
      if (line.trim() === '') continue;
      // The block is indented; the first unindented line ends it.
      if (!/^\s{2,}\S/.test(line)) break;
      const m = line.match(/^\s+([a-z_]+)(?:\s*\(([^)]*)\))?:\s*(.*)$/);
      if (!m) continue;
      fields[m[1]] = m[3].trim();
      if (m[2]) qualifiers[m[1]] = m[2].trim();
    }
    if (Object.keys(fields).length > 0) break;
  }
  if (Object.keys(fields).length === 0) return undefined;

  const out = {};
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

/**
 * `62 passing (3m)` / `1 failing` / `2 pending`.
 *
 * @param {string[]} lines
 * @returns {{passing: number, failing: number, pending: number}|undefined}
 */
export function parseMochaSummary(lines) {
  let passing;
  let failing;
  let pending;
  for (const line of lines) {
    const p = line.match(/^\s*(\d+)\s+passing\b/);
    if (p) passing = Number(p[1]);
    const f = line.match(/^\s*(\d+)\s+failing\b/);
    if (f) failing = Number(f[1]);
    const g = line.match(/^\s*(\d+)\s+pending\b/);
    if (g) pending = Number(g[1]);
  }
  if (passing === undefined && failing === undefined) return undefined;
  return { passing: passing ?? 0, failing: failing ?? 0, pending: pending ?? 0 };
}

/**
 * The first failure block of a mocha spec report:
 *
 *     1) API : Check endpoints
 *          Check endpoints
 *            should check endpoints:
 *
 *         AssertionError: expected [ ... ] to deeply equal [ ... ]
 *         ...
 *         at Context.<anonymous> (campaigns/functional/API/02_checkEndpoints.ts:553:33)
 *
 * With `--bail` (the default on pr_test_one.yml) there is only ever one.
 *
 * @param {string[]} lines
 * @returns {{suite: string, title: string, error: string, file: string|null, line: number|null}|undefined}
 */
export function parseFailingTest(lines) {
  // The spec reporter already prints `1) <title>` inline where the test ran, so anchor on
  // the `N failing` summary and take the block that follows it. Without that anchor the
  // inline line matches first and yields a heading with no suite.
  const summaryAt = lines.findIndex((line) => /^\s*\d+\s+failing\b/.test(line));
  const searchFrom = summaryAt === -1 ? 0 : summaryAt;

  let start = -1;
  for (let i = searchFrom; i < lines.length; i += 1) {
    if (/^\s*1\)\s+\S/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return undefined;

  // The heading is the failure number followed by the suite path, one segment per line,
  // the last of which ends with a colon and is the test title.
  const heading = [lines[start].replace(/^\s*1\)\s*/, '').trim()];
  let i = start + 1;
  for (; i < Math.min(lines.length, start + 12); i += 1) {
    const line = lines[i];
    if (line.trim() === '') break;
    heading.push(line.trim());
    if (/:$/.test(line.trim())) {
      i += 1;
      break;
    }
  }

  const titleRaw = heading[heading.length - 1] ?? '';
  const title = titleRaw.replace(/:$/, '').trim();
  const suite = heading.slice(0, -1).join(' > ');

  // First non-empty line after the heading is the assertion message. It can be enormous
  // (a full endpoint-list diff runs to 10 KB on one line), and only its head is useful for
  // grouping failures, so it is capped.
  let error = '';
  for (let j = i; j < Math.min(lines.length, i + 10); j += 1) {
    if (lines[j].trim() !== '') {
      error = truncate(lines[j].trim(), 400);
      break;
    }
  }

  const where = findSpecLocation(lines, start);
  return { suite, title, error, file: where?.file ?? null, line: where?.line ?? null };
}

/**
 * The first `at ... (campaigns/....ts:LINE:COL)` frame after a failure block, which points
 * at the spec rather than at a helper.
 *
 * @param {string[]} lines
 * @param {number} from
 */
function findSpecLocation(lines, from) {
  for (let i = from; i < lines.length; i += 1) {
    const m = lines[i].match(/\(?((?:campaigns|tests)\/[^\s():]+\.[tj]s):(\d+):(\d+)\)?/);
    if (m) return { file: m[1], line: Number(m[2]) };
  }
  return null;
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * @param {string} text
 * @returns {any|null}
 */
function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
