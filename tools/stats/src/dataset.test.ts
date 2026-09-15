import { test } from 'vitest';
import assert from 'node:assert/strict';

import { encodeDataset, decodeDataset, toCsv, DATASET_VERSION } from './dataset.js';
import { campaignStats, runLevelStats } from './metrics.js';
import type { PackedDataset, RunFile } from './types.js';

const sample: RunFile[] = [
  {
    repo: 'jolelievre/ga.tests.ui.pr',
    owner: 'jolelievre',
    run_id: 34473576823,
    run_attempt: 3,
    workflow: 'pr_test_one.yml',
    status: 'completed',
    html_url: 'https://github.com/jolelievre/ga.tests.ui.pr/actions/runs/34473576823',
    created_at: '2026-09-10T11:52:13Z',
    pr_number: 42816,
    db: 'mysql',
    branch_key: 'develop',
    branch_key_source: 'resolved-log',
    is_security: false,
    aborted: false,
    executions: [
      { campaign: 'functional:API', attempt: 1, conclusion: 'failure', failure_kind: 'test', duration_s: 520, started_at: '2026-09-10T11:55:24Z', completed_at: '2026-09-10T12:04:04Z' },
      { campaign: 'functional:API', attempt: 2, conclusion: 'success', failure_kind: 'none', duration_s: 480, started_at: '2026-09-10T13:11:46Z', completed_at: '2026-09-10T13:19:46Z' },
      { campaign: 'functional:BO:login', attempt: 1, conclusion: 'success', failure_kind: 'none', duration_s: 460, started_at: '2026-09-10T11:58:23Z', completed_at: '2026-09-10T12:06:03Z' },
    ],
  },
  {
    repo: 'Progi1984/ga.tests.ui.pr',
    owner: 'Progi1984',
    run_id: 999,
    run_attempt: 1,
    workflow: 'pr_security_test_one.yml',
    status: 'completed',
    html_url: 'https://github.com/Progi1984/ga.tests.ui.pr/actions/runs/999',
    created_at: '2026-09-09T08:00:00Z',
    pr_number: null,
    db: null,
    branch_key: 'unknown',
    branch_key_source: 'none',
    is_security: true,
    aborted: true,
    executions: [{ campaign: 'sanity', attempt: 1, conclusion: 'skipped', failure_kind: 'none', duration_s: null, started_at: null, completed_at: null }],
  },
];

test('a dataset survives the round trip unchanged', () => {
  const decoded = decodeDataset(encodeDataset(sample));

  // Encoding sorts by date, so compare by run id.
  const byId = Object.fromEntries(decoded.map((r) => [r.run_id, r]));
  const first = byId[34473576823];

  assert.equal(first.owner, 'jolelievre');
  assert.equal(first.workflow, 'pr_test_one.yml');
  assert.equal(first.branch_key, 'develop');
  assert.equal(first.branch_key_source, 'resolved-log');
  assert.equal(first.pr_number, 42816);
  assert.equal(first.db, 'mysql');
  assert.equal(first.run_attempt, 3);
  assert.equal(first.aborted, false);
  assert.equal(first.is_security, false);
  assert.equal(first.created_at, '2026-09-10T11:52:13Z');
  assert.equal(first.html_url, 'https://github.com/jolelievre/ga.tests.ui.pr/actions/runs/34473576823');
  assert.deepEqual(first.executions, sample[0].executions);
});

test('null values round trip as null, not as an empty string', () => {
  const decoded = decodeDataset(encodeDataset(sample));
  const security = decoded.find((r) => r.is_security)!;

  assert.equal(security.pr_number, null);
  assert.equal(security.db, null);
  assert.equal(security.aborted, true);
  assert.equal(security.executions[0]!.duration_s, null);
  assert.equal(security.executions[0]!.started_at, null);
  assert.equal(security.executions[0]!.completed_at, null);
});

test('the end of an execution is rebuilt, not stored', () => {
  const decoded = decodeDataset(encodeDataset(sample));
  const api = decoded.find((r) => r.run_id === 34473576823)!.executions[0]!;
  // Derived as started_at + duration_s, which is exactly how duration was measured.
  assert.equal(api.completed_at, '2026-09-10T12:04:04Z');
  assert.equal(encodeDataset(sample).execs[0]!.length, 7, 'no column is spent on it');
});

test('the metrics are identical before and after encoding', () => {
  // The dashboard computes from the decoded dataset, so the two must agree exactly.
  const decoded = decodeDataset(encodeDataset(sample));
  assert.deepEqual(runLevelStats(decoded), runLevelStats(sample));
  assert.deepEqual(campaignStats(decoded), campaignStats(sample));
});

test('repeated strings are stored once', () => {
  const many: RunFile[] = Array.from({ length: 50 }, (_, i) => ({
    ...sample[0]!,
    run_id: 1000 + i,
    executions: [{ campaign: 'functional:API', attempt: 1, conclusion: 'success', failure_kind: 'none', duration_s: 1, started_at: null, completed_at: null }],
  }));
  const encoded = encodeDataset(many);

  assert.equal(encoded.dict.campaign!.filter(Boolean).length, 1);
  assert.equal(encoded.dict.owner!.filter(Boolean).length, 1);
  assert.equal(encoded.runs.length, 50);
  // Each run row is a short array of numbers, not an object with repeated keys.
  assert.ok(encoded.runs.every((r) => Array.isArray(r) && r.length === 10));
});

test('an unknown dataset version is refused rather than misread', () => {
  // Deliberately not a dataset: the guard exists for exactly the shapes a caller should not
  // be able to build, so the casts are the point rather than a convenience.
  assert.throws(() => decodeDataset({ v: DATASET_VERSION + 1 } as PackedDataset), /Unsupported dataset version/);
  assert.throws(() => decodeDataset(null as unknown as PackedDataset), /Unsupported dataset version/);
});

test('the CSV export has one row per execution and quotes what it must', () => {
  const csv = toCsv(decodeDataset(encodeDataset(sample)));
  const lines = csv.trim().split('\n');

  assert.equal(lines.length, 1 + 4, 'header plus four executions');
  assert.match(lines[0]!, /^owner,run_id,run_url,/);
  assert.ok(lines.some((l) => l.includes('functional:API,1,failure,test')));

  const tricky = toCsv([
    {
      ...sample[0]!,
      executions: [
        { ...sample[0]!.executions[0]!, campaign: 'a,b "quoted"', conclusion: 'success', failure_kind: 'none' },
      ],
    },
  ]);
  assert.match(tricky, /"a,b ""quoted"""/);
});
