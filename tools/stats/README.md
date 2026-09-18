# UI test campaign statistics

**→ [prestashop.github.io/ga.tests.ui.pr](https://prestashop.github.io/ga.tests.ui.pr/)**

Finds the flaky campaigns: which ones fail, how often a retry rescues them, and across how
many unrelated pull requests. Covers every fork, not just runs started by the core team.

Nothing is added to the test workflows. Everything is read back from the GitHub API after
the fact, which is the only approach that can see contributor forks at all: a fork's
`GITHUB_TOKEN` is scoped to the fork and forks get no secrets, so a fork job could never
push results to a central store. GitHub's own Actions metrics and third-party flaky-test
services have the same blind spot, since they only see repositories inside the organisation.

Code lives on the default branch. Data and the dashboard live on the orphan `stats` branch,
so the forks of this repository carry none of it: `data/` is the collector's store, one JSON
file per run, and `docs/` is the published page that GitHub Pages serves.

## What it looks like

![Dashboard overview](docs/dashboard-overview.png)

Clicking a campaign shows which scenarios are behind its failures, with the spec file from
the core repository and the share of that campaign's failures each one accounts for:

![Failing scenarios inside a campaign](docs/campaign-scenarios.png)

Screenshots are regenerated with `docs/take-screenshots.mjs`.

## The one thing to know before touching this code


The GitHub API reports the same campaign several times when a run has been retried. When
`gh run rerun --failed` creates attempt N, every job of the run is re-listed under attempt
N, including the ones that were not re-run. Those carried-over rows get a **new job id** and
a **relabelled `run_attempt`**, and keep their **original timestamps**.

On run `jolelievre/ga.tests.ui.pr#34473576823` (3 attempts) the API returns **138 rows for
51 real jobs**, 50 of which are campaign executions and one the prep job. Counting rows
would report 5 failures out of 138 (3.6%) instead of 5 out of 50 (10.0%), and would count a
campaign that passed once as having passed three times.

An execution is therefore identified by `(job name, started_at)`, and its true attempt is
the **lowest** `run_attempt` among the rows sharing that key. `executions.test.js` pins this
down against a recorded copy of that run; keep it passing.

## Layout

TypeScript throughout: `tsc` compiles `src/` to `dist/`, which is what the workflows run, and
Vite builds `ui/` into the static page the aggregator publishes.

| File | Role |
|---|---|
| `src/types.ts` | The shapes that travel between the collector, the stored run files, the packed dataset and the page |
| `src/github.ts` | REST client: runs, jobs, logs (byte ranges), pull requests. Retries transient failures, stops at a rate-limit floor |
| `src/executions.ts` | Job rows → real campaign executions. The dedupe rule above, campaign names, test vs infra failures |
| `src/parse-log.ts` | Job log → dispatch inputs, resolved PrestaShop version, failing test |
| `src/branch-key.ts` | A pull request's target branch → version line (`develop`, `9.2.x`, …) |
| `src/collect.ts` | One invocation: list every repository, diff against the index, store what is new |
| `src/metrics.ts` | The statistics. Imported by the aggregator **and** by the dashboard, so the page and the generated summary cannot disagree |
| `src/dataset.ts` | Packs run files into one small file the browser downloads whole; CSV export (on demand, `--csv`) |
| `src/aggregate.ts` | Run files → the published site |
| `src/store.ts` | One JSON file per run, plus the index of what has been processed |
| `src/cache.ts` | Record and replay of API responses |
| `src/run.ts`, `src/serve.ts` | The command line, and a loopback server for looking at a build |
| `ui/` | The dashboard: Vue 3 single-file components, `ui/src/App.vue` and `ui/src/components/` |

### What this costs

The tool used to have no dependencies and no build step, which was a genuine feature: `node
--test` and nothing else. It is now Vue 3.5 and TypeScript, which means a `node_modules`, a
lockfile, and `npm ci && npm run build` in both workflows before anything runs. The page it
ships is 91 KB of JavaScript, 35 KB gzipped, where the hand-written one was 14 KB.

That is a deliberate trade. What it buys: components instead of HTML assembled from strings,
which retires a class of escaping bug by construction; a typed contract between the collector
and the page; and `npm run dev`, so editing the dashboard no longer means re-running the
aggregator to see the change.

The framework is Vue because that is what the organisation standardised on — the back office
is Vue 3.5 — but this dashboard is written in the **current** Vue idiom rather than the one
`admin-dev/themes/new-theme` uses. Of its 68 single-file components, none use `<script
setup>`: they are all `defineComponent` with the Options API, and their filenames are mostly
kebab-case. This page uses `<script setup lang="ts">`, type-based `defineProps`, `defineModel`
and PascalCase filenames throughout. That is a deliberate choice for a standalone tool with no
shared build and no shared components, not an alignment claim: nothing here is imported by the
back office, so there is nothing to stay compatible with.

| | here | what core pins | note |
|---|---|---|---|
| Vue | 3.5 | `^3.5.9` | same line |
| TypeScript | 6.0 | `^4.9.5` | core's pin is from 2022. 6.0 is as new as the toolchain allows: `typescript-eslint` caps at `<6.1` |
| Vite, Vitest | current | n/a, core uses Webpack and Jest | not shared with the back-office build, so nothing to match |
| `eslint-plugin-vue`, `@vue/eslint-config-typescript` | current | `^9.28`, `^11.0.3` | same tools, newer |

Node 22 or newer is needed to install, because npm 10.8 (which ships with Node 20) crashes
resolving Vitest's optional peer dependencies. The compiled output itself runs on Node 20.

## Scripts

Run these from `tools/stats`, or with `npm --prefix tools/stats run <script>` from the
repository root.

| Script | What it does |
|---|---|
| `npm run build` | `build:node` then `build:ui` |
| `npm run build:node` | `tsc` → `dist/`, what the workflows execute |
| `npm run build:ui` | `vite build` → `dist-site/`, the page the aggregator publishes |
| `npm run dev` | Vite dev server with hot reload, serving the dataset from `.local/site/data` |
| `npm test` / `npm run test:watch` | Vitest, once or in watch mode |
| `npm run typecheck` | `tsc` over the collector and its tests, `vue-tsc` over the dashboard |
| `npm run lint` / `lint:fix` | ESLint over `.ts` and `.vue` |
| `npm run collect` | Collects into `.local/data` and rebuilds `.local/site`. Pass more flags after `--` |
| `npm run aggregate` | Rebuilds `.local/site` from `.local/data`, no API calls |
| `npm run serve` | Serves `.local/site` on 4173, loopback only |
| `npm run screenshots` | Regenerates `docs/*.png` against the served site |
| `npm run clean` | Removes the build output, never `.local/data` |

## Why there is no watermark

Each invocation lists **every** run of **every** repository and diffs it against
`data/index.json`. Re-enumerating the whole population costs about 127 requests out of the
5000 per hour, which is cheap enough to make the obvious optimisation not worth its bugs.

A watermark ("page until the newest run already known") would permanently skip any run that
was still in progress when it was first seen, since the list is ordered by `created_at` and
nothing ever moves it back to the top. It would also never notice a retry of an older run,
because re-running does not change `created_at`. Paginating a list that is being appended to
can drop an entry at a page boundary too.

A run enters the work queue when its id is unknown, its attempt count has grown, or it has
finished since it was last seen. `--max-runs` caps how many are *processed*, never how many
are listed, so a long backlog drains over several invocations with no cursor to maintain.

## Resolving the PrestaShop version

Tried in this order, and the source is recorded on each run as `branch_key_source`:

1. **`resolved-log`** — the `Resolved from PR / detected PrestaShop version:` block in a job
   log, read from a 64 KB head range rather than the whole ~274 KB log.
2. **`pr-lookup`** — the pull request's target branch, using the `PR_NUMBER` found in the
   log's inputs block. Works for closed pull requests, and is cached by PR number.
3. **`job-name`** — an older generation put the branch in the job name
   (`test (audit, develop)`). Last resort, used when the log has expired.

The order is deliberately not cheapest-first. Only `base_branch (PR target)` means the same
thing in every generation: one older workflow printed `branch_key (matrix key): develop` on
a run whose pull request targeted 9.2.x, and named its jobs to match, so trusting either
would file those runs under the wrong version.

Runs whose version cannot be resolved are kept with `branch_key: "unknown"` and shown as
their own bucket, never quietly merged into another version.

## Time lost

Reserved for flakiness. For a campaign that went red then green, everything it spent beyond
the single successful execution it should have needed is time that bought nothing.

A campaign that genuinely fails has lost nothing: that failure is the answer the run existed
to produce. It contributes zero. Re-running it afterwards to re-confirm the same failure is
still machine time, so it is reported on its own as `hardRetryMinutes` rather than inflating
the headline.

Three different clocks, all reported:

| | |
|---|---|
| `computeMinutes` | machine time actually spent, summed over every job |
| `firstAttemptMinutes` | what the same runs would have cost had nothing been retried |
| `lostMinutes` | the part of `computeMinutes` that flakiness wasted, with `lostPct` |
| `medianVerdictMinutes` | elapsed time to a final verdict, first job starting to last job ending. Campaigns run in parallel, so this is far below the machine time |
| `medianRunningMinutes` / `medianWaitingMinutes` | that elapsed time split into work and waiting between attempts |

### Why elapsed time is a median

Because the mean is meaningless here. Measured over 38 real runs:

| | median | mean |
|---|---|---|
| time to a final verdict | 139 min | 613 min |
| waiting between attempts | 1 min | 463 min |

`auto_retry_failed_jobs.yml` re-runs failed jobs the moment a run finishes, so consecutive
attempts are about 18 seconds apart. Of 132 measured gaps, the median is 0 and only 6 exceed
an hour.

Every one of those long gaps is the *last* gap of a run with 7 or 8 attempts. The automation
stops at `run_attempt < 6`, so past that somebody has to press re-run by hand, which happened
up to 5.6 days later. Seven of the 38 runs went that way, and they drag the mean to four
times anything a person actually experiences. `beyondRetryCap` counts them, so the effect
stays visible rather than hidden inside an average.

Per campaign, `medianDurationMin` is measured on successful executions only: `--bail` cuts a
failing campaign short, so its failures are not representative of what it costs to run.

## What is excluded, and why

- **Runs whose shop prebuild failed** are marked `aborted`: their campaigns never ran, so
  recording them would invent ~45 phantom failures per run.
- **Infra failures** (a step before the test step failed: docker, database, setup) are
  counted separately from test failures. A high infra rate calls for a different fix.
- **Cancelled and skipped** executions do not count towards pass or fail rates.
- **Security workflow runs** count towards campaign statistics, but their pull request
  number and inputs are not stored and their logs are not read.

## Which scenario failed

The collector reads the log of every job whose test step failed and keeps, for each failing
scenario, the suite, the title, the assertion message and the spec file with its line, for
example `campaigns/functional/API/02_checkEndpoints.ts:553`.

`--bail` usually stops a campaign at its first failing scenario, but the flag is not always
on, so every failure block is read rather than just the first.

The stack frame matters. A timeout inside a page object reports the helper first
(`tests/UI/node_modules/@prestashop-core/ui-testing/dist/pages/commonPage.js:8`), which names
no scenario and is the same file for every such failure; the first frame under `campaigns/`
is the spec somebody would actually open, so it wins whenever the stack has one.

Parsing anchors on the `N failing` summary, and stops after exactly that many blocks. The
spec reporter prints `1) <title>` inline where the test ran, long before the report at the
end, and without the anchor that line matches first and yields a heading with no suite. The
log does not stop at the report either: a hundred lines of teardown, artifact upload and
`##[endgroup]` markers follow it, and anything down there shaped like `1) restart mysql
container` would otherwise be read as another failure and named after the line beneath it.

The share reported against a scenario is a share of that campaign's failing **executions**,
which is what says where to start: a campaign that is red half the time because of a single
scenario is a very different job from one that is red for a dozen reasons.

Those are two different units, and the difference is only visible when `--bail` is off. A
scenario's *failures* column counts the times it was named; its *share* credits it `1/n` of
an execution that blamed n scenarios at once. Counting each of them as a whole failure
against a denominator of executions is what made one campaign report 175% of its own
failures. So the columns can legitimately total more than the campaign's failure count while
the shares never exceed 100%.

The whole log is fetched rather than a tail slice. The mocha report sits at the very end and
the log store does not honour suffix ranges, so a tail would cost one request to learn the
size and another to fetch it; the whole log is one request for about seven times the bytes,
and the rate limit is the scarce resource here, not bandwidth.

Failures whose log has expired are counted as `unattributed` rather than dropped, so the
shares visibly stop adding up to 100% instead of silently misleading. What the shares fall
short by is exactly the infra plus expired-log remainder the caveat line under the table
reports.

## Retention

Run and job metadata outlive logs by a long way. A run from five months ago still returns
its jobs, while its logs are already `410 Gone`. Logs and artifacts last 90 days. So
campaign-level history reaches back as far as GitHub keeps runs (about 14 months here),
while anything that needs a log is limited to the last 90 days.

## Running it locally

This is also how the dashboard is developed and how screenshots are produced.

```bash
cd tools/stats
npm ci
export GITHUB_TOKEN=$(gh auth token)      # a normal user token is enough

# Pull a couple of forks into .local (no commit, no stats branch involved)
npm run collect -- \
  --repo jolelievre/ga.tests.ui.pr \
  --repo Progi1984/ga.tests.ui.pr \
  --max-runs 40 --record .local/fixtures

# Look at the result. Opening index.html from the filesystem does not work: the page fetches
# its data, and browsers refuse that over file://
npm run serve                              # http://localhost:4173, loopback only

# Or, to work on the dashboard itself: hot reload against the same data
npm run dev
```

The flat one-row-per-execution CSV is not part of the published site, because it is a
full-history rebuild that would be re-committed daily for something the page never reads.
Ask for it when you want it:

```bash
npm run aggregate -- --csv .local/executions.csv
```

`--record` saves every API response; `--replay <dir>` serves them back, so the dashboard and
the statistics can be iterated on with no token, no network and no rate limit:

```bash
npm run collect -- --repo jolelievre/ga.tests.ui.pr --replay .local/fixtures

# Rebuild the site from data already pulled, without calling GitHub at all
npm run aggregate
```

Run `node dist/run.js --help` for every option, and `npm test` for the suite.

## In CI

`.github/workflows/stats.yml` runs daily, and on demand with a `max_runs` cap for draining
the backlog. It is inert on forks. It pushes the data with the job token and reads with, in
order of preference:

1. `secrets.STATS_GH_TOKEN` — an optional repository-level override.
2. `secrets.JARVIS_TOKEN` — the organisation-wide secret other PrestaShop workflows use.

If neither is set the job fails rather than falling back to the job token, which is scoped to
this repository: it would collect upstream-only data, and a dataset that quietly omits every
contributor fork is worse than no dataset.

**What the token actually needs is read access to public repositories owned by anyone**, not
only by the organisation. Contributor forks belong to individuals, so an organisation-scoped
token does not reach them. Measured against a fork owned by somebody else:

| | unauthenticated | a token with public read |
|---|---|---|
| List a fork's runs | 200 | 200 |
| List its jobs | 200 | 200 |
| **Read a job log** | **403** | **200** |
| Rate limit | 60/hour | 5000/hour |

Listing is public, so a token with too narrow a reach still lists everything and then fails
on every log. The collector names that case explicitly: a run of 403s is reported as a token
that can list runs but not read logs, rather than as an outage.

Partial failures are annotated too: repositories that could not be listed, runs that failed
to process, and job names that matched no known shape, which is how a workflow rename shows
up as a number rather than as a plausible spike in aborted runs. The job only goes red when
nothing at all could be collected, so a partial collection still commits the progress it made.

Both workflows run `npm ci && npm run build` first and then execute `dist/run.js`, so the
collector runs compiled rather than transpiling on import — it makes thousands of API calls,
and a type error should surface in the pull request rather than at 05:17 the next morning.
`.github/workflows/stats-tests.yml` runs on any pull request that touches `tools/stats/**`
and type-checks, lints, builds and tests.

GitHub Pages should be pointed at the `stats` branch, `/docs` folder.

## Setting the repository up, once

The order matters in one place: **GitHub Pages cannot be pointed at a branch that does not
exist yet**, and the `stats` branch is created by the first successful collection.

1. **Token.** `JARVIS_TOKEN` is an organisation secret and is already visible to this
   repository, so there may be nothing to do. Confirm it can read a log on a fork owned by
   somebody else — that is the permission this stands or falls on:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -L -H "Authorization: Bearer <TOKEN>" \
     https://api.github.com/repos/Progi1984/ga.tests.ui.pr/actions/jobs/104074231916/logs
   ```

   `200` and it works. Anything else, add a repository secret `STATS_GH_TOKEN` holding a
   classic token with `public_repo`, which takes precedence.

2. **Run the workflow by hand.** Actions → "UI test statistics" → Run workflow. This creates
   the `stats` branch. Check the Step Summary afterwards: **"Forks covered" must be more
   than 1**, or the token is not reaching forks and the collection is upstream-only.

3. **Pages.** Settings → Pages → Deploy from a branch → `stats` / `/docs`. The workflow
   writes `.nojekyll`, so nothing is filtered out.

   The folder is `docs/` because those are the only two choices GitHub offers when deploying
   from a branch — the repository root or `/docs`, nothing else — and the root would publish
   the site's `data/` directly on top of the collector's own `data/` store.

4. **Drain the backlog.** About 1800 runs at roughly 4.4 API requests each, so about 8000
   requests against a 5000/hour limit. Run it manually with `max_runs` around 800, wait for
   the quota, repeat — three or four times. It stops cleanly at the rate-limit floor and
   resumes where it left off, and flushes its index every 25 runs, so even a timeout costs
   at most 25 runs of rework. Leaving the daily schedule to it also works, over about two
   weeks.

Nothing else is needed: the repository's default workflow permission is already `write`,
which is what the push to `stats` requires, and the workflow is inert on forks by an explicit
repository check.

