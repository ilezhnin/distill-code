# Operating benchmarks and learned routing

This guide takes a new operator from a working installation to qualified tasks,
measured model configurations, a locally trained selector, and routing in chats
and conductor waves. It describes the application contract, not a particular
dataset, experiment, account, or result. Keep the actual inputs and evidence
outside Git. [Authoring contracts](benchmark-authoring.md) give evaluator-specific
details; [provider accounts](provider-accounts.md) explain authentication.

## What is being trained

The candidate is a concrete provider, model, reasoning effort and speed setting
under a recorded execution profile and runtime revision. Account identity binds
an execution; it is not an independent model. Compare configurations on the same
tasks and repetitions before learning which configuration suits a task.

Training produces a small local selector. It does not fine-tune the candidate
language models. Its inputs are the task's public prompt, permitted fixtures,
class, role, permissions, limits and visible entry state. Expected answers,
protected checks, future step outputs and held-out outcomes are not inputs.

The lifecycle has separate gates:

| Stage | Evidence produced | What it establishes |
| --- | --- | --- |
| Author and publish locally | Immutable task version and evaluator revision | A reproducible task contract |
| Qualify | Independent review plus positive and negative control results | The evaluator distinguishes the reviewed valid and invalid solutions |
| Measure | Frozen run, first attempts, scores, timing and reported usage | Observed candidate behavior on those tasks |
| Fit | Immutable training snapshot, features and selector coefficients | A research model, with no deployment authority |
| Evaluate workflows | Preregistered held-out comparison against all baselines | Whether the selector meets the frozen acceptance rule |
| Promote and verify | Certificate, routing decision and actual execution | Permission to use the learned policy in its supported application paths |

Passing controls is not empirical model calibration. Repetitions are repeated
measurements of one task, not new independent families. A fit completing is not
evidence that learned routing improves orchestration.

## 1. Prepare the runtime

Build and start Distill using [Windows setup](windows-onboarding.md). From the
repository root, the normal development sequence is:

```powershell
just doctor-windows
just setup-windows
just dev-windows
```

Connect the intended providers in the application. Read the live model inventory
and benchmark capabilities; do not copy a model name, effort list or runtime
revision from another machine. A provider being available for ordinary chat does
not establish that its benchmark execution profile is ready.

Protected repository tasks require the dedicated WSL distribution. With WSL
available and no benchmark sessions running, provision the helpers from the same
checkout as the application, then verify them:

```powershell
node scripts/benchmark-sandbox.mjs
node scripts/benchmark-sandbox.mjs status
node scripts/benchmark-sandbox.mjs selftest
```

Provisioning installs dependencies and restarts that distribution. Schedule it
before measurement, not during a run. Sign in to the selected account through
`bench-login` inside the sandbox, following the command described at the top of
[the provisioning script](../scripts/benchmark-sandbox.mjs). Use the account ID
from the application and the provider's normal login flow. Never put credentials
in a task, command transcript intended for publication, or source file.

Before dispatch, verify sandbox readiness, the exact account's authentication,
quota and billing mode, and the provider/model/effort acknowledgement. Windows
and sandbox authentication are separate runtime checks even for the same
account. Refresh expiring credentials only after that account's active sessions
have drained. Choose a dispatch deadline that leaves a complete attempt budget
before a known authentication deadline.

`benchmark_get_capabilities` reports supported execution profiles and reasons
for refusals. Resolve the reported prerequisite; do not substitute a different
account, execution profile or provider to make a frozen run proceed.

## 2. Design a private task collection

Create drafts in Bench development or import them through the same native
service. Start with a work class relevant to the orchestration you intend to
deploy. The authoritative field definitions are
[BenchmarkDraft](../src/features/benchmarks/types.ts) and the native
[wire types](../src-tauri/src/services/benchmarks/types.rs).

| Fields | Authoring decision |
| --- | --- |
| `name`, `description`, `prompt` | Describe a useful task and an observable deliverable; make every requirement public to the candidate |
| `workClassId`, `category`, `facets` | Use an existing work class and describe the task without encoding answers or candidate performance |
| `taskFamily`, `environment.splitGroup`, `split` | Group related variants together and assign `train` or `held_out` before candidate measurements |
| `source`, `license`, author exclusions | Record provenance, permission to use the material, and which candidates must be excluded |
| `executionProfile`, `permissions`, `limits` | Specify the actual tools, network, context, time and artifact bounds |
| `fixtures`, `environment`, `entryState` | Supply the permitted starting material and explicit initial state for the chosen profile |
| `evaluator`, `repetitions` | Define the grading contract, reference controls and repeated measurement count |
| `roleId`, `rolePrompt`, `roleContextHash`, `workflow` | Bind role context and, for workflow roots, the declared sequence of steps |

