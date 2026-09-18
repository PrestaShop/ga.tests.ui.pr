<script setup lang="ts">
/** One row of headline figures. Used twice: run health, then time. */
export interface Card {
  /** The label above the number. */
  k: string;
  /** The number itself, already formatted. */
  n: string | number;
  /** `good`, `warn`, `bad`, or nothing. */
  cls?: string;
  /** The line under it, which is where the caveats live. */
  hint?: string;
}

defineProps<{ cards: Card[] }>();
</script>

<template>
  <div class="cards">
    <div v-for="card in cards" :key="card.k" class="card">
      <div class="k">
        {{ card.k }}
      </div>
      <div class="n" :class="card.cls">
        {{ card.n }}
      </div>
      <div class="hint">
        {{ card.hint ?? '' }}
      </div>
    </div>
  </div>
</template>
