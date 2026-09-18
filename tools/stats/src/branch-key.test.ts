import { test } from 'vitest';
import assert from 'node:assert/strict';

import { branchKeyFromRef, normalizeRef, parsePsVersion, UNKNOWN_BRANCH_KEY } from './branch-key.js';

test('release branches and develop are already the key', () => {
  // One case per branch offered by the workflows' base_branch dropdown.
  assert.equal(branchKeyFromRef('develop'), 'develop');
  assert.equal(branchKeyFromRef('master'), 'master');
  assert.equal(branchKeyFromRef('9.2.x'), '9.2.x');
  assert.equal(branchKeyFromRef('9.1.x'), '9.1.x');
  assert.equal(branchKeyFromRef('9.0.x'), '9.0.x');
  assert.equal(branchKeyFromRef('8.2.x'), '8.2.x');
  assert.equal(branchKeyFromRef('8.1.x'), '8.1.x');
  assert.equal(branchKeyFromRef('8.0.x'), '8.0.x');
  assert.equal(branchKeyFromRef('1.7.8.x'), '1.7.8.x');
});

test('a future version line needs no change here', () => {
  assert.equal(branchKeyFromRef('9.3.x'), '9.3.x');
  assert.equal(branchKeyFromRef('10.0.x'), '10.0.x');
});

test('every 1.7 branch collapses onto 1.7.8.x', () => {
  assert.equal(branchKeyFromRef('1.7.8.x'), '1.7.8.x');
  assert.equal(branchKeyFromRef('1.7.7.x'), '1.7.8.x');
  assert.equal(branchKeyFromRef('1.7'), '1.7.8.x');
});

test('an unknown ref falls back on the detected PrestaShop version', () => {
  assert.equal(branchKeyFromRef('feature/some-branch', '9.2.0'), '9.2.x');
  assert.equal(branchKeyFromRef('fix-thing', '8.1.7'), '8.1.x');
  assert.equal(branchKeyFromRef('whatever', '1.7.8.11'), '1.7.8.x');
});

test('with neither a release branch nor a version, the key is unknown, never a guess', () => {
  assert.equal(branchKeyFromRef('feature/some-branch'), UNKNOWN_BRANCH_KEY);
  assert.equal(branchKeyFromRef(''), UNKNOWN_BRANCH_KEY);
  assert.equal(branchKeyFromRef(undefined), UNKNOWN_BRANCH_KEY);
  assert.equal(branchKeyFromRef('feature/x', 'not-a-version'), UNKNOWN_BRANCH_KEY);
});

test('qualified refs are normalised first', () => {
  assert.equal(normalizeRef('refs/heads/9.2.x'), '9.2.x');
  assert.equal(normalizeRef('origin/develop'), 'develop');
  assert.equal(normalizeRef('  develop  '), 'develop');
  assert.equal(branchKeyFromRef('refs/heads/8.2.x'), '8.2.x');
});

test('version parsing tolerates the shapes both version files produce', () => {
  assert.deepEqual(parsePsVersion('9.2.0'), { major: 9, minor: 2 });
  assert.deepEqual(parsePsVersion('1.7.8.11'), { major: 1, minor: 7 });
  assert.deepEqual(parsePsVersion('10.0.0-beta.1'), { major: 10, minor: 0 });
  assert.equal(parsePsVersion('nope'), null);
  assert.equal(parsePsVersion(undefined), null);
});
