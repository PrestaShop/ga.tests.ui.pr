<script setup lang="ts">
import { computed } from 'vue';

import type { DecodedRun } from '../../../src/types.js';
import { facet } from '../useDataset.js';

/** What the filter bar holds. The parent owns it so the whole page reacts to one object. */
export interface FilterState {
  branchKey: string;
  window: string;
  db: string;
  owner: string;
  workflow: string;
  campaign: string;
  includeSecurity: boolean;
  from: string;
  to: string;
}

const props = defineProps<{ runs: DecodedRun[] }>();
const model = defineModel<FilterState>({ required: true });

const branches = computed(() => facet(props.runs, 'branch_key'));
const databases = computed(() => facet(props.runs, 'db'));
const owners = computed(() => facet(props.runs, 'owner'));
const workflows = computed(() => facet(props.runs, 'workflow'));

const custom = computed(() => model.value.window === 'custom');
</script>

<template>
  <div class="filters">
    <div class="field">
      <label for="f-branch">PrestaShop version</label>
      <select id="f-branch" v-model="model.branchKey">
        <option value="">
          All
        </option>
        <option v-for="b in branches" :key="b" :value="b">
          {{ b }}
        </option>
      </select>
    </div>

    <div class="field">
      <label for="f-window">Window</label>
      <select id="f-window" v-model="model.window">
        <option value="7">
          Last week
        </option>
        <option value="30">
          Last 30 days
        </option>
        <option value="90">
          Last 90 days
        </option>
        <option value="180">
          Last 180 days
        </option>
        <option value="">
          All time
        </option>
        <option value="custom">
          Custom range…
        </option>
      </select>
    </div>

    <div class="field">
      <label for="f-db">Database</label>
      <select id="f-db" v-model="model.db">
        <option value="">
          All
        </option>
        <option v-for="d in databases" :key="d" :value="d">
          {{ d }}
        </option>
      </select>
    </div>

    <div class="field">
      <label for="f-owner">Fork</label>
      <select id="f-owner" v-model="model.owner">
        <option value="">
          All
        </option>
        <option v-for="o in owners" :key="o" :value="o">
          {{ o }}
        </option>
      </select>
    </div>

    <div class="field">
      <label for="f-workflow">Workflow</label>
      <select id="f-workflow" v-model="model.workflow">
        <option value="">
          All
        </option>
        <option v-for="w in workflows" :key="w" :value="w">
          {{ w }}
        </option>
      </select>
    </div>

    <div class="field">
      <label for="f-campaign">Campaign</label>
      <input
        id="f-campaign"
        v-model="model.campaign"
        type="search"
        placeholder="functional:BO…"
        autocomplete="off"
      >
    </div>

    <div class="field check">
      <input id="f-security" v-model="model.includeSecurity" type="checkbox">
      <label for="f-security">Include security runs</label>
    </div>

    <!--
      Own full-width row: the two fields are one flex item, so they cannot be split across
      lines however narrow the window gets.
    -->
    <div v-if="custom" class="range">
      <div class="field">
        <label for="f-from">From</label>
        <input id="f-from" v-model="model.from" type="datetime-local">
      </div>
      <div class="field">
        <label for="f-to">To</label>
        <input id="f-to" v-model="model.to" type="datetime-local">
      </div>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: flex-end;
  padding: 14px; background: var(--panel);
  border: 1px solid var(--border); border-radius: var(--radius);
}
.field { display: flex; flex-direction: column; gap: 4px; }
.field label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
select, input[type=search] {
  padding: 5px 8px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); color: var(--text); font: inherit; min-width: 140px;
}
.check { flex-direction: row; align-items: center; gap: 6px; padding-bottom: 6px; }
.check label { text-transform: none; font-size: 13px; letter-spacing: 0; color: var(--text); }

/*
  The custom range takes a line of its own and shares it between the two fields, so "From"
  and "To" always sit side by side instead of wrapping apart. A native datetime input will
  not shrink below roughly 180px, so on a narrow phone this one row scrolls sideways rather
  than breaking apart or dragging the whole page with it.
*/
.range {
  display: flex; flex-wrap: nowrap; gap: 14px;
  flex-basis: 100%; max-width: 560px; overflow-x: auto; padding-bottom: 2px;
}
.range .field { flex: 1 1 0; min-width: 0; }
input[type=datetime-local] {
  padding: 4px 8px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); color: var(--text); font: inherit; width: 100%; min-width: 0;
}
@media (max-width: 560px) {
  /* Buys back enough width for both fields to fit without scrolling on most phones. */
  .range { gap: 8px; }
  .range input[type=datetime-local] { font-size: 12px; padding: 4px 4px; }
}
</style>
