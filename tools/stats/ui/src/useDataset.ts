/**
 * Downloads the packed dataset once and unpacks it.
 *
 * The page filters and sorts in the browser from there, so any combination of version,
 * campaign, database, window and fork works without the aggregator precomputing views.
 */

import { ref, shallowRef, type Ref } from 'vue';

import { decodeDataset } from '../../src/dataset.js';
import type { DecodedRun, PackedDataset } from '../../src/types.js';

export interface DatasetState {
  runs: Ref<DecodedRun[]>;
  generatedAt: Ref<string | null>;
  error: Ref<string | null>;
  loading: Ref<boolean>;
  load: () => Promise<void>;
}

export function useDataset(url = './data/dataset.json'): DatasetState {
  // shallowRef, not ref: this is tens of thousands of plain objects that are never mutated
  // after decoding, and making every one of them deeply reactive costs far more than it buys.
  const runs = shallowRef<DecodedRun[]>([]);
  const generatedAt = ref<string | null>(null);
  const error = ref<string | null>(null);
  const loading = ref(true);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`dataset.json: HTTP ${res.status}`);
      const dataset = (await res.json()) as PackedDataset;
      runs.value = decodeDataset(dataset);
      generatedAt.value = dataset.generated_at;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  return { runs, generatedAt, error, loading, load };
}

/** The distinct values of one field, for a filter dropdown. */
export function facet(runs: DecodedRun[], field: keyof DecodedRun): string[] {
  const values = new Set<string>();
  for (const run of runs) {
    const value = run[field];
    if (typeof value === 'string' && value) values.add(value);
  }
  return [...values].sort();
}
