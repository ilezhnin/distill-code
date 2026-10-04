// Mirrors services/benchmarks/types.rs. Missing measurements remain null.
export interface BenchmarkError {
  code: string;
  message: string;
}
export interface Evaluator {
  kind: string;
  expected: string;
  rubric: string;
  revision: string;
  knownGood: string;
  knownBad: string;
}
export interface BenchmarkDraft {
  schemaVersion: number;
  name: string;
  description: string;
  category: string;
  taskFamily: string;
  split: string;
  prompt: string;
  source: string;
  license: string;
  executionProfile: string;
  measurementProfile: string;
  evaluator: Evaluator;
  permissions: { tools: string[]; network: boolean; context: string };
  limits: {
    timeoutSeconds: number;
    maxTurns: number;
    maxArtifactBytes: number;
  };
  repetitions: number;
  fixtures: { path: string; content: string }[];
  environment: unknown;
  workClassId: string;
  roleId: string | null;
  facets: TaskFacets;
  rolePrompt: string;
  roleContextHash: string;
  entryState: EntryState | null;
  workflow: WorkflowSpec | null;
}
export interface TaskFacets {
  language?: string | null;
  domain?: string | null;
  difficulty?: string | null;
  inputBytes?: number | null;
  outputFormat?: string | null;
}
export interface EntryState {
  schemaVersion: number;
  rootTaskId: string;
  stepId: string;
  parentStepId: string | null;
  fixtureSnapshotHash: string;
  conversationPrefix: string;
  previousReports: string[];
  remainingBudgetSeconds: number;
  contentHash: string;
}
export interface WorkflowSpec {
  schemaVersion: number;
  driverRevision: string;
  steps: { id: string; prompt: string; includePreviousOutput: boolean }[];
}
export interface BenchmarkVersion {
  id: string;
  definitionId: string;
  contentHash: string;
  publishedAt: number;
  manifest: BenchmarkDraft;
}
export interface BenchmarkDefinition {
  id: string;
  draftRevision: number;
  archived: boolean;
  /** When it was archived; null when live or archived before this was recorded. */
  archivedAt: number | null;
  /** Earlier archive periods a restore closed, as [archivedAt, restoredAt]; omitted when none. */
  archiveHistory?: [number, number][];
  draft: BenchmarkDraft;
  versions: BenchmarkVersion[];
}
export interface ValidationReport {
  valid: boolean;
  issues: string[];
}
export interface Configuration {
  id: string;
  providerId: string;
  accountId: string | null;
  modelId: string;
  effort: string | null;
  fastMode: boolean | null;
  billingMode: string;
  executionProfile: string;
  inventoryRevision: string | null;
  /** Display name the bridge reported for the model id, for example "Opus 5.5". */
  modelName?: string | null;
}
export interface RunRequest {
  requestKey: string;
  versionIds: string[];
  configurations: Configuration[];
  repetitions: number;
  timeoutSeconds: number;
  maxExecutions: number;
  preview: boolean;
}
export interface RunPreview {
  valid: boolean;
  issues: string[];
  executionCount: number;
  estimatedCost: number | null;
  costReason: string;
}
export interface BenchmarkRun {
  id: string;
  state: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  request: RunRequest;
  attempts: Attempt[];
}
export interface RunSummary {
  id: string;
  state: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  request: RunRequest;
  attemptCount: number;
  settledCount: number;
  /** What each requested configuration's attempts acknowledged while the run can still start attempts. */
  observedSelections: ObservedRunSelection[];
  /** The cells an unfinished run still has a non-terminal attempt in; absent on older summaries. */
  openCells?: OpenRunCell[];
}
/** A requested configuration and case an unfinished run has yet to settle. */
export interface OpenRunCell {
  configurationId: string;
  versionId: string;
}
/** The effort and fast mode a requested configuration ran with in one run. */
export interface ObservedRunSelection {
  configurationId: string;
  effort: string | null;
  fastMode: boolean | null;
}
/** The human verdict behind a creative rendering. */
export interface DesignReview {
  score: number;
  reason: string;
  details: Record<string, number> | null;
  createdAt: number;
}
/** One panel member's verdict on a rendering. */
export interface DesignJudge {
  configuration: Configuration;
  score: number;
  reason: string;
  details: Record<string, number> | null;
}
/** The newest rendering of one creative brief by one configuration. */
export interface DesignEntry {
  attemptId: string;
  runId: string;
  runCreatedAt: number;
  versionId: string;
  name: string;
  taskFamily: string;
  difficulty: string | null;
  outputFormat: string | null;
  configuration: Configuration;
  phase: string;
  outcome: string | null;
  output: string | null;
  finishedAt: number | null;
  durationMs: number | null;
  outputTokens: number | null;
  cost: number | null;
  review: DesignReview | null;
  judges: DesignJudge[];
  /** The score the leaderboard reads: the human review, else the judges' median. */
  score: number | null;
}
export interface AttemptSummary {
  id: string;
  runId: string;
  versionId: string;
  modelId: string;
  repetition: number;
  phase: string;
  outcome: string | null;
  finishedAt: number | null;
  durationMs: number | null;
  outputTokens: number | null;
  cost: number | null;
}
export interface TokenUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  cost: number | null;
  schema: string;
}
export interface Artifact {
  kind: string;
  path: string;
  hash: string;
  label: string;
}
export interface Evaluation {
  id: string;
  evaluatorRevision: string;
  verdict: string;
  score: number | null;
  reason: string;
  createdAt: number;
  provenance: string;
  artifacts: Artifact[];
  /** Criterion scores and versioned evaluator metadata. */
  details?: Record<string, unknown> | null;
  /** The panel member behind a judge verdict. */
  judge?: Configuration | null;
  usage?: TokenUsage | null;
}
export interface Attempt {
  id: string;
  runId: string;
  versionId: string;
  configuration: Configuration;
  repetition: number;
  phase: string;
  outcome: string | null;
  reason: string | null;
  sessionId: string | null;
  hostRunId: string | null;
  observed: Configuration | null;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  output: string | null;
  evidenceHash: string | null;
  usage: TokenUsage;
  evaluations: Evaluation[];
  eventCursor: number;
  workflowSteps: WorkflowStepEvidence[];
}
export interface WorkflowStepEvidence {
  rootTaskId: string;
  stepId: string;
  parentStepId: string | null;
  entryStateHash: string;
  attemptId: string;
  sessionId: string | null;
  hostRunId: string | null;
  evidenceHash: string | null;
  outcome: string | null;
}
export interface BenchmarkEvent {
  sequence: number;
  entityId: string;
  kind: string;
  createdAt: number;
}
export interface Capability {
  providerId: string;
  executionProfile: string;
  supported: boolean;
  reason: string;
}
/** One effective-dated fact about a model: list prices, context size, display overrides. */
export interface CatalogEntry {
  id: string;
  kind: string;
  providerId: string | null;
  needle: string;
  displayName: string | null;
  vendor: string | null;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
  contextTokens: number | null;
  effectiveFrom: number;
  checkedAt: number;
  source: string;
  createdAt: number;
}
/** One recorded inventory probe: which models a provider listed, and how it named them. */
export interface CandidateObservation {
  id: string;
  capturedAt: number;
  providerId: string;
  accountId: string | null;
  models: InventoryModel[];
  authoritative: boolean;
}
export interface InventoryModel {
  configuration: Configuration;
  name: string;
  efforts: string[];
  supportsFastMode: boolean;
  available: boolean;
  reason: string | null;
}
export interface ResultQuery {
  runId?: string | null;
  versionIds?: string[] | null;
  attemptIds?: string[] | null;
  /** The ledger as it stood at this time. */
  asOf?: number | null;
  offset?: number | null;
  limit?: number | null;
}
export interface LeaderboardRow {
  comparisonKey?: string;
  /** Exact measured case set; equal counts alone do not make a trend. */
  scoredVersionIds: string[];
  configuration: Configuration;
  passed: number;
  scored: number;
  attempted: number;
  planned: number;
  quality: number | null;
  medianDurationMs: number | null;
  medianOutputTokens: number | null;
  cost: number | null;
  measuredAt: number | null;
  /** One scale for every board: points out of 1000, computed by the service. */
  points: number | null;
  efficiencyPoints: number | null;
  speedPoints: number | null;
  costPoints: number | null;
  status: string;
  reason: string;
  attemptIds: string[];
  /** Success per work class of the suite, in the cohort's class order. */
  axes: LeaderboardAxis[];
  /** Pool cases without a scored result: the gap a catch-up run fills. */
  missingVersionIds: string[];
}
export interface LeaderboardAxis {
  id: string;
  quality: number | null;
  points: number | null;
  passed: number;
  scored: number;
  planned: number;
}
/** The newest frozen suite the leaderboard compares; every row shares it. */
export interface LeaderboardCohort {
  runIds: string[];
  versionIds: string[];
  repetitions: number;
  timeoutSeconds: number;
  maxExecutions: number;
  newestRunAt: number;
  workClasses: string[];
}
export interface LeaderboardReport {
  cohort: LeaderboardCohort | null;
  rows: LeaderboardRow[];
}
export interface Baseline {
  id: string;
  name: string;
  runIds: string[];
  createdAt: number;
  threshold: number;
  snapshots: Attempt[];
}
export interface Comparison {
  baselineId: string;
  configurationId: string;
  configuration: Configuration;
  qualityChange: number | null;
  retainedQualityPercent: number | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  status: string;
  reason: string;
  attemptIds: string[];
  durationChangePercent: number | null;
  tokenChangePercent: number | null;
  method: string;
  measuredAt: number | null;
}
export interface UsageComparison {
  accountScope: string;
  windowId: string;
  retainedPercent: number | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  status: string;
  reason: string;
  sampleIds: string[];
}
export interface UsageSample {
  id: string;
  runId: string;
  accountScope: string;
  windowId: string;
  capturedAt: number;
  beforeUsedPercent: number | null;
  afterUsedPercent: number | null;
  resolutionPercent: number | null;
  resetAt: number | null;
  attribution: string;
  status: string;
  completedTasks: number;
  usedPercentagePoints: number | null;
  reason: string;
  attemptIds: string[];
  evidence: unknown;
}
export interface UsageLedgerEntry {
  attemptId: string;
  sessionId: string;
  providerId: string;
  modelId: string;
  effort: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  finishedAt: number;
}
export interface ExportResult {
  id: string;
  path: string;
  manifestPath: string;
  rowCount: number;
  contentHash: string;
}
export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  intervalMinutes: number;
  nextDueAt: number;
  request: RunRequest;
  missed: boolean;
  discovery: DiscoveryRule | null;
  maxRuns: number;
  maxTotalExecutions: number;
  generatedRunIds: string[];
  pausedReason: string | null;
}
export interface DiscoveryRule {
  providerId: string;
  accountId: string | null;
  includeNewModels: boolean;
  modelIds: string[];
  maxCandidates: number;
}
export interface RoutingEvidenceQuery {
  schemaVersion: number;
  mode: string;
  purpose: string;
  targetVersionId: string | null;
  targetFamily: string;
  workClassId: string;
  facets: TaskFacets;
  roleContextHash: string;
  entryStateHash: string | null;
  candidates: {
    configuration: Configuration;
    available: boolean;
    reason: string | null;
  }[];
  cutoffAt: number;
  permittedSplits: string[];
  objective: { kind: string; minQuality: number };
  constraints: {
    providerIds: string[];
    hardCandidateKey: string | null;
    maxDurationMs: number | null;
    maxCost: number | null;
  };
  maxAgeMs: number;
  timeoutSeconds?: number | null;
}
export interface RoutingEvidence {
  schemaVersion: number;
  generatedAt: number;
  queryHash: string;
  mode: string;
  candidates: RoutingEvidenceRow[];
}
export interface RoutingEvidenceRow {
  candidateKey: string;
  configuration: Configuration;
  available: boolean;
  eligible: boolean;
  status: string;
  reason: string;
  quality: number | null;
  meanDurationMs: number | null;
  meanCost: number | null;
  sampleCount: number;
  missingCount: number;
  protocolTimeoutSeconds: number | null;
  familyCount: number;
  latestEvidenceAt: number | null;
  attemptIds: string[];
}
