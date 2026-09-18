/**
 * The shapes that travel between the collector, the stored run files, the packed dataset and
 * the dashboard.
 *
 * These are contracts, not conveniences. `RunFile` is what sits on the stats branch, and
 * `PackedDataset` is what every visitor downloads, so both are frozen: changing either means
 * migrating data that is already published.
 */

/** Why a campaign execution went red, which decides whether it belongs in the flaky ranking. */
export type FailureKind = 'none' | 'test' | 'infra' | 'unknown';

/** What a job name turned out to be. */
export type JobKind = 'campaign' | 'campaign-unexpanded' | 'build-shop' | 'prep' | 'other';

/** How a run's PrestaShop version line was worked out. */
export type BranchKeySource = 'resolved-log' | 'pr-lookup' | 'job-name' | 'none';

/** One failing scenario, read out of the mocha report at the end of a job log. */
export interface FailingTest {
  suite: string;
  title: string;
  /** Head of the assertion message. Absent when the block had none to read. */
  error?: string;
  file?: string | null;
  line?: number | null;
}

/** One campaign, run once, in one attempt of one workflow run. */
export interface Execution {
  campaign: string;
  branch?: string | null;
  attempt: number;
  status?: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_s: number | null;
  failure_kind: FailureKind;
  job_id?: number | null;
  job_url?: string | null;
  failing_tests?: FailingTest[];
  test_counts?: MochaSummary;
}

export interface MochaSummary {
  passing: number;
  failing: number;
  pending: number;
}

/** One stored run: a file under data/runs/<owner>/<run id>.json. */
export interface RunFile {
  repo: string;
  owner: string;
  run_id: number;
  run_number?: number;
  run_attempt: number;
  workflow: string;
  status: string;
  conclusion?: string | null;
  created_at: string;
  updated_at?: string | null;
  html_url: string;
  is_security: boolean;
  /** The shop prebuild failed or no campaign ran, so this run says nothing about any campaign. */
  aborted: boolean;
  final?: boolean;
  pr_number: number | null;
  db: string | null;
  branch_key: string;
  branch_key_source: BranchKeySource;
  base_branch?: string | null;
  ps_version?: string | null;
  raw_job_rows?: number;
  /** Job names no rule matched. Present only when there were any; a workflow rename lands here. */
  unclassified_job_names?: string[];
  executions: Execution[];
}

/** A run as the dashboard sees it, rebuilt from the packed dataset. */
export type DecodedRun = RunFile;

/** The dictionary-encoded columnar file the browser downloads whole. */
export interface PackedDataset {
  v: number;
  generated_at: string;
  dict: Record<string, Array<string | null>>;
  runs: number[][];
  execs: number[][];
  tests: number[][];
}

/* ------------------------------------------------------------------------------------- *
 * Counting units
 *
 * Finding 2 of the review was a division whose two sides counted different things: the
 * numerator counted (execution, scenario) pairs and the denominator counted failing
 * executions, so three campaigns reported more than 100% of their own failures. The two are
 * both numbers and both plausible, which is why nothing caught it.
 *
 * Branding them means the mistake no longer type-checks. Nothing else in the codebase is
 * branded: this is the one place where two counts of different things meet in one expression.
 * ------------------------------------------------------------------------------------- */

declare const unit: unique symbol;
type Counted<U extends string> = number & { readonly [unit]: U };

/** Campaign executions. Fractional when an execution is split across the scenarios it blamed. */
export type ExecutionCount = Counted<'campaign executions'>;

/** Times a scenario was named by a failing execution. One execution can contribute several. */
export type ScenarioNamings = Counted<'scenario namings'>;

export const executionCount = (n: number): ExecutionCount => n as ExecutionCount;
export const scenarioNamings = (n: number): ScenarioNamings => n as ScenarioNamings;

/* ------------------------------------------------------------------------------------- *
 * Statistics
 * ------------------------------------------------------------------------------------- */

export interface CampaignOutcome {
  campaign: string;
  firstAttempt: number;
  firstFailed: boolean;
  attempts: number;
  final: string | null;
  flaky: boolean;
  hardFailure: boolean;
  infra: boolean;
  totalSeconds: number;
  firstAttemptSeconds: number;
  retrySeconds: number;
  lostSeconds: number;
  hardRetrySeconds: number;
  lastFailureAt: string | null;
}

export interface RunTiming {
  totalSeconds: number;
  runningSeconds: number;
  waitingSeconds: number;
  firstAttemptSeconds: number;
  attemptCount: number;
}

export interface RunLevelStats {
  runs: number;
  aborted: number;
  greenFirstAttempt: number;
  greenEventually: number;
  neverGreen: number;
  greenFirstAttemptPct: number;
  greenEventuallyPct: number;
  neverGreenPct: number;
  avgFailedCampaignsAttempt1: number;
  avgAttempts: number;
  attemptsHistogram: Record<number, number>;
  computeMinutes: number;
  firstAttemptMinutes: number;
  retryMinutes: number;
  lostMinutes: number;
  lostPct: number;
  hardRetryMinutes: number;
  medianVerdictMinutes: number;
  avgVerdictMinutes: number;
  medianFirstAttemptVerdictMinutes: number;
  medianRunningMinutes: number;
  medianWaitingMinutes: number;
  avgWaitingMinutes: number;
  beyondRetryCap: number;
}

export interface CampaignRow {
  campaign: string;
  runs: number;
  greenFirstTryPct: number;
  flakyPct: number;
  neverGreenPct: number;
  flaky: number;
  neverGreen: number;
  /** Runs affected, not executions. See the note in campaignStats. */
  infraFailures: number;
  avgAttempts: number;
  medianDurationMin: number;
  computeMinutes: number;
  lostMinutes: number;
  lostMinutesPerRun: number;
  hardRetryMinutes: number;
  distinctPrsRun: number;
  distinctPrsFailed: number;
  prSpreadPct: number;
  lastFailureAt: string | null;
}

export interface ScenarioRow {
  title: string;
  suite: string;
  file: string | null;
  line: number | null;
  campaigns: string[];
  /** How many times this scenario was named by a failing execution. */
  failures: number;
  /** Share of the campaign's failing executions. Never sums above 100 across scenarios. */
  shareOfFailuresPct: number;
  flakyFailures: number;
  distinctPrs: number;
  topError: string | null;
  lastFailureAt: string | null;
}

export interface ScenarioStats {
  scenarios: ScenarioRow[];
  campaignFailures: number;
  attributed: number;
  /** Counted per execution, unlike CampaignRow.infraFailures, which counts runs affected. */
  infraFailures: number;
  unattributed: number;
}

export type WeekRow = RunLevelStats & { week: string };

export interface Filters {
  branchKey?: string | undefined;
  db?: string | undefined;
  owner?: string | undefined;
  workflow?: string | undefined;
  /** Rolling window in days. Ignored when `from` or `to` is given. */
  sinceDays?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
  includeSecurity?: boolean | undefined;
}
