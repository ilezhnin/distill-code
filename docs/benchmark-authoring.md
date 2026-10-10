# Benchmark authoring and application contracts

This document describes the generic benchmark workflow. Private task plans,
task content, qualification evidence and measurement reports are local data,
stored outside the application repository under the configured Distill root.
Detailed working plans belong in `benchmark-tasks/documentation`. Do not append
private task details or campaign results to this document.

## Data ownership

The benchmark service owns definitions, immutable versions, runs, attempts,
evaluations and evidence. Its database and artifacts live under `benchmarks`
inside the configured application root. Private authoring assets live under
`benchmark-tasks` in that root, outside project checkouts. Local publication in
Bench development freezes a version in this store; it does not publish to GitHub.

Actual evaluation prompts, fixture data, repository snapshots, expected answers,
protected checks, rubrics, alternatives, mutants, per-task documentation and
results must not enter project Git, public issues, commit messages or CI uploads.
Bundled examples and infrastructure regression fixtures are intentionally public
development data. They cannot establish an unseen evaluation or model ranking.
Store private backups locally with the same access restrictions as their source.

Git ignores prevent ordinary accidental additions, but do not remove tracked
files, old blobs, commit messages, remote copies or forks. Review both the staged
tree and outgoing history. Previously disclosed material must not be relabeled
as an unseen holdout merely because its latest file was deleted.

The staged-file hook rejects private artifact directories and private artifact
references in documentation. It is an accidental-disclosure check, not a semantic
audit of arbitrary text. During history remediation, set the local Git option
`distill.privateBenchmarkHistoryPending` to `true`: while older local tags and
branches still carry removed history, the pre-push hook then publishes only a
fast-forward of an existing branch whose new commits all grow from its published
tip, and refuses tags, new or deleted refs and merged-in older history. Clear
that option only after the authorized history review. Hooks are local
safeguards and can be bypassed; they cannot retract remote copies.

Remote inference sends selected task inputs to the selected provider. Local
storage, sandbox isolation and exclusion from Git do not establish a provider's
training or retention policy. Verify the applicable account and service controls
before a private evaluation; do not infer them from the model name.

## Authoring a definition

Use Bench development to create or import a draft. The authoritative wire schema
is `src-tauri/src/services/benchmarks/types.rs`; the editor and validation command
use the same service. An imported definition is not ready for measurement until
its contract and evaluator have been qualified.

Specify:

- A descriptive name, category, work class, task family, source and license.
- The public prompt, permitted fixture files and required deliverable format.
- An execution profile: native text, isolated UI or protected repository.
- An objective evaluator or a versioned rubric with a calibrated judge protocol.
- Tool and network permissions, prerequisites, time and artifact bounds.
- Repetition count, dataset split, difficulty and other applicable facets.
- Source provenance, author exclusions, role context and related-family grouping.

Keep every requirement visible in the public contract. Protected tests may vary
inputs but must not invent hidden requirements. Known-good and known-bad outputs
exercise publication checks; they do not replace independent alternatives,
requirement-specific mutants and trusted-verdict isolation checks.

Development examples exercise the application. Training data supplies fitting
and calibration. Held-out families are reserved for independent evaluation.
Assign related variants to the same split before measuring candidates; changing
names or fixture values does not create a new independent family.

## Evaluators and isolation

Text evaluators support exact, structured and rubric-based judgments. Browser
checks must exercise declared interactions, keyboard behavior and viewport state.
Visual judgments and functional correctness remain separately inspectable.
Use invented examples in infrastructure tests rather than private task content.

JavaScript checks require a callable `functionName` and 1-100 `argsCases`, each
with an `args` array and an explicit `expected` value. When the public contract
forbids input changes, set `immutableArgs` to the argument indices to preserve.
The worker checks those values independently of the returned result. Draft
validation rejects malformed cases and indices missing from any case before
publication starts reference execution.

Repository tasks use immutable public snapshots and an isolated workspace.
Protected evaluator code and expected observations remain outside the candidate's
view. Where submitted code must run, the trusted checker and candidate process
communicate through the supported isolated probe boundary. Candidate stdout or
exit status alone must not forge the trusted verdict. Verify resource limits,
cancellation and cleanup as part of evaluator qualification.

Rubric tasks can freeze their judge seats in `environment.judgePanel`, with
`recipe: "frozen-native-panel-v1"` and a `judges` array of two or three complete
configurations. Each seat pins its account, model, effort, fast mode, billing
mode, native text profile and inventory revision. The rubric needs 1-32 distinct
criteria with finite positive weights. Authors and candidates cannot
occupy a seat. A null effort is allowed only when the model offers no effort
selection; it never means a moving default. The runner checks current
availability and the pinned runtime
before each judge call; it never substitutes another judge for a frozen seat.
Text panels accept verified native text providers; visual panels additionally
require image support. Complete votes must come from distinct registered seats
and sessions in the same batch. This binding is separate from the historical
display protocol hash. Frozen judges must return a JSON score sheet covering
exactly the declared criteria, each between 0 and 10; malformed or out-of-range
scores abstain. Freezing seats alone does not qualify a rubric.