Develop a task because it tests a meaningful capability. Do not manufacture
difficulty through ambiguous wording, an unexplained output format, a tiny
response limit or an impossible time budget. Review both the reference solution
and a materially different valid solution. Include edge cases that follow from
the public requirements, not from accidental properties of one implementation.

Protect the split at the family level. Renamed prompts, alternate constants,
translations and nearby variants of one solution mechanism are related. Keep
them in one group and split. Development examples shipped in the repository are
public fixtures and cannot serve as unseen held-out tasks.

Separate candidate-visible files from trusted evaluation material. Repository
snapshots must contain only the public starting state; protected checks and
expected answers stay outside that snapshot. Do not spread an entire manifest
into a selector input: use the explicit public-task projection. Keep a private
record of source provenance, exposure, independent review and known limitations.

For cumulative repository workflows, training tasks intended to transfer to
those steps declare both:

```json
{
  "nativeRepositoryRecipe": "repository-cumulative-v1",
  "nativeBudgetRecipe": "native-root-wall-budget-v1"
}
```

These are fields inside `environment`, not a complete draft. Individual training
tasks also need an explicit initial entry. The runner owns the actual initial
repository artifact and wall-budget lease; never fabricate those runtime records
in authoring data. A changed entry contract or recipe requires compatible new
evidence. See [repository collection contracts](benchmark-authoring.md#research-workflow-campaigns).

## 3. Validate, publish locally and qualify

Validate the draft, save it using its expected revision, and publish that exact
revision. Publication freezes a version in the local benchmark store. It does
not upload the task to GitHub. Save the returned version ID and content hash in
the private collection manifest.

Build an independent qualification packet for that version:

1. Review the public contract, accepted alternatives, family independence and
   exposure. Identify the actual reviewer; do not label an automated review as
   a human review.
2. Map each substantive requirement to accepted and rejected controls. Negative
   controls should violate that requirement while otherwise remaining plausible.
   Include alternative implementations, not just edits of the author's answer.
3. Bind `versionId`, `contentHash` and `evaluatorRevision` to the published bytes.
   Submit one stable `requestKey` through `benchmark_qualify_version`.
4. Save its qualification ID and poll `benchmark_get_qualification` until it is
   terminal. Inspect every expected outcome, errors and limitations. A client
   timeout is not cancellation and does not justify a duplicate qualification.
5. Use only passed, unrevoked bindings for later promotion. Changing task or
   evaluator bytes requires reviewing and qualifying the new binding.

For objective tasks, these controls exercise the local evaluator and are not
candidate-model sessions. Rubric qualification can call its frozen judge panel:
register its accepted/rejected score bands and `maxJudgeCalls` in advance and
budget those calls separately. A panel must reject consequentially wrong content,
not merely malformed output. Details and bounds are in
[evaluator qualification](benchmark-authoring.md#evaluators-and-isolation).

Finite controls establish agreement on reviewed examples. Independently assess
coverage, verifier isolation and task usefulness before paying for model runs.

## 4. Freeze and run the measurement matrix

Select immutable versions and complete live `Configuration` records. Freeze
model, account, effort, fast mode, billing, execution profile, runtime revision,
repetitions and limits. Preserve these original configuration IDs for subsequent
workflow campaigns; the fitting service normalizes evidence keys separately.

For objective single-step tasks, the planned candidate count is
`eligible versions x configurations x repetitions`. Author exclusions reduce
eligible cells. Workflow steps and rubric judges add calls; use
`benchmark_preview_run` and its `executionCount` instead of relying on the simple
formula. Qualification-control counts, candidate calls and judge calls are
different quantities and should be reported separately.

Set the research run's `executionLimits.retryPolicy` to `none`. Use at least
three repetitions for a complete leaderboard measurement. Set an explicit
`maxExecutions` and a realistic `timeoutSeconds`; if applicable, also set
`executionLimits.dispatchNotAfterMs`. Review a valid preview and resource budget
before `benchmark_start_run`. Save the exact request, request key, returned run
ID and planned attempt IDs privately before doing further work.

Ordinary runs support `parallelism: 4`. This is a per-configuration limit within
shared limits of four active attempts per account and twelve across the app.
Two reasoning settings on one account share those four slots. Independent
repository bridges can fill the account slots; a shared single-session text
bridge or quota recovery can impose a smaller bound. Inspect actual active
attempts and the reason for a lower count, not just the request value. An existing
ordinary run can be adjusted through `benchmark_set_run_parallelism`; record the
amendment and preserve its original attempt identities.

Observe the existing run with `benchmark_get_run`, attempt evidence and events.
Check requested versus acknowledged provider, model and reasoning settings.
Report successful, unsuccessful, infrastructure-error, cancelled and unmeasured
attempts separately. Preserve unknown usage and cost as unknown; subscription
access does not turn unreported cost into a measured zero.

On an observer timeout, find the saved run ID or reconcile `benchmark_list_runs`
by request key. Do not start a replacement. Pause through `benchmark_pause_run`
and wait for active attempts to finish before an authorized app update or account
refresh. With retries disabled, resume only the same run's untouched pending
attempts; a failed, cancelled or ambiguous dispatched attempt is not a fresh slot.
Do not extend a frozen research matrix after seeing its results.

## 5. Fit and inspect the local selector

Call `benchmark_fit_selector` with a work class, explicit training version IDs,
the original candidate configurations, a past `cutoffAt` timestamp in
milliseconds, and frozen quality/speed/cost weights. Weights sum to one and
quality must be at least 0.5. If cost is unmeasured, choose an objective that does
not require it before evaluation; do not change weights after held-out results.

The current fit requires 8-256 individual training versions, 2-32 candidates,
at least eight common measured cases across at least two independent groups,
and compatible role, permission and execution context. Multi-step root outcomes
cannot be used as individual executor labels. These are admission minima, not
proof that the sample is large or representative enough for deployment.

The current `family-weighted-softmax-kl-v1` recipe works as follows:

1. Average compatible repetitions for each task/configuration cell. Keep absent
   or excluded observations masked; infrastructure errors are not zero rewards.
2. Combine quality with relative speed and cost. Resource credit is multiplied
   by quality, so a fast incorrect answer is not a good target. When a resource
   is unknown among successful candidates, fitting drops that component for the
   entire task comparison and renormalizes the remaining weights. Audit those
   missing values: campaign freezing rejects a fit when weighted speed or cost
   is absent from successful training observations. Held-out reporting also
   requires the resources weighted by its registered comparison.
3. Form soft targets over observed candidates with
   `target(c | task) = softmax(utility(c, task) / 0.25)`.
4. Fit a joint linear selection head on 128 fixed hashed public-task features
   by minimizing `KL(target || policy)`. Each related group receives equal total
   weight. Separate quality estimates enforce the predicted quality floor.
5. Persist the recipe, feature version, weights, cutoff, complete training
   snapshot, evidence identities and coefficients as an immutable artifact.

The fit response is a summary with an `id`. Fetch the actual artifact with
`benchmark_get_selector_fit({ id })`. Inspect its training versions, groups,
candidate identities, per-cell evidence, run IDs, repetition completeness and
runtime revisions. Confirm that no held-out task or future observation entered
the snapshot. Inspect saved training targets and fit diagnostics before evaluating
unseen tasks. The native prediction API refuses known training families and
groups; do not relabel them to bypass that check. Probabilities express relative
preference, not calibrated probabilities of success.

If all candidates have indistinguishable utilities, labels are incomplete, or
the selector simply reproduces one global winner without task-dependent evidence,
keep the fit as research. Do not spend a held-out campaign to excuse unusable
training. A training fit's accuracy is not a generalization result. Changing the
recipe or objective creates a new fit and requires a new evaluation.

## 6. Preregister a held-out workflow comparison

Use previously unused held-out families representative of the intended workflow.
Freezing requires 8-256 distinct held-out workflow versions across at least four
declared independent groups; promotion requires at least eight groups. Plan for
the promotion requirement before collecting data, and assess whether that sample
can support the registered comparisons.
Create workflow roots with an explicit step sequence. Schema-2 steps carry their
own worker role, work class, purpose and time allowance; a mixed-class campaign
must supply `classModelIds` for every step class, all using the same utility
weights. Roles must be worker roles the conductor can actually execute.

Freeze through `benchmark_freeze_workflow_campaign` with the fitted model ID,
held-out version IDs, original native candidate configurations, a complete
`personaPriorIds` preference order, `minQuality`, repetitions, timeout,
`maxExecutions` and `executionLimits: { retryPolicy: "none" }`. Use the original
configuration IDs in the preference order, not the normalized IDs returned inside
a fit.

Freezing makes no provider calls. Inspect the returned immutable plan, case and
model hashes, step counts, policies, order, judge seats and budget. The campaign
compares learned routing, the training-aggregate order, the declared preference
order and every fixed candidate. For objective cases with equal step counts,
candidate calls are `cases x (candidates + 3) x repetitions x steps`. Budget
frozen judge calls separately where applicable.

Before starting any campaign cell:

1. Fetch `benchmark_campaign_deployment({ campaignId })`. Retain its exact
   `contract` and optional `trajectory` projection without reconstructing them.
2. Choose an acceptance rule before seeing held-out results. The supported
   `independent-group-sign-holm-v1` rule registers `alpha` in `(0, 0.05]`, a
   minimum group utility gain in `[0, 1)`, and observed quality in `[0, 1]`.
   Account for independent-group sample size and the number of baselines; more
   repetitions do not create more independent groups.
3. Register through `benchmark_register_promotion_rule` using a stable request
   key, campaign ID, truthful operator identity, that exact projection, and
   passed qualification IDs covering the training and held-out versions.
4. Read back the registered rule and verify the plan and qualification hashes.
   Only then start with `benchmark_control_workflow_campaign` and `action: "start"`.

Campaign requests may freeze `parallelism` from 1 to 12. Omission retains the
legacy serial plan and hashes. This bounds admitted, unfinished whole workflows;
it does not multiply the execution budget or change dependencies within a workflow.
The concurrent scheduling recipe admits cells in their frozen order and refills
after collecting a first result, even if an earlier child is still running.
Provider, account and global worker limits still apply. A campaign may also
freeze `accountSlots`, the model calls one account runs at once for it, from 1
to 8; omission keeps the shared default of four. The bound is part of the plan,
so a report states the conditions it ran under.

New concurrent plans use the `sha256-campaign-cell-step-admission-v4` recipe. A
root is admitted into the trajectory bound without holding any account. Each
step is decided first, on its public task; the root then takes that worker's
slot, oldest waiting root on the account first, and gives it back when the step
ends. Waiting for a free slot is recorded on the step and excluded from the
whole-workflow clock, so an unrelated provider is never held idle for a worker
the policy did not choose, and contention does not shorten a measured budget.

Saved v3 plans (`sha256-campaign-cell-reserved-workers-v3`) keep their pool
reservation: a root stays pending, without an execution clock or worker call,
until it can reserve all worker accounts and lanes its policy may select, and
holds them through its dependent steps. That reservation can leave a provider
idle while another provider executes the current step.

Saved concurrent v2 plans keep their original semantics: local slot contention
spends the root wall budget. Serial v1 plans retain their immediate busy outcome.
Installing a newer backend never rewrites a frozen campaign or its results.
Freeze and review the concurrency contract before preregistration, and check
that the installed backend supports it. No recipe changes accounts, replaces
an attempt or retries a provider call.

Record the runtime and competing load when interpreting speed. Whole-workflow
wall time starts at admission for v3 and v4 and includes preparation and every
dependent step. Queue time before admission is excluded; v4 also excludes the
recorded waits for a worker slot between admission and each step. In v2, wall
time includes local worker waits. Do not pool these execution conditions as if
they were interchangeable, change objective weights after results, or infer a
throughput guarantee from the requested bound. Actual occupancy also depends on
the frozen order, selected workers and available provider quotas.

Pause closes admission for every owned child and drains already running whole
workflows, including their dependent steps. A concurrent campaign stays `pausing`
until its children drain; resume is refused until it is `paused`, when no further
worker calls can start. Pending children remain untouched;
inspect actual active sessions before refreshing credentials or replacing the
runtime. Cancellation signals every active child and preserves settled evidence.
After an application restart the campaign requires explicit resume; ambiguous
first attempts remain final. Keep campaign ownership intact. Do not resume child
runs separately, retry missing first measurements or tune thresholds after
results. The report compares whole trajectories with equal group weights;
intermediate steps are dependent observations and do not inherit the final score.
Missing required measurements prevent a complete acceptance assessment.

The leaderboard keeps the campaign's full workflow count while it drains.
Its compact cards show an attempt-status dot, the current model, a step clock
and one staircase rectangle per workflow step. A green rectangle means that
step completed, not that the whole workflow passed. The activity icon shows
when new session events were last observed; hover for the detailed state.
The clock includes preparation and waiting. Quiet activity or an unavailable
check alone does not establish a hung model.

## 7. Promote and verify orchestration

Fetch `benchmark_workflow_campaign_report` after all first measurements settle.
Read each baseline comparison, observed quality, corrected significance result,
resource completeness and limitations. Exploratory intervals alone do not pass
the registered rule. If the assessment fails, preserve the report and keep the
existing routing order. Do not loosen the rule on the same exposed held-out set.

Only a passing, fully qualified campaign can be promoted through
`benchmark_promote_selector({ campaignId })`. Read back the certificate and
`benchmark_class_policies`. A fit marked `research_only` never grants dispatch.

The application has two relevant routing paths:

- **Ordinary chats and conductor waves:** the newest active certificate for a
  work class supplies its selector. It matches available provider/model/effort/
  speed choices to trained evidence. This class policy intentionally extends
  beyond the exact benchmark prompt, role and tools. It is not proof of the
  interactive runtime's isolation or quality on every task in that class.
- **Native certified workflows:** the deployment contract or exact trajectory
  binds step classes, roles, permissions, execution profile and budgets. A step
  outside that certified scope retains the prior order or explicit pin.

Configure the Routing preference order as a usable fallback. Explicit model pins
and bound session targets stay binding. No certificate, no compatible available
candidate, an ambiguous runtime match or failure to reach the predicted quality
floor causes abstention and a recorded fallback reason. Never silently replace
the requested account or reinterpret unknown interactive metadata as a verified
benchmark runtime.

Verify the real application path with an authorized task: inspect the work class,
candidate set, decision reason, certificate, chosen provider/model/effort and
the worker's actual acknowledgement. For a wave, inspect each step and its entry
state. Check explicit pins and fallback behavior too. A prediction preview alone
does not prove dispatch. Revoke a certificate through
`benchmark_revoke_promotion({ id, reason })`, then inspect
`benchmark_class_policies`: an older active certificate can become the class
policy. The class returns to its preference order when no active certificate
remains. Revocation preserves the research evidence.

## API and maintenance map

The named `benchmark_*` operations are native Tauri commands, not shell commands
or a promised public HTTP API. Inside the app, use the existing typed wrappers:

| Purpose | Source |
| --- | --- |
| Drafts, versions, runs, fits, workflow campaigns and reports | [benchmarkApi](../src/features/benchmarks/api/benchmarks.ts) |
| Qualification, deployment projection, registration and promotion | [benchmarkGovernanceApi](../src/features/benchmarks/api/benchmarkGovernance.ts) |
| Qualification and certificate request fields | [Governance types](../src/features/benchmarks/lib/benchmarkGovernance.ts) |
| Fit requests, artifacts and public-task projection | [Learning types](../src/features/benchmarks/lib/benchmarkLearning.ts) |
| Campaign requests and frozen plans | [Campaign types](../src/features/benchmarks/lib/workflowCampaign.ts) |
| Shared executor decisions | [Executor selection](../src/features/benchmarks/lib/executorSelection.ts) |
| Native command argument shapes | [Command handlers](../src-tauri/src/commands/benchmarks.rs) |

For example, application code reads the artifact after fitting rather than
treating the summary as a model:

```typescript
const summary = await benchmarkApi.fitSelector(reviewedTrainingRequest);
const artifact = await benchmarkApi.getSelectorFit(summary.id);
// Inspect artifact.snapshot and retain its provenance before evaluation.
```

`reviewedTrainingRequest` is an operator-prepared private request satisfying the
schema and gates above; it is not a bundled dataset. Do not add credentials,
actual task bodies, IDs or results to this example.

Keep a private run ledger containing immutable requests, version and runtime
hashes, qualifications, attempt IDs, fit snapshots, campaign rules, certificates
and revocations. Back it up with the same restrictions as the source data. On an
app or provider update, check affected capabilities and tests, then preserve old
evidence under its original revision. Never relabel old results as a new runtime.

Before Git publication, review staged contents and every outgoing commit,
including messages and generated artifacts. Keep private task assets, expected
answers, controls, model outputs, evaluation plans, logs and exports outside
every checkout. Ignore rules and local hooks are additional checks, not a
substitute for content review. Sending a private prompt to a model is a separate
disclosure governed by that account's actual data-use controls.

For implementation changes, follow [AGENTS.md](../AGENTS.md), run the affected
frontend and native checks, and verify the changed application path. Use invented
fixtures in source tests. See [authoring contracts](benchmark-authoring.md) for
browser assertions, rubric panels, immutable evidence and privacy rules.
