import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { cleanLines, parseLog, parseInputs, parseResolved, parseFailingTest, parseFailingTests, parseMochaSummary } from './parse-log.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

// Real logs, trimmed to their first and last 260 lines (the middle is docker noise).
const FAILURE = fixture('log-current-failure.txt'); // functional:API, --bail, one failing test
const PASS = fixture('log-current-pass.txt'); //      functional:BO:login, all green
const LEGACY = fixture('log-legacy.txt'); //          older generation, branch also in the job name

test('timestamps, ANSI codes and the BOM are stripped', () => {
  const lines = cleanLines('﻿2026-09-10T11:55:26.7718598Z \x1b[36;1mhello\x1b[0m\r\n2026-09-10T11:55:27.0Z bye');
  assert.deepEqual(lines, ['hello', 'bye']);
  assert.deepEqual(cleanLines(''), []);
  assert.deepEqual(cleanLines(undefined as unknown as string), []);
});

test('dispatch inputs are recovered, which is what makes old runs resolvable', () => {
  const inputs = parseInputs(cleanLines(FAILURE))!;
  assert.equal(inputs.PR_NUMBER, '42816');
  assert.equal(inputs.DB_SERVER, 'mysql');
  assert.equal(inputs.FAST_FAIL, 'true');

  // Same block in the older generation, different PR.
  assert.equal(parseInputs(cleanLines(LEGACY))!.PR_NUMBER, '42246');
});

test('the resolved-version block is read past the echoed script that precedes it', () => {
  // The marker appears first inside `##[group]Run echo ...`, where the values are not yet
  // indented output. Parsing must skip that and land on the step's real output.
  const resolved = parseResolved(cleanLines(FAILURE))!;
  assert.equal(resolved.baseBranch!, 'develop');
  assert.equal(resolved.branchKey, 'develop');
  assert.match(resolved.psVersion!, /^\d+\.\d+/);

  assert.equal(resolved.branchKeyIsVersion, true);
  assert.equal(resolved.psVersion, '9.3.0');
  assert.ok(resolved.campaigns!.includes('functional:API'), 'the campaign list is parsed too');
});

test('an older generation means something else by branch_key, so base_branch wins', () => {
  // That log prints `branch_key (matrix key): develop` on a run whose PR targets 9.2.x.
  // Trusting it would file 9.2.x runs under develop and corrupt the version filter.
  const legacy = parseResolved(cleanLines(LEGACY))!;
  assert.equal(legacy.baseBranch, '9.2.x');
  assert.equal(legacy.branchKey, 'develop');
  assert.equal(legacy.branchKeyIsVersion, false, 'label is `matrix key`, not `version`');
  assert.equal(legacy.campaigns, undefined, 'that generation did not print the campaign list');
});

test('a passing campaign yields a summary and no failing test', () => {
  const parsed = parseLog(PASS);
  assert.equal(parsed.summary!.failing, 0);
  assert.ok(parsed.summary!.passing > 0);
  assert.equal(parsed.failingTest, undefined);
});

test('the failing test is located with its spec file and line', () => {
  const parsed = parseLog(FAILURE);
  assert.deepEqual(parsed.summary!, { passing: 62, failing: 1, pending: 0 });

  const { failingTest } = parsed;
  assert.match(failingTest!.suite, /Check endpoints/);
  assert.equal(failingTest!.title, 'should check endpoints');
  assert.match(failingTest!.error!, /^AssertionError/);
  assert.ok(failingTest!.error!.length <= 401, 'a 10 KB endpoint diff is capped');
  assert.equal(failingTest!.file, 'campaigns/functional/API/02_checkEndpoints.ts');
  assert.equal(failingTest!.line, 553);
});

test('a diff truncated by mocha at 8 KB still parses', () => {
  // mocha prints this marker instead of the rest of the diff; the frame still follows.
  const log = [
    // Real mocha output always prints the summary before the failure blocks, and the
    // parser anchors on it so it cannot latch onto the reporter's inline `1) <title>`.
    '  1 failing',
    '',
    '  1) FO : Cart',
    '       add to cart',
    '         should add the product:',
    '',
    '      AssertionError: expected 1 to equal 2',
    '      + expected - actual',
    '',
    '      [mocha] output truncated to 8192 characters, see "maxDiffSize" reporter-option',
    '',
    '      at Context.<anonymous> (campaigns/functional/FO/01_cart.ts:42:7)',
  ].join('\n');

  const failing = parseFailingTest(cleanLines(log))!;
  assert.equal(failing.title, 'should add the product');
  assert.equal(failing.suite, 'FO : Cart > add to cart');
  assert.equal(failing.error, 'AssertionError: expected 1 to equal 2');
  assert.equal(failing.file, 'campaigns/functional/FO/01_cart.ts');
  assert.equal(failing.line, 42);
});