Rubric qualification also registers `rubric.minimumAcceptedScore`,
`rubric.maximumRejectedScore` and `rubric.maxJudgeCalls`. The budget must cover
every control/seat pair and cannot exceed 384 calls. The native service reserves
the immutable first request and runs the same rendering, prompt, judge execution
and scoring path used for candidate answers. It returns the reserved record
while calibration continues; the qualification details poll progress. Every
judge must meet the registered score band on every control. At least two accepted
and two rejected controls must actually reach the panel; format rejection alone
cannot establish semantic calibration. Failed or incomplete panels stay failed.

Control evidence, session identities, partial usage and rendering artifacts live
in qualification storage and never create model attempts, training observations
or leaderboard entries. Revocation stops further judge calls and cancels an
active calibration turn. Restart seals incomplete first qualifications as failed
without replaying them; unknown usage remains unknown. These controls establish
agreement on the reviewed examples, not independence, empirical task difficulty,
universal grader reliability or permission to deploy a selector. Research fits
and promotion registration verify that rubric labels and qualification controls
use the current published panel, scoring prompt and renderer. Human overrides
cannot inherit that calibration.

Bounded rubric workflows require a frozen panel. Intermediate steps execute
without the final rubric or judge calls; the panel scores only the root's final
answer. Judge exclusions cover every contributing requested and acknowledged
worker, and research policies exclude every available worker before reservation.
The execution budget reserves all steps plus the exact number of final judges.
Each judge has a separately frozen 180-second turn limit. The root execution
clock ends before judging, so executor utility remains based on generation time
and generation cost. Reports record judge calls, durations and costs separately,
retaining unknown costs. Objective campaigns retain their existing protocol and
serialized hashes; rubric campaigns use a distinct frozen-panel report recipe.

Rubric evaluation records the exact judge identity, protocol and evidence. A
judge that accepts a consequentially wrong control is not qualified by wording
changes alone. Qualification campaigns require their own bounded authorization.

## Versions, execution and evidence

Saving a draft does not change a published version. Publication validates the
manifest and applicable reference checks, then seals a content-addressed version.
Revisions and reevaluations preserve the earlier evidence instead of overwriting
it. Changing a task invalidates any qualification that is not explicitly bound
to its new public contract and evaluator.

Freeze the candidate provider, concrete model, native effort, runtime, repetitions
and limits before starting a run. Author exclusions remain binding. Missing
measurements, infrastructure failures and unsupported configurations are explicit
states, not automatic failures or free execution. Preserve every planned outcome.

The leaderboard lists each provider/model identity once. Accounts, execution
profiles, effort, fast mode, billing and runtime revisions belong to its run
evidence and never create another model. A moving vendor alias retains the
reported model generation. The model page shows one score and history across
all its tests. Each test contributes its newest scored cell, retaining one
run's configuration and repetitions together. Repeated tests count once,
infrastructure errors do not erase measured results, and scores are never
selected for being higher. Execution conditions remain in individual evidence.
Coverage labels count measured tests against the full eligible pool; hover
details separate passed, not passed and untested cases. Scores with incomplete
coverage are preliminary; untested cases are not failed cases. Speed and cost
percentages compare solved cases with their best measurements and are not test
pass rates.

The model chart uses one history recalculated against the current pool, with
each observation anchored to its original measurement date. Runs without scored
results add no observation and cannot extend the chart's time range. Original
dated reports remain in the evidence API; the model page does not switch between
scoring methods or fall back to a different method when no current-pool result
exists.

The runner commits decision inputs before dispatch. Workflow steps retain their
declared entry state and preceding reports. Retry or recovery must not recreate
a decision from a later answer or silently replay an ambiguous accepted turn.
Step records are dependent trajectory evidence, not additional independent tasks;
the final task score must not be copied into intermediate rewards.

Research workflow runs can freeze a learned, persona-prior or fixed-worker
policy using `benchmark_preview_workflow_policy` and
`benchmark_start_workflow_policy`. The request names a saved fit, its exact
candidate runtimes and accounts, preference order, quality floor, root versions,
repetitions and an explicit execution/time budget. These runs are serial and
cannot add cases or change concurrency after admission. Selection checks current
availability at each step, commits the shared executor decision before execution,
and preserves explicit fixed-worker pins. A learned abstention uses the declared
available preference order. Quota or worker refusals terminate the trajectory
without silently moving accounts or retrying the worker.

