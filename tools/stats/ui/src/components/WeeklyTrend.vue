<script setup lang="ts">
import { computed } from 'vue';

import type { WeekRow } from '../../../src/types.js';

/**
 * One stacked column per week: green first try, green only after a retry, never green.
 * Column height is the number of runs that week.
 *
 * Deliberately not a single-metric chart. Runs that are green on the first attempt are
 * currently close to zero, so charting that alone draws a flat line that reads as a broken
 * page rather than as a finding.
 */
const props = defineProps<{ weeks: WeekRow[] }>();

const busiest = computed(() => Math.max(...props.weeks.map((w) => w.runs), 1));

interface Bar {
  week: string;
  heightPct: number;
  segments: Array<{ colour: string; pct: number }>;
  tooltip: string;
}

const bars = computed<Bar[]>(() =>
  props.weeks.map((w) => {
    const share = (n: number) => (w.runs > 0 ? (n / w.runs) * 100 : 0);
    return {
      week: w.week,
      heightPct: Math.max(4, (w.runs / busiest.value) * 100),
      segments: [
        { colour: 'var(--good)', pct: share(w.greenFirstAttempt) },
        { colour: 'var(--warn)', pct: share(w.greenEventually) },
        { colour: 'var(--bad)', pct: share(w.neverGreen) },
      ].filter((s) => s.pct > 0),
      tooltip:
        `${w.week}: ${w.runs} run${w.runs === 1 ? '' : 's'} — ` +
        `${w.greenFirstAttempt} green first try, ${w.greenEventually} after a retry, ` +
        `${w.neverGreen} never green (${w.retryMinutes} retry minutes)`,
    };
  }),
);
</script>

<template>
  <div class="trend">
    <span v-if="bars.length === 0" class="empty">No runs in this window.</span>
    <div
      v-for="bar in bars"
      :key="bar.week"
      class="bar"
      :style="{ height: `${bar.heightPct}%` }"
    >
      <i
        v-for="(segment, i) in bar.segments"
        :key="i"
        :style="{ height: `${segment.pct}%`, background: segment.colour }"
      />
      <span>{{ bar.tooltip }}</span>
    </div>
  </div>
  <div class="legend">
    <span><i style="background: var(--good)" />green on the first attempt</span>
    <span><i style="background: var(--warn)" />green only after a retry</span>
    <span><i style="background: var(--bad)" />never green</span>
    <span class="note">bar height = runs that week</span>
  </div>
</template>

<style scoped>
.trend { display: flex; align-items: flex-end; gap: 3px; height: 80px; margin-top: 8px; }
.bar {
  flex: 1; min-height: 4px; position: relative; display: flex; flex-direction: column-reverse;
  border-radius: 2px 2px 0 0; overflow: hidden; background: var(--border);
}
.bar i { display: block; width: 100%; }
.bar span { display: none; }
.bar:hover span {
  display: block; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
  background: var(--text); color: var(--bg); padding: 3px 6px; border-radius: 4px;
  font-size: 11px; white-space: nowrap; z-index: 2;
}
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 10px; font-size: 12px; color: var(--muted); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 11px; height: 11px; border-radius: 2px; display: inline-block; }
.legend .note { font-style: italic; }
</style>
