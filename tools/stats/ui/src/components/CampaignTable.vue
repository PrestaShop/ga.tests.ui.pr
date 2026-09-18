<script setup lang="ts">
import { computed, ref } from 'vue';

import type { CampaignRow, DecodedRun } from '../../../src/types.js';
import { compare, hours } from '../format.js';
import CampaignDetail from './CampaignDetail.vue';

const props = defineProps<{ rows: CampaignRow[]; runs: DecodedRun[] }>();

interface Column {
  key: keyof CampaignRow;
  label: string;
  title?: string;
}

const COLUMNS: Column[] = [
  { key: 'campaign', label: 'Campaign' },
  { key: 'runs', label: 'Runs', title: 'Runs in which this campaign ran' },
  { key: 'greenFirstTryPct', label: 'Green 1st', title: 'Passed on the first attempt' },
  { key: 'flakyPct', label: 'Flaky', title: 'Failed, then passed on a later attempt of the same run' },
  { key: 'neverGreenPct', label: 'Never green', title: 'Still failing at the last attempt' },
  { key: 'avgAttempts', label: 'Attempts', title: 'Mean attempts this campaign needed' },
  {
    key: 'medianDurationMin',
    label: 'Duration',
    title: 'Median duration of a successful execution, which is also the price of one retry',
  },
  {
    key: 'lostMinutes',
    label: 'Time lost',
    title: 'Machine time spent on retries that a non-flaky campaign would not have needed. A genuine failure counts zero.',
  },
  { key: 'infraFailures', label: 'Infra', title: 'Runs where a step before the test step failed (docker, setup)' },
  {
    key: 'distinctPrsFailed',
    label: 'PR spread',
    title: 'Distinct pull requests where it failed first try, over distinct PRs it ran on',
  },
  { key: 'lastFailureAt', label: 'Last failure' },
];

// Default order: most machine time wasted first, which is the work queue.
const sortKey = ref<keyof CampaignRow>('lostMinutes');
const sortDir = ref(-1);
const expanded = ref<string | null>(null);

const sorted = computed(() =>
  [...props.rows].sort((a, b) => compare(a[sortKey.value], b[sortKey.value]) * sortDir.value),
);

function sortBy(key: keyof CampaignRow): void {
  if (sortKey.value === key) {
    sortDir.value = -sortDir.value;
  } else {
    sortKey.value = key;
    // Text sorts ascending first, numbers descending first: the interesting end each time.
    sortDir.value = key === 'campaign' ? 1 : -1;
  }
  expanded.value = null;
}

function toggle(campaign: string): void {
  expanded.value = expanded.value === campaign ? null : campaign;
}

function ariaSort(key: keyof CampaignRow): 'ascending' | 'descending' | undefined {
  if (sortKey.value !== key) return undefined;
  return sortDir.value === 1 ? 'ascending' : 'descending';
}
</script>

<template>
  <div class="scroll">
    <!-- A stable hook: docs/take-screenshots.mjs and anything else driving the page finds
         the ranking by this id rather than by its position. -->
    <table id="campaigns">
      <thead>
        <tr>
          <th
            v-for="column in COLUMNS"
            :key="column.key"
            :title="column.title"
            :aria-sort="ariaSort(column.key)"
            @click="sortBy(column.key)"
          >
            {{ column.label }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="sorted.length === 0">
          <td :colspan="COLUMNS.length" class="empty">
            Nothing matches these filters.
          </td>
        </tr>
        <template v-for="row in sorted" :key="row.campaign">
          <tr class="campaign" @click="toggle(row.campaign)">
            <td>{{ row.campaign }}</td>
            <td>{{ row.runs }}</td>
            <td class="good">
              {{ row.greenFirstTryPct }}%
            </td>
            <td :class="{ warn: row.flakyPct > 0 }">
              {{ row.flakyPct }}%
            </td>
            <td :class="{ bad: row.neverGreenPct > 0 }">
              {{ row.neverGreenPct }}%
            </td>
            <td>{{ row.avgAttempts }}</td>
            <td>{{ row.medianDurationMin ? `${row.medianDurationMin} min` : '' }}</td>
            <td :class="{ bad: row.lostMinutes > 0 }">
              {{ row.lostMinutes ? hours(row.lostMinutes) : '' }}
            </td>
            <td>{{ row.infraFailures || '' }}</td>
            <td>{{ row.distinctPrsFailed }}/{{ row.distinctPrsRun }}</td>
            <td>{{ row.lastFailureAt ? row.lastFailureAt.slice(0, 10) : '' }}</td>
          </tr>
          <CampaignDetail
            v-if="expanded === row.campaign"
            :campaign="row.campaign"
            :runs="runs"
            :columns="COLUMNS.length"
          />
        </template>
      </tbody>
    </table>
  </div>
</template>