test('a log with none of the blocks yields nothing rather than throwing', () => {
  // What an infra failure looks like: the campaign never started.
  const log = [
    '##[group]Run ./.github/actions/setup-env',
    'Error: Process completed with exit code 1.',
    '##[error]Process completed with exit code 1.',
  ].join('\n');

  assert.deepEqual(parseLog(log), {});
  assert.equal(parseMochaSummary(cleanLines(log)), undefined);
  assert.equal(parseFailingTest(cleanLines(log)), undefined);
  assert.deepEqual(parseLog(''), {});
});

test('parseLog assembles every block it can find', () => {
  const parsed = parseLog(FAILURE);
  assert.deepEqual(Object.keys(parsed).sort(), ['failingTest', 'failingTests', 'inputs', 'resolved', 'summary']);
});

test('the campaign spec wins over a page-object helper deeper in the stack', () => {
  // A timeout inside a page object reports the helper first. That file names no scenario and
  // is identical for every such failure, so the spec under campaigns/ is the useful one.
  const log = [
    '  1 failing',
    '',
    '  1) BO - Catalog : Attributes',
    '       should reset third attribute position to 1:',
    '',
    '      page.waitForSelector: Timeout 10000ms exceeded.',
    '      at CommonPage.waitForSelectorAndClick (tests/UI/node_modules/@prestashop-core/ui-testing/dist/pages/commonPage.js:8:15)',
    '      at Context.<anonymous> (campaigns/functional/BO/03_catalog/05_attributes/01_positions.ts:88:5)',
  ].join('\n');

  const failing = parseFailingTest(cleanLines(log))!;
  assert.equal(failing.file, 'campaigns/functional/BO/03_catalog/05_attributes/01_positions.ts');
  assert.equal(failing.line, 88);
  assert.equal(failing.title, 'should reset third attribute position to 1');
});

test('the helper is still reported when the stack has no campaign frame', () => {
  const log = [
    '  1 failing',
    '',
    '  1) Suite',
    '       should do a thing:',
    '',
    '      Error: nope',
    '      at Helper (tests/UI/node_modules/@prestashop-core/ui-testing/dist/pages/commonPage.js:8:15)',
  ].join('\n');
  assert.equal(parseFailingTest(cleanLines(log))!.file, 'tests/UI/node_modules/@prestashop-core/ui-testing/dist/pages/commonPage.js');
});

test('every failure block is read, not only the first', () => {
  const log = [
    '  60 passing (3m)',
    '  2 failing',
    '',
    '  1) Suite A',
    '       should do the first thing:',
    '',
    '      AssertionError: first',
    '      at Context.<anonymous> (campaigns/functional/a.ts:10:1)',
    '',
    '  2) Suite B',
    '       should do the second thing:',
    '',
    '      AssertionError: second',
    '      at Context.<anonymous> (campaigns/functional/b.ts:20:1)',
  ].join('\n');

  const failures = parseFailingTests(cleanLines(log));
  assert.equal(failures.length, 2);
  assert.deepEqual(failures.map((f) => [f.title, f.file, f.line]), [
    ['should do the first thing', 'campaigns/functional/a.ts', 10],
    ['should do the second thing', 'campaigns/functional/b.ts', 20],
  ]);
  assert.equal(failures[0].error, 'AssertionError: first');
  assert.equal(failures[1].error, 'AssertionError: second');
});

test('a log with no failure summary yields an empty list', () => {
  assert.deepEqual(parseFailingTests(cleanLines(PASS)), []);
  assert.deepEqual(parseFailingTests([]), []);
});

test('failure blocks are ignored without the summary that anchors them', () => {
  // The spec reporter prints `1) <title>` inline where the test ran, long before the
  // report at the end. Anchoring on `N failing` is what keeps those out.
  const log = ['      1) should check endpoints', '  ✔ should do something else'].join('\n');
  assert.deepEqual(parseFailingTests(cleanLines(log)), []);
});

