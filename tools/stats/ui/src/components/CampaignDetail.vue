<script setup lang="ts">
import { computed, ref } from 'vue';

import { campaignOutcomes, scenarioStats } from '../../../src/metrics.js';
import type { CampaignOutcome, DecodedRun } from '../../../src/types.js';
import { caveatText } from '../format.js';

/**
 * What is behind one campaign's numbers: first which scenarios failed, then the runs
 * themselves.
 *
 * The scenario table comes first because it is the actionable half. The run list can be
 * hundreds of entries once the whole backfill is in, so only the most recent are shown and
 * the rest are one click away.
 */
const props = defineProps<{ campaign: string; runs: DecodedRun[]; columns: number }>();

/** How many failing runs to list before folding the rest behind a link. */
const RUNS_SHOWN = 12;

/** How many scenarios the table shows: past this it stops being a ranking. */
const SCENARIOS_SHOWN = 15;

const allRunsShown = ref(false);

const stats = computed(() => scenarioStats(props.runs, props.campaign));
const scenarios = computed(() => stats.value.scenarios.slice(0, SCENARIOS_SHOWN));

const caveat = computed(() => caveatText(stats.value.unattributed, stats.value.infraFailures));

const failing = computed<Array<{ run: DecodedRun; outcome: CampaignOutcome }>>(() => {
  const out: Array<{ run: DecodedRun; outcome: CampaignOutcome }> = [];
  for (const run of props.runs) {
    if (run.aborted) continue;
    const outcome = campaignOutcomes(run).find((o) => o.campaign === props.campaign);
    if (!outcome || (!outcome.firstFailed && !outcome.hardFailure)) continue;
    out.push({ run, outcome });
  }
  return out.sort((a, b) => (b.run.created_at ?? '').localeCompare(a.run.created_at ?? ''));
});

const shownRuns = computed(() =>
  allRunsShown.value ? failing.value : failing.value.slice(0, RUNS_SHOWN),
);

function verdict(outcome: CampaignOutcome): string {
  if (outcome.hardFailure) return 'never green, no time lost';
  return `green on attempt ${outcome.attempts}, ${Math.round(outcome.lostSeconds / 60)} min lost`;
}
</script>

<template>
  <tr class="detail">
    <td :colspan="columns">
      <strong>{{ campaign }}</strong>

      <table v-if="scenarios.length" class="sub-table">
        <thead>
          <tr>
            <th>Failing scenario</th>
            <th title="How many times this scenario was named by a failing execution">
              Failures
            </th>
            <th title="Share of this campaign's failing executions. Never sums above 100%.">
              Share
            </th>
            <th>Flaky</th>
            <th>PRs</th>
            <th>Last error</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in scenarios" :key="`${s.file}::${s.title}`">
            <td>
              <strong>{{ s.title }}</strong>
              <template v-if="s.file">
                <br><code>{{ s.file }}{{ s.line ? `:${s.line}` : '' }}</code>
              </template>
            </td>
            <td>{{ s.failures }}</td>
            <td>{{ s.shareOfFailuresPct }}%</td>
            <td>{{ s.flakyFailures }}</td>
            <td>{{ s.distinctPrs }}</td>
            <td class="err">
              {{ s.topError ? s.topError.slice(0, 90) : '' }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="scenarios.length && caveat" class="note">
        Of {{ stats.campaignFailures }} failures: {{ caveat }}
      </p>

      <p v-if="!scenarios.length" class="note">
        <template v-if="stats.campaignFailures">
          No scenario to show for {{ stats.campaignFailures }}
          failure{{ stats.campaignFailures === 1 ? '' : 's' }}. {{ caveat }}
        </template>
        <template v-else>
          No failure in this window.
        </template>
      </p>

      <template v-if="failing.length">
        <p class="note">
          Runs where it failed, most recent first ({{ failing.length }}):
        </p>
        <ul>
          <li v-for="{ run, outcome } in shownRuns" :key="run.run_id">
            <a :href="run.html_url" target="_blank" rel="noopener">{{ run.owner }} #{{ run.run_id }}</a>
            — {{ run.pr_number ? `PR #${run.pr_number}` : 'security run' }},
            {{ run.branch_key }}, {{ (run.created_at ?? '').slice(0, 10) }}
            — {{ verdict(outcome) }}{{ outcome.infra ? ' (environment failure)' : '' }}
          </li>
        </ul>
        <p v-if="failing.length > RUNS_SHOWN">
          <button type="button" class="link" @click.stop="allRunsShown = !allRunsShown">
            {{ allRunsShown ? 'Show fewer runs' : `Show all ${failing.length} runs` }}
          </button>
        </p>
      </template>
    </td>
  </tr>
</template>
