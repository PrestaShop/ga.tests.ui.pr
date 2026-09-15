<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { campaignStats, filterRuns, runLevelStats, weeklyTrend } from '../../src/metrics.js';
import type { Filters } from '../../src/types.js';
import CampaignTable from './components/CampaignTable.vue';
import FilterBar, { type FilterState } from './components/FilterBar.vue';
import StatCards, { type Card } from './components/StatCards.vue';
import WeeklyTrend from './components/WeeklyTrend.vue';
import { forDateTimeInput, histogram, hours } from './format.js';
import { useDataset } from './useDataset.js';

const { runs, generatedAt, error, load } = useDataset();

const filters = ref<FilterState>({
  branchKey: '',
  window: '90',
  db: '',
  owner: '',
  workflow: '',
  campaign: '',
  includeSecurity: false,
  from: '',
  to: '',
});

/** The window that was showing before the reader switched to a custom range. */
const lastWindowDays = ref<number | undefined>(90);

onMounted(load);

/**
 * Switching to a custom range prefills the two fields with the window that was showing, so
 * the advanced filter starts from what the reader was already looking at rather than empty.
 */
watch(
  () => filters.value.window,
  (window, previous) => {
    if (window !== 'custom') {
      lastWindowDays.value = window ? Number(window) : undefined;
      return;
    }
    if (previous === 'custom' || filters.value.from) return;

    const shown = filterRuns(runs.value, { ...asFilters(true), sinceDays: lastWindowDays.value });
    const dates = shown.map((r) => Date.parse(r.created_at)).filter(Number.isFinite);
    const earliest = dates.length ? Math.min(...dates) : Date.now() - 30 * 86400000;
    filters.value.from = forDateTimeInput(earliest);
    filters.value.to = forDateTimeInput(Date.now());
  },
);

/** @param ignoreRange used while prefilling, when the range fields are not set yet */
function asFilters(ignoreRange = false): Filters {
  const f = filters.value;
  const custom = f.window === 'custom' && !ignoreRange;
  return {
    branchKey: f.branchKey || undefined,
    db: f.db || undefined,
    owner: f.owner || undefined,
    workflow: f.workflow || undefined,
    sinceDays: custom || !f.window ? undefined : Number(f.window),
    // The fields hold local time; Date parses them in the reader's own zone, which is what
    // they mean by it.
    from: custom && f.from ? new Date(f.from).toISOString() : undefined,
    to: custom && f.to ? new Date(f.to).toISOString() : undefined,
    includeSecurity: f.includeSecurity,
  };
}

const visible = computed(() => filterRuns(runs.value, asFilters()));
const health = computed(() => runLevelStats(visible.value));
const weeks = computed(() => weeklyTrend(visible.value));

const campaigns = computed(() => {
  const rows = campaignStats(visible.value);
  const needle = filters.value.campaign.trim().toLowerCase();
  return needle ? rows.filter((r) => r.campaign.toLowerCase().includes(needle)) : rows;
});

const coverage = computed(() => {
  if (error.value) return `Could not load the dataset: ${error.value}`;
  const owners = new Set(visible.value.map((r) => r.owner)).size;
  const unknown = visible.value.filter((r) => r.branch_key === 'unknown').length;
  const generated = generatedAt.value ? new Date(generatedAt.value).toLocaleString() : 'unknown';
  return (
    `${visible.value.length} of ${runs.value.length} runs in view, ` +
    `from ${owners} fork${owners === 1 ? '' : 's'}` +
    `${unknown ? `, ${unknown} with an unresolved version` : ''}. Updated ${generated}.`
  );
});

const healthCards = computed<Card[]>(() => {
  const s = health.value;
  return [
    { k: 'Runs', n: s.runs, hint: s.aborted ? `${s.aborted} aborted, excluded` : '' },
    { k: 'Green first try', n: `${s.greenFirstAttemptPct}%`, cls: 'good', hint: `${s.greenFirstAttempt} runs` },
    { k: 'Green after retry', n: `${s.greenEventuallyPct}%`, cls: 'warn', hint: `${s.greenEventually} runs, flaky` },
    { k: 'Never green', n: `${s.neverGreenPct}%`, cls: 'bad', hint: `${s.neverGreen} runs` },
    { k: 'Failed 1st attempt', n: s.avgFailedCampaignsAttempt1, hint: 'campaigns per run, average' },
    { k: 'Attempts', n: s.avgAttempts, hint: histogram(s.attemptsHistogram) },
  ];
});

const timeCards = computed<Card[]>(() => {
  const s = health.value;
  return [
    {
      k: 'Time lost to flakiness', n: hours(s.lostMinutes), cls: 'bad',
      hint: `${s.lostPct}% of all machine time, bought nothing`,
    },
    {
      k: 'Machine time', n: hours(s.computeMinutes),
      hint: `${hours(s.firstAttemptMinutes)} without any retry`,
    },
    {
      k: 'Re-running real failures', n: hours(s.hardRetryMinutes),
      hint: 'genuine failures, re-confirmed',
    },
    {
      k: 'Time to final verdict', n: hours(s.medianVerdictMinutes),
      hint: `median; ${hours(s.medianFirstAttemptVerdictMinutes)} for the first attempt alone`,
    },
    {
      k: 'Waiting between attempts', n: hours(s.medianWaitingMinutes),
      cls: s.medianWaitingMinutes > 30 ? 'warn' : '',
      hint: s.beyondRetryCap
        ? `median; ${s.beyondRetryCap} run${s.beyondRetryCap === 1 ? '' : 's'} needed a manual re-run, `
          + `pulling the mean to ${hours(s.avgWaitingMinutes)}`
        : 'median; every retry was automatic',
    },
  ];
});
</script>

<template>
  <div class="wrap">
    <h1>PrestaShop UI test campaign statistics</h1>
    <p class="sub">
      {{ coverage }}
    </p>

    <FilterBar v-model="filters" :runs="runs" />

    <h2>Run health</h2>
    <StatCards :cards="healthCards" />

    <h2>
      Time
      <span class="qualifier">— machine time, how much of it bought nothing, and how long a run takes to reach a verdict</span>
    </h2>
    <StatCards :cards="timeCards" />

    <h2>
      Weekly trend
      <span class="qualifier">— runs per week: green on the first attempt, green after a retry, never green</span>
    </h2>
    <WeeklyTrend :weeks="weeks" />

    <h2>
      Campaigns
      <span class="qualifier">— click a row for the runs behind the numbers</span>
    </h2>
    <CampaignTable :rows="campaigns" :runs="visible" />

    <footer>
      A campaign that fails then passes on a later attempt of the same run is flaky: the code
      did not change between attempts. One that is still red at the last attempt is a real
      failure, from the pull request or from a broken branch.
      <strong>PR spread</strong> is the sharper signal: a campaign failing across many
      unrelated pull requests is flaky or broken on the branch, while one failing only on a
      single pull request is that pull request’s own doing, and unlike the retry measure it
      does not depend on anyone having clicked re-run.
      <strong>Time lost</strong> counts only flakiness: everything a campaign spent beyond the
      single successful execution it should have needed. A campaign that genuinely fails has
      lost nothing, since that failure is the answer the run existed to produce, so it
      contributes zero; re-running it to re-confirm the same failure is reported on its own.
      Elapsed times are medians: automatic retries follow each other within seconds, but a run
      that passes the retry cap of six attempts waits for somebody to restart it by hand,
      sometimes days later, and a few of those would drag an average far above anything anyone
      actually experiences. Runs whose shop build failed are excluded, since their campaigns
      never ran.
    </footer>
  </div>
</template>