test('a hook failure keeps the hook as its name, not Playwright error text', () => {
  // Everything is on the heading line for a hook, ending in a colon. Reading on would
  // swallow the error output and call the scenario "Call log".
  const log = [
    '  1 failing',
    '',
    '  1) "after each" hook for "should click on the "PDF" button":',
    '       page.screenshot: Timeout 30000ms exceeded.',
    '     Call log:',
    '       - taking page screenshot',
  ].join('\n');

  const failing = parseFailingTest(cleanLines(log))!;
  assert.equal(failing.title, '"after each" hook for "should click on the "PDF" button"');
  assert.equal(failing.suite, '');
  assert.equal(failing.error, 'page.screenshot: Timeout 30000ms exceeded.');
});

test('the log does not stop at the report, and neither did the scan', () => {
  // This fixture carries its real tail: 144 lines of artifact upload, `##[endgroup]`
  // markers, git cleanup and deprecation warnings after the mocha report. The scan used to
  // run to the last line of the log, so everything down there was in range.
  const lines = cleanLines(FAILURE);
  const reportAt = lines.findIndex((l) => /^\s*\d+\s+failing\b/.test(l));

  assert.ok(lines.length - reportAt > 100, 'there is a substantial tail after the report');
  assert.ok(lines.some((l) => l.trim() === '##[endgroup]'), 'including the markers that became phantom titles');
  assert.equal(parseFailingTests(lines).length, 1, 'still exactly the one failure mocha counted');
});

test('teardown output shaped like a failure block is not a scenario', () => {
  // Synthetic, and deliberately so: the real logs above happen not to print a numbered list
  // after the report, but nothing stops one — a retry loop, a docker-compose teardown, an
  // npm error list. The heading parser then names the scenario after the following line,
  // which is how `##[endgroup]` reached a ranking of the worst scenarios in review.
  const log = [
    '  62 passing (3m)',
    '  1 failing',
    '',
    '  1) API : Check endpoints',
    '       should check endpoints:',
    '',
    '     AssertionError: expected [] to deeply equal []',
    '      at Context.<anonymous> (campaigns/functional/API/02_checkEndpoints.ts:553:33)',
    '',
    '##[group]Run docker compose down',
    'Stopping the containers in order:',
    '  1) restart mysql container',
    '##[endgroup]',
    '  2) remove the network',
    '##[endgroup]',
  ].join('\n');

  const found = parseFailingTests(cleanLines(log));

  assert.equal(found.length, 1, 'mocha said one failure, so there is one failure');
  assert.equal(found[0].title, 'should check endpoints');
  assert.equal(found[0].file, 'campaigns/functional/API/02_checkEndpoints.ts');
  assert.ok(
    !found.some((t) => t.title.includes('endgroup') || t.title.includes('mysql')),
    'nothing from the teardown got in',
  );
});

test('the real failure block still ends where the teardown begins', () => {
  // The cap decides how many blocks are real; the block after the last real one still has to
  // bound it, or the error and the stack frame would be read out of the teardown instead.
  const log = [
    '  1 failing',
    '',
    '  1) API : Check endpoints',
    '       should check endpoints:',
    '',
    '     TimeoutError: waited too long',
    '      at Context.<anonymous> (campaigns/functional/API/02_checkEndpoints.ts:553:33)',
    '  2) cleanup step',
    '     at Context.<anonymous> (campaigns/teardown/99_wrong.ts:1:1)',
  ].join('\n');

  const found = parseFailingTests(cleanLines(log));

  assert.equal(found.length, 1);
  assert.equal(found[0].error, 'TimeoutError: waited too long');
  assert.equal(found[0].file, 'campaigns/functional/API/02_checkEndpoints.ts', 'not the teardown frame');
});

test('a second summary further down the log does not redefine the counts', () => {
  // A job log can print anything after the report. Only the first epilogue describes what
  // this campaign did, and the summary and the failure scan have to agree on which one that
  // is: they used to disagree, one keeping the last match and the other anchoring on the first.
  const log = [
    '  62 passing (3m)',
    '  2 pending',
    '  1 failing',
    '',
    '  1) API : Check endpoints',
    '       should check endpoints:',
    '',
    '     AssertionError: boom',
    '      at Context.<anonymous> (campaigns/functional/API/02_checkEndpoints.ts:553:33)',
    '',
    'Uploading the mochawesome report, which happens to quote its own totals:',
    '  9 passing (1s)',
    '  3 failing',
  ].join('\n');
  const lines = cleanLines(log);

  assert.deepEqual(parseMochaSummary(lines), { passing: 62, failing: 1, pending: 2 });
  assert.equal(parseFailingTests(lines).length, 1);
});
