//! Benchmark wire contract. Times are UTC milliseconds; absent measurements stay null.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkError {
    pub code: String,
    pub message: String,
}
impl BenchmarkError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl From<sqlx::Error> for BenchmarkError {
    fn from(e: sqlx::Error) -> Self {
        Self::new("storage_unavailable", e.to_string())
    }
}
impl From<std::io::Error> for BenchmarkError {
    fn from(e: std::io::Error) -> Self {
        Self::new("storage_unavailable", e.to_string())
    }
}
impl From<serde_json::Error> for BenchmarkError {
    fn from(e: serde_json::Error) -> Self {
        Self::new("validation", e.to_string())
    }
}
pub type Result<T> = std::result::Result<T, BenchmarkError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evaluator {
    pub kind: String,
    pub expected: String,
    pub rubric: String,
    pub revision: String,
    pub known_good: String,
    pub known_bad: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub timeout_seconds: u32,
    pub max_turns: u32,
    pub max_artifact_bytes: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Permissions {
    pub tools: Vec<String>,
    pub network: bool,
    pub context: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fixture {
    pub path: String,
    pub content: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BenchmarkDraft {
    pub schema_version: u32,
    pub name: String,
    pub description: String,
    pub category: String,
    pub task_family: String,
    pub split: String,
    pub prompt: String,
    pub source: String,
    pub license: String,
    pub execution_profile: String,
    pub measurement_profile: String,
    pub evaluator: Evaluator,
    pub permissions: Permissions,
    pub limits: Limits,
    pub repetitions: u32,
    pub fixtures: Vec<Fixture>,
    pub environment: Value,
    #[serde(default = "default_work_class")]
    pub work_class_id: String,
    #[serde(default)]
    pub role_id: Option<String>,
    #[serde(default)]
    pub facets: TaskFacets,
    #[serde(default)]
    pub role_prompt: String,
    #[serde(default = "default_context_hash")]
    pub role_context_hash: String,
    #[serde(default)]
    pub entry_state: Option<EntryState>,
    #[serde(default)]
    pub workflow: Option<WorkflowSpec>,
}
pub fn default_work_class() -> String {
    "general-light".into()
}
pub fn default_context_hash() -> String {
    "clean-v1".into()
}
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskFacets {
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub difficulty: Option<String>,
    #[serde(default)]
    pub input_bytes: Option<u64>,
    #[serde(default)]
    pub output_format: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntryState {
    pub schema_version: u32,
    pub root_task_id: String,
    pub step_id: String,
    pub parent_step_id: Option<String>,
    pub fixture_snapshot_hash: String,
    pub conversation_prefix: String,
    pub previous_reports: Vec<String>,
    pub remaining_budget_seconds: u32,
    pub content_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSpec {
    pub schema_version: u32,
    pub driver_revision: String,
    pub steps: Vec<WorkflowStep>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStep {
    pub id: String,
    pub prompt: String,
    pub include_previous_output: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkVersion {
    pub id: String,
    pub definition_id: String,
    pub content_hash: String,
    pub published_at: i64,
    pub manifest: BenchmarkDraft,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkDefinition {
    pub id: String,
    pub draft_revision: i64,
    pub archived: bool,
    pub draft: BenchmarkDraft,
    pub versions: Vec<BenchmarkVersion>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub valid: bool,
    pub issues: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    pub id: String,
    pub provider_id: String,
    pub account_id: Option<String>,
    pub model_id: String,
    pub effort: Option<String>,
    pub fast_mode: Option<bool>,
    pub billing_mode: String,
    pub execution_profile: String,
    pub inventory_revision: Option<String>,
    /// Display name the bridge reported for the model id, for example "Opus 5.5".
    #[serde(default)]
    pub model_name: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRequest {
    pub request_key: String,
    pub version_ids: Vec<String>,
    pub configurations: Vec<Configuration>,
    pub repetitions: u32,
    pub timeout_seconds: u32,
    pub max_executions: u32,
    #[serde(default)]
    pub preview: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPreview {
    pub valid: bool,
    pub issues: Vec<String>,
    pub execution_count: u32,
    pub estimated_cost: Option<f64>,
    pub cost_reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkRun {
    pub id: String,
    pub state: String,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub request: RunRequest,
    pub attempts: Vec<Attempt>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: String,
    pub state: String,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub request: RunRequest,
    pub attempt_count: u64,
    pub settled_count: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptSummary {
    pub id: String,
    pub run_id: String,
    pub version_id: String,
    pub model_id: String,
    pub repetition: u32,
    pub phase: String,
    pub outcome: Option<String>,
    pub finished_at: Option<i64>,
    pub duration_ms: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost: Option<f64>,
}
/// The human verdict behind a creative rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignReview {
    pub score: f64,
    pub reason: String,
    pub details: Option<serde_json::Value>,
    pub created_at: i64,
}
/// One panel member's verdict on a rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignJudge {
    pub configuration: Configuration,
    pub score: f64,
    pub reason: String,
    pub details: Option<serde_json::Value>,
}
/// The newest rendering of one creative brief by one configuration, with
/// the markup to show and the review if one was recorded.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignEntry {
    pub attempt_id: String,
    pub run_id: String,
    pub run_created_at: i64,
    pub version_id: String,
    pub name: String,
    pub task_family: String,
    pub difficulty: Option<String>,
    pub output_format: Option<String>,
    pub configuration: Configuration,
    pub phase: String,
    pub outcome: Option<String>,
    pub output: Option<String>,
    pub finished_at: Option<i64>,
    pub duration_ms: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost: Option<f64>,
    pub review: Option<DesignReview>,
    pub judges: Vec<DesignJudge>,
    /// The score the leaderboard reads: the human review, else the judges' median.
    pub score: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
    pub reasoning: Option<u64>,
    pub cost: Option<f64>,
    pub schema: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLedgerEntry {
    pub attempt_id: String,
    pub session_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub effort: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    pub duration_ms: Option<u64>,
    pub finished_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation {
    pub id: String,
    pub evaluator_revision: String,
    pub verdict: String,
    pub score: Option<f64>,
    pub reason: String,
    pub created_at: i64,
    pub provenance: String,
    #[serde(default)]
    pub artifacts: Vec<Artifact>,
    /// Per-criterion scores (0 to 1) behind a rubric review, keyed by criterion id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    /// The panel member behind a judge verdict.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judge: Option<Configuration>,
    /// Provider-reported usage for this evaluator call; absent stays unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub kind: String,
    pub path: String,
    pub hash: String,
    pub label: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub id: String,
    pub run_id: String,
    pub version_id: String,
    pub configuration: Configuration,
    pub repetition: u32,
    pub phase: String,
    pub outcome: Option<String>,
    pub reason: Option<String>,
    pub session_id: Option<String>,
    pub host_run_id: Option<String>,
    pub observed: Option<Configuration>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub duration_ms: Option<u64>,
    pub output: Option<String>,
    pub evidence_hash: Option<String>,
    pub usage: TokenUsage,
    pub evaluations: Vec<Evaluation>,
    pub event_cursor: i64,
    #[serde(default)]
    pub workflow_steps: Vec<WorkflowStepEvidence>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStepEvidence {
    pub root_task_id: String,
    pub step_id: String,
    pub parent_step_id: Option<String>,
    pub entry_state_hash: String,
    pub attempt_id: String,
    pub session_id: Option<String>,
    pub host_run_id: Option<String>,
    pub evidence_hash: Option<String>,
    pub outcome: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkEvent {
    pub sequence: i64,
    pub entity_id: String,
    pub kind: String,
    pub created_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub provider_id: String,
    pub execution_profile: String,
    pub supported: bool,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryModel {
    pub configuration: Configuration,
    pub name: String,
    pub efforts: Vec<String>,
    pub supports_fast_mode: bool,
    pub available: bool,
    pub reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultQuery {
    pub run_id: Option<String>,
    pub version_ids: Option<Vec<String>>,
    /// Exact attempts to list; reports hand these to the evidence dialog.
    #[serde(default)]
    pub attempt_ids: Option<Vec<String>>,
    /// The ledger as it stood at this time: runs and attempts after it are left out.
    #[serde(default)]
    pub as_of: Option<i64>,
    pub offset: Option<u32>,
    pub limit: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardRow {
    /// Per-case runtime, effective timeout and scoring protocol, for trend boundaries.
    #[serde(default)]
    pub comparison_key: String,
    /// Exact scored versions, so partial snapshots with equal counts are not
    /// mistaken for measurements of the same tasks.
    pub scored_version_ids: Vec<String>,
    pub configuration: Configuration,
    pub passed: u32,
    pub scored: u32,
    pub attempted: u32,
    pub planned: u32,
    pub quality: Option<f64>,
    pub median_duration_ms: Option<f64>,
    pub median_output_tokens: Option<f64>,
    pub cost: Option<f64>,
    pub measured_at: Option<i64>,
    /// One scale for every board, so the selector reads the same numbers the
    /// operator sees: success scales to points out of 1000; on efficiency,
    /// speed and cost the best comparable configuration scores 1000 and the
    /// others in proportion.
    pub points: Option<u32>,
    pub efficiency_points: Option<u32>,
    pub speed_points: Option<u32>,
    pub cost_points: Option<u32>,
    pub status: String,
    pub reason: String,
    pub attempt_ids: Vec<String>,
    /// Success per work class of the suite, in the cohort's class order.
    pub axes: Vec<LeaderboardAxis>,
    /// Pool cases this configuration has no scored result for: the gap a
    /// catch-up run fills.
    #[serde(default)]
    pub missing_version_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardAxis {
    pub id: String,
    pub quality: Option<f64>,
    /// Measured success as points out of 1000.
    pub points: Option<u32>,
    pub passed: u32,
    pub scored: u32,
    pub planned: u32,
}
/// One effective-dated fact about a model: list prices, context size, display
/// overrides. Reports resolve the entry that applied at measurement time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub kind: String,
    /// Restricts the entry to one provider; None matches every provider.
    pub provider_id: Option<String>,
    /// Lowercase substring matched against the model's display name and id.
    pub needle: String,
    pub display_name: Option<String>,
    pub vendor: Option<String>,
    pub input_per_million: Option<f64>,
    pub output_per_million: Option<f64>,
    pub cache_read_per_million: Option<f64>,
    pub cache_write_per_million: Option<f64>,
    pub context_tokens: Option<u64>,
    pub effective_from: i64,
    pub checked_at: i64,
    pub source: String,
    pub created_at: i64,
}
/// The newest frozen suite the leaderboard compares: every row shares these conditions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardCohort {
    pub run_ids: Vec<String>,
    pub version_ids: Vec<String>,
    pub repetitions: u32,
    pub timeout_seconds: u32,
    pub max_executions: u32,
    pub newest_run_at: i64,
    pub work_classes: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardReport {
    pub cohort: Option<LeaderboardCohort>,
    pub rows: Vec<LeaderboardRow>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshot {
    pub id: String,
    pub run_id: String,
    pub created_at: i64,
    pub report: LeaderboardReport,
    pub recalculated_report: LeaderboardReport,
    pub backfilled_version_ids: Vec<String>,
    pub revised_version_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Baseline {
    pub id: String,
    pub name: String,
    pub run_ids: Vec<String>,
    pub created_at: i64,
    pub threshold: f64,
    #[serde(default)]
    pub snapshots: Vec<Attempt>,
    #[serde(default)]
    pub run_conditions: Vec<RunRequest>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub baseline_id: String,
    pub configuration_id: String,
    pub configuration: Configuration,
    pub quality_change: Option<f64>,
    pub retained_quality_percent: Option<f64>,
    pub interval_low: Option<f64>,
    pub interval_high: Option<f64>,
    pub status: String,
    pub reason: String,
    pub attempt_ids: Vec<String>,
    pub duration_change_percent: Option<f64>,
    pub token_change_percent: Option<f64>,
    pub method: String,
    pub measured_at: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSample {
    pub id: String,
    pub run_id: String,
    pub account_scope: String,
    pub window_id: String,
    pub captured_at: i64,
    pub before_used_percent: Option<f64>,
    pub after_used_percent: Option<f64>,
    pub resolution_percent: Option<f64>,
    pub reset_at: Option<i64>,
    pub attribution: String,
    pub status: String,
    pub completed_tasks: u32,
    pub used_percentage_points: Option<f64>,
    pub reason: String,
    pub attempt_ids: Vec<String>,
    #[serde(default)]
    pub evidence: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub id: String,
    pub path: String,
    pub manifest_path: String,
    pub row_count: u32,
    pub content_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Schedule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub interval_minutes: u32,
    pub next_due_at: i64,
    pub request: RunRequest,
    pub missed: bool,
    #[serde(default)]
    pub discovery: Option<DiscoveryRule>,
    #[serde(default = "default_max_runs")]
    pub max_runs: u32,
    #[serde(default = "default_total_executions")]
    pub max_total_executions: u32,
    #[serde(default)]
    pub generated_run_ids: Vec<String>,
    #[serde(default)]
    pub paused_reason: Option<String>,
}
pub fn default_max_runs() -> u32 {
    20
}
pub fn default_total_executions() -> u32 {
    100
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoveryRule {
    pub provider_id: String,
    pub account_id: Option<String>,
    pub include_new_models: bool,
    pub model_ids: Vec<String>,
    pub max_candidates: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutingObjective {
    pub kind: String,
    pub min_quality: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutingConstraints {
    #[serde(default)]
    pub provider_ids: Vec<String>,
    pub hard_candidate_key: Option<String>,
    pub max_duration_ms: Option<f64>,
    pub max_cost: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutingCandidate {
    pub configuration: Configuration,
    pub available: bool,
    pub reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutingEvidenceQuery {
    pub schema_version: u32,
    pub mode: String,
    pub purpose: String,
    pub target_version_id: Option<String>,
    pub target_family: String,
    pub work_class_id: String,
    pub facets: TaskFacets,
    pub role_context_hash: String,
    pub entry_state_hash: Option<String>,
    pub candidates: Vec<RoutingCandidate>,
    pub cutoff_at: i64,
    pub permitted_splits: Vec<String>,
    pub objective: RoutingObjective,
    pub constraints: RoutingConstraints,
    pub max_age_ms: u64,
    /// None selects the newest compatible earlier run's timeout cohort.
    #[serde(default)]
    pub timeout_seconds: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingEvidenceRow {
    pub candidate_key: String,
    pub configuration: Configuration,
    pub available: bool,
    pub eligible: bool,
    pub status: String,
    pub reason: String,
    pub quality: Option<f64>,
    pub mean_duration_ms: Option<f64>,
    pub mean_cost: Option<f64>,
    pub sample_count: u32,
    pub missing_count: u32,
    pub protocol_timeout_seconds: Option<u32>,
    pub family_count: u32,
    pub latest_evidence_at: Option<i64>,
    pub attempt_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingEvidence {
    pub schema_version: u32,
    pub generated_at: i64,
    pub query_hash: String,
    pub mode: String,
    pub candidates: Vec<RoutingEvidenceRow>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionSnapshot {
    pub schema_version: u32,
    pub id: String,
    pub run_id: String,
    pub version_id: String,
    pub task_family: String,
    pub split: String,
    pub created_at: i64,
    pub work_class_id: String,
    pub role_id: Option<String>,
    pub facets: TaskFacets,
    pub role_context_hash: String,
    pub entry_state: Option<EntryState>,
    pub public_prompt: String,
    pub public_fixtures: Vec<Fixture>,
    pub role_prompt: String,
    pub candidates: Vec<RoutingCandidate>,
    pub selection_provenance: String,
    pub request: RunRequest,
    pub feature_extraction_version: String,
    pub objective: RoutingObjective,
    pub constraints: RoutingConstraints,
    pub permissions: Permissions,
    pub execution_profile: String,
    pub measurement_profile: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateObservation {
    pub id: String,
    pub captured_at: i64,
    pub provider_id: String,
    pub account_id: Option<String>,
    pub models: Vec<InventoryModel>,
    pub authoritative: bool,
}
#[derive(Debug, Clone)]
pub struct QueryData {
    pub definitions: Vec<BenchmarkDefinition>,
    pub versions: Vec<BenchmarkVersion>,
    pub runs: Vec<BenchmarkRun>,
    pub attempts: Vec<Attempt>,
}
