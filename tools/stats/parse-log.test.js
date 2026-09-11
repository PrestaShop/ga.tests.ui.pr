import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { cleanLines, parseLog, parseInputs, parseResolved, parseFailingTest, parseMochaSummary } from './parse-log.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

// Real logs, trimmed to their first and last 260 lines (the middle is docker noise).
const FAILURE = fixture('log-current-failure.txt'); // functional:API, --bail, one failing test
const PASS = fixture('log-current-pass.txt'); //      functional:BO:login, all green
const LEGACY = fixture('log-legacy.txt'); //          older generation, branch also in the job name

test('timestamps, ANSI codes and the BOM are stripped', () => {
  const lines = cleanLines('﻿2026-09-10T11:55:26.7718598Z \x1b[36;1mhello\x1b[0m\r\n2026-09-10T11:55:27.0Z bye');
  assert.deepEqual(lines, ['hello', 'bye']);
  assert.deepEqual(cleanLines(''), []);
  assert.deepEqual(cleanLines(undefined), []);
});

test('dispatch inputs are recovered, which is what makes old runs resolvable', () => {
  const inputs = parseInputs(cleanLines(FAILURE));
  assert.equal(inputs.PR_NUMBER, '42816');
  assert.equal(inputs.DB_SERVER, 'mysql');
  assert.equal(inputs.FAST_FAIL, 'true');

  // Same block in the older generation, different PR.
  assert.equal(parseInputs(cleanLines(LEGACY)).PR_NUMBER, '42246');
});

test('the resolved-version block is read past the echoed script that precedes it', () => {
  // The marker appears first inside `##[group]Run echo ...`, where the values are not yet
  // indented output. Parsing must skip that and land on the step's real output.
  const resolved = parseResolved(cleanLines(FAILURE));
  assert.equal(resolved.baseBranch, 'develop');
  assert.equal(resolved.branchKey, 'develop');
  assert.match(resolved.psVersion, /^\d+\.\d+/);

  assert.equal(resolved.branchKeyIsVersion, true);
  assert.equal(resolved.psVersion, '9.3.0');
  assert.ok(resolved.campaigns.includes('functional:API'), 'the campaign list is parsed too');
});

test('an older generation means something else by branch_key, so base_branch wins', () => {
  // That log prints `branch_key (matrix key): develop` on a run whose PR targets 9.2.x.
  // Trusting it would file 9.2.x runs under develop and corrupt the version filter.
  const legacy = parseResolved(cleanLines(LEGACY));
  assert.equal(legacy.baseBranch, '9.2.x');
  assert.equal(legacy.branchKey, 'develop');
  assert.equal(legacy.branchKeyIsVersion, false, 'label is `matrix key`, not `version`');
  assert.equal(legacy.campaigns, undefined, 'that generation did not print the campaign list');
});

test('a passing campaign yields a summary and no failing test', () => {
  const parsed = parseLog(PASS);
  assert.equal(parsed.summary.failing, 0);
  assert.ok(parsed.summary.passing > 0);
  assert.equal(parsed.failingTest, undefined);
});

test('the failing test is located with its spec file and line', () => {
  const parsed = parseLog(FAILURE);
  assert.deepEqual(parsed.summary, { passing: 62, failing: 1, pending: 0 });

  const { failingTest } = parsed;
  assert.match(failingTest.suite, /Check endpoints/);
  assert.equal(failingTest.title, 'should check endpoints');
  assert.match(failingTest.error, /^AssertionError/);
  assert.ok(failingTest.error.length <= 401, 'a 10 KB endpoint diff is capped');
  assert.equal(failingTest.file, 'campaigns/functional/API/02_checkEndpoints.ts');
  assert.equal(failingTest.line, 553);
});

test('a diff truncated by mocha at 8 KB still parses', () => {
  // mocha prints this marker instead of the rest of the diff; the frame still follows.
  const log = [
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

  const failing = parseFailingTest(cleanLines(log));
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
  assert.deepEqual(Object.keys(parsed).sort(), ['failingTest', 'inputs', 'resolved', 'summary']);
});
