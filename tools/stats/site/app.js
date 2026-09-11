/**
 * Dashboard. Downloads the whole dataset once, then filters and sorts in the browser, so
 * any combination of version, campaign, database, window and fork works without the
 * aggregator precomputing views.
 *
 * The statistics come from ./metrics.js, the very module the unit tests cover, so the
 * numbers on this page cannot drift from the generated summary.
 */

import { decodeDataset } from './dataset.js';
import { campaignOutcomes, campaignStats, filterRuns, runLevelStats, weeklyTrend } from './metrics.js';

const el = (id) => document.getElementById(id);
// Default order: most machine time wasted first, which is the work queue.
const state = { runs: [], sort: { key: 'lostMinutes', dir: -1 }, expanded: null, lastWindowDays: 90 };

init();

async function init() {
  try {
    const res = await fetch('./data/dataset.json');
    if (!res.ok) throw new Error(`dataset.json: HTTP ${res.status}`);
    const dataset = await res.json();
    state.runs = decodeDataset(dataset);
    state.generatedAt = dataset.generated_at;
  } catch (err) {
    el('coverage').textContent = `Could not load the dataset: ${err.message}`;
    return;
  }

  fillFacets();
  for (const id of ['f-branch', 'f-db', 'f-owner', 'f-workflow', 'f-security', 'f-from', 'f-to']) {
    el(id).addEventListener('change', render);
  }
  el('f-window').addEventListener('change', onWindowChange);
  el('f-campaign').addEventListener('input', render);

  document.querySelectorAll('#campaigns thead th').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      // Text sorts ascending first, numbers descending first: the interesting end each time.
      const textual = key === 'campaign';
      state.sort = state.sort.key === key
        ? { key, dir: -state.sort.dir }
        : { key, dir: textual ? 1 : -1 };
      state.expanded = null;
      render();
    });
  });

  render();
}

function fillFacets() {
  const facet = (id, values) => {
    const select = el(id);
    for (const value of [...values].filter(Boolean).sort()) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
  };
  facet('f-branch', new Set(state.runs.map((r) => r.branch_key)));
  facet('f-db', new Set(state.runs.map((r) => r.db)));
  facet('f-owner', new Set(state.runs.map((r) => r.owner)));
  facet('f-workflow', new Set(state.runs.map((r) => r.workflow)));
}

/**
 * Switching to a custom range prefills the two fields with the window that was showing, so
 * the advanced filter starts from what the reader was already looking at rather than empty.
 */
function onWindowChange() {
  const custom = el('f-window').value === 'custom';
  el('range-fields').hidden = !custom;

  if (custom && !el('f-from').value) {
    const shown = filterRuns(state.runs, { ...currentFilters(), sinceDays: state.lastWindowDays });
    const dates = shown.map((r) => Date.parse(r.created_at)).filter(Number.isFinite);
    const earliest = dates.length ? Math.min(...dates) : Date.now() - 30 * 86400000;
    el('f-from').value = forInput(earliest);
    el('f-to').value = forInput(Date.now());
  }
  if (!custom) state.lastWindowDays = el('f-window').value ? Number(el('f-window').value) : undefined;
  render();
}

