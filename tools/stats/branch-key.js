/**
 * Maps a pull request target branch to a `branch_key`, the version line under test
 * (`develop`, `9.2.x`, ..., `1.7.8.x`).
 *
 * ⚠️ This is a hand-copy of the case statement in
 * `.github/workflows/prep-pr-context.yml`, step "Resolve Auto values, branch key, and
 * version-derived flags". If the rule changes there, change it here too (and vice versa);
 * a comment in that workflow points back at this file.
 */

/** Branch key used when nothing could be resolved. Shown as its own bucket, never merged away. */
export const UNKNOWN_BRANCH_KEY = 'unknown';

/**
 * Strips a fully qualified ref down to its branch name.
 * `refs/heads/9.2.x` -> `9.2.x`, `origin/develop` -> `develop`.
 *
 * @param {string} ref
 * @returns {string}
 */
export function normalizeRef(ref) {
  if (typeof ref !== 'string') return '';
  return ref.trim().replace(/^refs\/heads\//, '').replace(/^origin\//, '');
}

/**
 * @param {string} ref        Target branch of the pull request (`base.ref`).
 * @param {string} [psVersion] PrestaShop version detected on the PR head, e.g. `9.2.0`.
 *                             Only consulted when the ref is not a release branch.
 * @returns {string} the branch key, or UNKNOWN_BRANCH_KEY when it cannot be derived.
 */
export function branchKeyFromRef(ref, psVersion) {
  const branch = normalizeRef(ref);

  // 1.7.* -> 1.7.8.x (the only 1.7 line still tested)
  if (/^1\.7(\.|$)/.test(branch)) return '1.7.8.x';

  // develop, master, and any release branch (9.2.x, 10.0.x, ...) are already the key,
  // so a new version line needs no change here.
  if (branch === 'develop' || branch === 'master') return branch;
  if (/^\d+\.\d+\.x$/.test(branch)) return branch;

  // Anything else (a feature branch, a fork branch): fall back on the detected version.
  const parsed = parsePsVersion(psVersion);
  if (!parsed) return UNKNOWN_BRANCH_KEY;
  if (parsed.major === 1) return '1.7.8.x';
  return `${parsed.major}.${parsed.minor}.x`;
}

/**
 * @param {string} [version] e.g. `9.2.0`, `1.7.8.11`
 * @returns {{major: number, minor: number}|null}
 */
export function parsePsVersion(version) {
  if (typeof version !== 'string') return null;
  const m = version.trim().match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}
