/**
 * @vitest-environment happy-dom
 *
 * Mounting needs a DOM; the collector half of the suite does not, and pays nothing for this.
 */
import { mount } from '@vue/test-utils';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { campaignStats } from '../../../src/metrics.js';
import type { DecodedRun, Execution } from '../../../src/types.js';
import CampaignTable from './CampaignTable.vue';

const exec = (campaign: string, attempt: number, conclusion: string, extra: Partial<Execution> = {}): Execution => ({
  campaign,
  attempt,
  conclusion,
  failure_kind: conclusion === 'failure' ? 'test' : 'none',
  started_at: `2026-09-1${attempt}T10:00:00Z`,
  completed_at: `2026-09-1${attempt}T10:10:00Z`,
  duration_s: 600,
  ...extra,
});

const run = (id: number, executions: Execution[]): DecodedRun => ({
  repo: 'o/ga.tests.ui.pr',
  owner: 'o',
  run_id: id,
  run_attempt: Math.max(...executions.map((e) => e.attempt)),
  workflow: 'pr_test_one.yml',
  status: 'completed',
  created_at: '2026-09-10T10:00:00Z',
  html_url: `https://github.com/o/ga.tests.ui.pr/actions/runs/${id}`,
  is_security: false,
  aborted: false,
  pr_number: 100 + id,
  db: 'mysql',
  branch_key: 'develop',
  branch_key_source: 'resolved-log',
  executions,
});

/** One flaky campaign that cost time, one that always passes. */
const RUNS: DecodedRun[] = [
  run(1, [
    exec('flaky', 1, 'failure', {
      failing_tests: [{ suite: 'S', title: 'should do the thing', error: 'TimeoutError: waited', file: 'campaigns/a.ts', line: 12 }],
    }),
    exec('flaky', 2, 'success'),
    exec('steady', 1, 'success'),
  ]),
  run(2, [exec('flaky', 1, 'success'), exec('steady', 1, 'success')]),
];

test('the ranking opens on the campaign that wasted the most machine time', () => {
  const wrapper = mount(CampaignTable, { props: { rows: campaignStats(RUNS), runs: RUNS } });
  const names = wrapper.findAll('tr.campaign td:first-child').map((td) => td.text());

  assert.deepEqual(names, ['flaky', 'steady'], 'default order is the work queue, not the alphabet');
});

test('clicking a column header sorts by it, and clicking again reverses', async () => {
  const wrapper = mount(CampaignTable, { props: { rows: campaignStats(RUNS), runs: RUNS } });
  const campaignHeader = wrapper.findAll('th')[0]!;

  await campaignHeader.trigger('click');
  assert.deepEqual(
    wrapper.findAll('tr.campaign td:first-child').map((td) => td.text()),
    ['flaky', 'steady'],
    'text sorts ascending first',
  );
  assert.equal(campaignHeader.attributes('aria-sort'), 'ascending');

  await campaignHeader.trigger('click');
  assert.deepEqual(
    wrapper.findAll('tr.campaign td:first-child').map((td) => td.text()),
    ['steady', 'flaky'],
  );
  assert.equal(campaignHeader.attributes('aria-sort'), 'descending');
});

test('clicking a row opens the scenarios behind it, and clicking again closes them', async () => {
  const wrapper = mount(CampaignTable, { props: { rows: campaignStats(RUNS), runs: RUNS } });
  assert.equal(wrapper.find('tr.detail').exists(), false);

  await wrapper.find('tr.campaign').trigger('click');
  const detail = wrapper.find('tr.detail');
  assert.equal(detail.exists(), true);
  assert.match(detail.text(), /should do the thing/);
  assert.match(detail.text(), /campaigns\/a\.ts:12/, 'the spec file somebody would open');
  assert.match(detail.text(), /100%/, 'one scenario accounts for the campaign’s one failure');

  await wrapper.find('tr.campaign').trigger('click');
  assert.equal(wrapper.find('tr.detail').exists(), false);
});

test('the detail lists the runs it failed in, linking each one', async () => {
  const wrapper = mount(CampaignTable, { props: { rows: campaignStats(RUNS), runs: RUNS } });
  await wrapper.find('tr.campaign').trigger('click');

  const link = wrapper.find('tr.detail a');
  assert.equal(link.attributes('href'), 'https://github.com/o/ga.tests.ui.pr/actions/runs/1');
  assert.equal(link.attributes('rel'), 'noopener');
  assert.match(wrapper.find('tr.detail').text(), /green on attempt 2/);
});

test('a filtered-away table says so rather than showing an empty frame', () => {
  const wrapper = mount(CampaignTable, { props: { rows: [], runs: [] } });
  assert.match(wrapper.find('.empty').text(), /Nothing matches these filters/);
});

test('values that reach the page as text cannot become markup', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const runs = [
    run(3, [
      exec(hostile, 1, 'failure', {
        failing_tests: [{ suite: 'S', title: hostile, error: hostile, file: hostile, line: 1 }],
      }),
      exec(hostile, 2, 'success'),
    ]),
  ];
  const wrapper = mount(CampaignTable, { props: { rows: campaignStats(runs), runs } });
  await wrapper.find('tr.campaign').trigger('click');

  // The old page assembled these rows as HTML strings and escaped by hand, which the review
  // picked at. Vue interpolation escapes by construction, so the campaign name, the scenario
  // title, the spec path and the error string are all text and nothing else.
  assert.equal(wrapper.findAll('img').length, 0);
  assert.match(wrapper.text(), /<img src=x onerror=alert\(1\)>/);
});