/** `datetime-local` wants local time with no zone and no seconds. */
function forInput(epochMs) {
  const d = new Date(epochMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function currentFilters() {
  const window = el('f-window').value;
  const custom = window === 'custom';
  return {
    branchKey: el('f-branch').value || undefined,
    db: el('f-db').value || undefined,
    owner: el('f-owner').value || undefined,
    workflow: el('f-workflow').value || undefined,
    sinceDays: custom || !window ? undefined : Number(window),
    // The fields hold local time; Date parses them in the reader's own zone, which is what
    // they mean by it.
    from: custom && el('f-from').value ? new Date(el('f-from').value).toISOString() : undefined,
    to: custom && el('f-to').value ? new Date(el('f-to').value).toISOString() : undefined,
    includeSecurity: el('f-security').checked,
  };
}

function render() {
  const runs = filterRuns(state.runs, currentFilters());
  const needle = el('f-campaign').value.trim().toLowerCase();

  renderCoverage(runs);
  renderCards(runLevelStats(runs));
  renderTrend(weeklyTrend(runs));

  let rows = campaignStats(runs);
  if (needle) rows = rows.filter((r) => r.campaign.toLowerCase().includes(needle));
  renderTable(rows, runs);
}

function renderCoverage(runs) {
  const all = state.runs.length;
  const owners = new Set(runs.map((r) => r.owner)).size;
  const unknown = runs.filter((r) => r.branch_key === 'unknown').length;
  const generated = state.generatedAt ? new Date(state.generatedAt).toLocaleString() : 'unknown';

  el('coverage').textContent =
    `${runs.length} of ${all} runs in view, from ${owners} fork${owners === 1 ? '' : 's'}` +
    `${unknown ? `, ${unknown} with an unresolved version` : ''}. Updated ${generated}.`;

  el('footer').innerHTML =
    'A campaign that fails then passes on a later attempt of the same run is flaky: the code did not change between attempts. ' +
    'One that is still red at the last attempt is a real failure, from the pull request or from a broken branch. ' +
    '<strong>PR spread</strong> is the sharper signal: a campaign failing across many unrelated pull requests is flaky or broken on the branch, ' +
    'while one failing only on a single pull request is that pull request&rsquo;s own doing, and unlike the retry measure it does not depend on anyone having clicked re-run. ' +
    '<strong>Time lost</strong> counts only flakiness: everything a campaign spent beyond the single successful execution it should have needed. ' +
    'A campaign that genuinely fails has lost nothing, since that failure is the answer the run existed to produce, so it contributes zero; ' +
    're-running it to re-confirm the same failure is reported on its own. ' +
    'Elapsed times are medians: automatic retries follow each other within seconds, but a run that passes the retry cap of six attempts waits for somebody to restart it by hand, ' +
    'sometimes days later, and a few of those would drag an average far above anything anyone actually experiences. ' +
    'Runs whose shop build failed are excluded, since their campaigns never ran.';
}

function renderCards(stats) {
  const cards = [
    { k: 'Runs', n: stats.runs, hint: stats.aborted ? `${stats.aborted} aborted, excluded` : '' },
    { k: 'Green first try', n: `${stats.greenFirstAttemptPct}%`, cls: 'good', hint: `${stats.greenFirstAttempt} runs` },
    { k: 'Green after retry', n: `${stats.greenEventuallyPct}%`, cls: 'warn', hint: `${stats.greenEventually} runs, flaky` },
    { k: 'Never green', n: `${stats.neverGreenPct}%`, cls: 'bad', hint: `${stats.neverGreen} runs` },
    { k: 'Failed 1st attempt', n: stats.avgFailedCampaignsAttempt1, hint: 'campaigns per run, average' },
    { k: 'Attempts', n: stats.avgAttempts, hint: histogram(stats.attemptsHistogram) },
  ];

  const time = [
    { k: 'Time lost to flakiness', n: hours(stats.lostMinutes), cls: 'bad',
      hint: `${stats.lostPct}% of all machine time, bought nothing` },
    { k: 'Machine time', n: hours(stats.computeMinutes),
      hint: `${hours(stats.firstAttemptMinutes)} without any retry` },
    { k: 'Re-running real failures', n: hours(stats.hardRetryMinutes),
      hint: 'genuine failures, re-confirmed' },
    { k: 'Time to final verdict', n: hours(stats.medianVerdictMinutes),
      hint: `median; ${hours(stats.medianFirstAttemptVerdictMinutes)} for the first attempt alone` },
    { k: 'Waiting between attempts', n: hours(stats.medianWaitingMinutes),
      cls: stats.medianWaitingMinutes > 30 ? 'warn' : '',
      hint: stats.beyondRetryCap
        ? `median; ${stats.beyondRetryCap} run${stats.beyondRetryCap === 1 ? '' : 's'} needed a manual re-run, ` +
          `pulling the mean to ${hours(stats.avgWaitingMinutes)}`
        : 'median; every retry was automatic' },
  ];

  const card = (c) =>
    `<div class="card"><div class="k">${c.k}</div>` +
    `<div class="n ${c.cls ?? ''}">${c.n}</div>` +
    `<div class="hint">${c.hint ?? ''}</div></div>`;

  el('cards').innerHTML = cards.map(card).join('');
  el('time-cards').innerHTML = time.map(card).join('');
}

/** Minutes are unreadable past an hour or two, and these numbers run to thousands. */
function hours(min) {
  if (min < 90) return `${min} min`;
  if (min < 60 * 48) return `${(min / 60).toFixed(1)} h`;
  return `${Math.round(min / 60 / 24)} days`;
}

function histogram(byAttempt) {
  const entries = Object.entries(byAttempt).sort(([a], [b]) => Number(a) - Number(b));
  return entries.map(([attempts, n]) => `${attempts}×:${n}`).join('  ') || '';
}

/**
 * One stacked column per week: green first try, green only after a retry, never green.
 * Column height is the number of runs that week.
 *
 * Deliberately not a single-metric chart. Runs that are green on the first attempt are
 * currently close to zero, so charting that alone draws a flat line that reads as a broken
 * page rather than as a finding.
 */
function renderTrend(weeks) {
  if (weeks.length === 0) {
    el('trend').innerHTML = '<span class="empty">No runs in this window.</span>';
    return;
  }
  const busiest = Math.max(...weeks.map((w) => w.runs), 1);

  el('trend').innerHTML = weeks
    .map((w) => {
      const share = (n) => (w.runs > 0 ? (n / w.runs) * 100 : 0);
      const segments = [
        ['var(--good)', share(w.greenFirstAttempt)],
        ['var(--warn)', share(w.greenEventually)],
        ['var(--bad)', share(w.neverGreen)],
      ]
        .filter(([, pct]) => pct > 0)
        .map(([colour, pct]) => `<i style="height:${pct}%;background:${colour}"></i>`)
        .join('');

      return (
        `<div class="bar" style="height:${Math.max(4, (w.runs / busiest) * 100)}%">${segments}` +
        `<span>${w.week}: ${w.runs} run${w.runs === 1 ? '' : 's'} — ` +
        `${w.greenFirstAttempt} green first try, ${w.greenEventually} after a retry, ${w.neverGreen} never green ` +
        `(${w.retryMinutes} retry minutes)</span></div>`
      );
    })
    .join('');
}

function renderTable(rows, runs) {
  const { key, dir } = state.sort;
  const sorted = [...rows].sort((a, b) => compare(a[key], b[key]) * dir);

  document.querySelectorAll('#campaigns thead th').forEach((th) => {
    if (th.dataset.sort === key) th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  });

  const body = document.querySelector('#campaigns tbody');
  if (sorted.length === 0) {
    body.innerHTML = '<tr><td colspan="11" class="empty">Nothing matches these filters.</td></tr>';
    return;
  }

  body.innerHTML = sorted
    .map((r) => {
      const detail = state.expanded === r.campaign ? detailRow(r.campaign, runs) : '';
      return (
        `<tr class="campaign" data-campaign="${escapeAttr(r.campaign)}">` +
        `<td>${escapeHtml(r.campaign)}</td>` +
        `<td>${r.runs}</td>` +
        `<td class="good">${r.greenFirstTryPct}%</td>` +
        `<td class="${r.flakyPct > 0 ? 'warn' : ''}">${r.flakyPct}%</td>` +
        `<td class="${r.neverGreenPct > 0 ? 'bad' : ''}">${r.neverGreenPct}%</td>` +
        `<td>${r.avgAttempts}</td>` +
        `<td>${r.medianDurationMin ? `${r.medianDurationMin} min` : ''}</td>` +
        `<td class="${r.lostMinutes > 0 ? 'bad' : ''}">${r.lostMinutes ? hours(r.lostMinutes) : ''}</td>` +
        `<td>${r.infraFailures || ''}</td>` +
        `<td>${r.distinctPrsFailed}/${r.distinctPrsRun}</td>` +
        `<td>${r.lastFailureAt ? r.lastFailureAt.slice(0, 10) : ''}</td>` +
        `</tr>${detail}`
      );
    })
    .join('');

  body.querySelectorAll('tr.campaign').forEach((tr) => {
    tr.addEventListener('click', () => {
      const name = tr.dataset.campaign;
      state.expanded = state.expanded === name ? null : name;
      render();
    });
  });
}

/** The runs behind one campaign's numbers, so a figure can always be traced to its evidence. */
function detailRow(campaign, runs) {
  const items = [];
  for (const run of runs) {
    if (run.aborted) continue;
    const outcome = campaignOutcomes(run).find((o) => o.campaign === campaign);
    if (!outcome || (!outcome.firstFailed && !outcome.hardFailure)) continue;

    const verdict = outcome.hardFailure
      ? 'never green, no time lost'
      : `green on attempt ${outcome.attempts}, ${Math.round(outcome.lostSeconds / 60)} min lost`;
    const pr = run.pr_number ? `PR #${run.pr_number}` : 'security run';
    items.push(
      `<li><a href="${run.html_url}" target="_blank" rel="noopener">${run.owner} #${run.run_id}</a> — ` +
        `${pr}, ${run.branch_key}, ${run.created_at.slice(0, 10)} — ${verdict}` +
        `${outcome.infra ? ' (environment failure)' : ''}</li>`,
    );
  }

  const list = items.length
    ? `<ul>${items.slice(0, 40).join('')}</ul>${items.length > 40 ? `<p>…and ${items.length - 40} more.</p>` : ''}`
    : '<p>No failure in this window.</p>';
  return `<tr class="detail"><td colspan="11"><strong>${escapeHtml(campaign)}</strong>${list}</td></tr>`;
}

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return typeof a === 'string' ? a.localeCompare(b) : a - b;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const escapeAttr = escapeHtml;