`benchmark_get_workflow_trace` reads a root attempt with verified step inputs,
selection decisions and actual per-step attempts. The root retains summed worker
usage and durations; its start/end timestamps separately bound whole-trajectory
wall time. A mixed-worker result has no single observed executor and does not
enter individual-worker leaderboards, training exports or ordinary selection
evidence. These research runs are not a preregistered comparative promotion
campaign by themselves and do not authorize learned routing.

## Analysis, exports and selection

Leaderboard views and exports read the common service evidence. Development
examples stay outside rating and training pools. Complete compatible repetition
cells are required for supported comparisons; absent usage remains unknown.

Exports contain public decision features, pseudonymous candidate/account
identities and separately labeled outcomes. Protected evaluator contents are not
inference features. Held-out data requires explicit export scope. Export files
remain private local artifacts even when their schema is documented publicly.

Learned fits, holdout reservations and reports are research artifacts. A fit or a
positive isolated comparison does not authorize production dispatch. Promotion
requires qualified independent coverage, frozen baselines and a preregistered
evaluation, resource accounting and complete workflow verification. Explicit
model pins and current worker availability remain binding at dispatch.

## Research workflow campaigns

Research workflow comparisons can be frozen through
`benchmark_freeze_workflow_campaign`, then explicitly started, paused, resumed
or cancelled through `benchmark_control_workflow_campaign`. Freezing makes no
provider calls. The immutable plan binds the fit, candidate settings/accounts,
unused held-out families, every policy, repetitions, budgets, execution order
and report recipe. Learned, training-aggregate, persona and every fixed-worker
policy run as separate complete trajectories in the same serial campaign.
The aggregate order uses equal-group mean utility on common cases from the
fit's saved training snapshot. Its order is checked before admission.

Campaign reservations share family/group ownership with executor holdouts.
Related versions cannot be run outside the registered campaign. Campaign child
runs cannot be extended, replaced, manually rescored or resumed independently.
Stopping the app pauses the campaign; explicit resume preserves its first
attempts and never replaces an uncertain or failed trajectory. An unscored
trajectory pauses the series; resuming can finish the remaining cells but cannot
make that missing first measurement disappear.

`benchmark_workflow_campaign_report` requires all planned first measurements.
It compares whole trajectories with equal group weights, paired group bootstrap
intervals, best-fixed reselection within each resample, and a hindsight upper
bound over the registered policies. Timing covers whole workflow wall time;
cost remains the reported generation cost. Missing weighted resources prevent
a complete utility comparison. Reports and traces remain private local data.
Exploratory intervals do not establish qualification or authorize promotion.

Schema-2 workflows give each step its own role, work class and time allowance.
A campaign over steps of several classes names the fitted model for every step
class; all its cases share one step class sequence and every class model uses
the same utility weights. `benchmark_campaign_deployment` returns what a
campaign evaluated, computed from its frozen cases: one shared contract, or the
exact step-by-step trajectory with its root wall budget. A promotion rule
acknowledges that projection unchanged, and qualification covers the training
versions of every class model. A trajectory certificate names each step's
contract and class model and authorizes only that exact sequence. A wave root
that plans the same steps finds it, and each later step uses the model
certified for its own position. The root holds that authority for its own
step even when later steps never run. A single task, a step that departs from
the plan, or a lineage longer than the certified sequence keeps its prior or
explicit pin. Without a trajectory certificate, a certificate of one contract
covers each step until the role or class changes.

## Class selection in ordinary chats and waves

Once a work class has an active certificate, the newest one chooses for every
ordinary chat and wave of that class: its class model scores the available
candidates that it was trained on, under the same inventory, and the best one
above the certificate's quality floor runs. This applies whatever the agent's
role, prompt or tools, so it reaches beyond the exact contract the campaign
evaluated. An explicit model pin or a bound session target stays binding. When
the class has no certificate, or its model abstains (no trained candidate is
available, or none reaches the floor), the preference order from Routing chooses
and the decision records why. Revoking the certificate returns the class to that
order at once. `benchmark_class_policies` reports each class's certificate, or
the qualified training and held-out cases, fits and campaigns it still lacks;
Routing, the agent page and the chat hint show the same state.

## Verification and maintenance

Follow `AGENTS.md` for source checks, tests and Windows runtime validation.
Exercise the affected path through the actual application when service or UI
behavior changes. Keep task-specific evidence and lifecycle checkpoints in the
private local store. Repository documentation should describe the application
contract and template rules, without identifying private tasks or disclosing
their solution mechanisms.
