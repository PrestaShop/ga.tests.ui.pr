import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from './run.mjs';

test('the defaults are the ones the workflow relies on', () => {
  const options = parseArgs([]);
  assert.equal(options.maxRuns, 150);
  assert.equal(options.rateFloor, 300);
  assert.equal(options.collect, true);
  assert.equal(options.aggregate, true);
  assert.equal(options.csvPath, null);
  assert.deepEqual(options.repos, []);
});

test('every option is read', () => {
  const options = parseArgs([
    '--repo', 'a/r', '--repo', 'b/r', '--root', 'o/r', '--max-runs', '40',
    '--data-dir', './d', '--out', './s', '--csv', './e.csv', '--no-logs',
    '--rate-floor', '10', '--record', './rec',
  ]);
  assert.deepEqual(options.repos, ['a/r', 'b/r']);
  assert.equal(options.root, 'o/r');
  assert.equal(options.maxRuns, 40);
  assert.equal(options.dataDir, './d');
  assert.equal(options.outDir, './s');
  assert.equal(options.csvPath, './e.csv');
  assert.equal(options.withLogs, false);
  assert.equal(options.rateFloor, 10);
  assert.equal(options.record, './rec');
});

test('a cap that is not a number is refused rather than silently collecting nothing', () => {
  // `Number('all')` is NaN and `queue.slice(0, NaN)` is empty, so this used to log `cap NaN`,
  // commit nothing and exit green — on exactly the invocation somebody ran to drain a
  // backlog. It is reachable from the workflow_dispatch input, which only guards the empty
  // string.
  for (const bad of ['all', '1,500', '', 'Infinity', '1.5', '-3']) {
    assert.throws(() => parseArgs(['--max-runs', bad]), /--max-runs needs a whole number/, `--max-runs ${bad}`);
  }
  // `0` reads as "no cap" and behaves as "process nothing", which is the same trap.
  assert.throws(() => parseArgs(['--max-runs', '0']), /--max-runs needs a whole number >= 1/);
  assert.equal(parseArgs(['--max-runs', '1']).maxRuns, 1);
});

test('a floor that is not a number is refused rather than disabling the guard', () => {
  // `remaining <= NaN` is always false, so a bad floor turns off the rate-limit stop
  // entirely and the invocation runs until GitHub refuses it outright.
  for (const bad of ['x', '', '-1', '30.5']) {
    assert.throws(() => parseArgs(['--rate-floor', bad]), /--rate-floor needs a whole number/, `--rate-floor ${bad}`);
  }
  assert.equal(parseArgs(['--rate-floor', '0']).rateFloor, 0, 'zero is a deliberate "never stop"');
});

test('an option with no value, and an unknown option, both stop', () => {
  assert.throws(() => parseArgs(['--max-runs']), /--max-runs needs a value/);
  assert.throws(() => parseArgs(['--nope']), /Unknown option: --nope/);
});
