/** Presentation helpers shared by several components. */

/** Minutes are unreadable past an hour or two, and these numbers run to thousands. */
export function hours(min: number): string {
  if (min < 90) return `${min} min`;
  if (min < 60 * 48) return `${(min / 60).toFixed(1)} h`;
  return `${Math.round(min / 60 / 24)} days`;
}

/** `2×:7  3×:9  4×:6` — how many runs needed how many attempts. */
export function histogram(byAttempt: Record<number, number>): string {
  return Object.entries(byAttempt)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([attempts, n]) => `${attempts}×:${n}`)
    .join('  ');
}

/** Sort comparator that puts missing values first and handles both strings and numbers. */
export function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return typeof a === 'string' ? a.localeCompare(b as string) : (a as number) - (b as number);
}

/** `datetime-local` wants local time with no zone and no seconds. */
export function forDateTimeInput(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Why some failures name no scenario. The two reasons are different and should not be
 * conflated: an environment failure never reached mocha, so nothing is missing, whereas an
 * expired log is a real gap in the data.
 */
export function caveatText(unattributed: number, infraFailures: number): string {
  const parts: string[] = [];
  if (infraFailures) parts.push(`${infraFailures} failed in the environment before any test ran`);
  if (unattributed) parts.push(`${unattributed} lost to the 90 day log retention`);
  return parts.length ? `${parts.join(', ')}.` : '';
}
