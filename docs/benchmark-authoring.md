# Benchmark authoring and application contracts

This document describes the generic benchmark workflow. Private task plans,
task content, qualification evidence and measurement reports are local data,
stored outside the application repository under the configured Distill root.
Detailed working plans belong in `benchmark-tasks/documentation`. Do not append
private task details or campaign results to this document.

For the complete setup, qualification, measurement, training and deployment
sequence, start with [Operating benchmarks and learned routing](benchmark-operations.md).

## Data ownership

The benchmark service owns definitions, immutable versions, runs, attempts,
evaluations and evidence. Its database and artifacts live under `benchmarks`
inside the configured application root. Private authoring assets live under
`benchmark-tasks` in that root, outside project checkouts. Local publication in
Bench development freezes a version in this store; it does not publish to GitHub.

Only the latest published version of an active definition accepts new runs,
previews and qualifications. Publishing a replacement retires earlier versions
from execution automatically; saving a draft does not. Historical versions,
run plans, outputs and evaluations remain available on their original identities.
Even an evaluator-only correction requires fresh measurements of the new version:
publication never transfers or rescales earlier results. An old run cannot be
resumed or extended after its test version retires. Already admitted work keeps
its original immutable inputs rather than switching tests mid-run.

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
branches still carry removed history, the pre-push hook refuses tags, deletions,
history rewrites and unreviewed ancestry. By default, outgoing commits must all
descend from the destination branch's published tip.

After reviewing a clean, already published base, store its full commit ID in the
local Git option `distill.privateBenchmarkReviewedBase`. This permits merges of
branches created from that base or later, without requiring each branch to start
from the latest remote tip. Every outgoing commit must descend from the reviewed
base, including commits merged from other branches. A shared ancestor alone is
not a review; do not automatically move the base backwards to make a push pass.
Existing branches must still fast-forward and contain that base on the server.
New branches require the base to be verified against live branch refs at the
actual push destination; missing local history or an unavailable destination
refuses publication. Remote-tracking refs alone do not establish publication.
Content review of staged files and outgoing commits remains required.

Clear the pending option only after the authorized history review. Hooks are
local safeguards and can be bypassed; they cannot retract remote copies.

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

- A descriptive name, a predefined type, difficulty and dataset split.
- The public prompt, permitted fixture files and required deliverable format.
- An execution profile: native text, isolated UI or protected repository.
- An objective evaluator or a versioned rubric with a calibrated judge protocol.
- Tool and network permissions, prerequisites, time and artifact bounds.
- Repetition count, dataset split, difficulty and other applicable facets.
- Author identities, role context and related-family grouping when applicable.

Every execution profile uses the dedicated Linux benchmark runtime. Profile
permissions remain authoritative: native text has no tools even though its
process is isolated, while protected repository grants only its declared tools
and network policy. Windows personal skills, home directories and ordinary chat
configuration are not task inputs. Declare every fixture the candidate needs.
JavaScript and browser evaluators use the pinned Linux renderer; changing its
installed identity requires new compatible qualification evidence. See
[runtime setup and resource limits](benchmark-operations.md#1-prepare-the-runtime).

`environment.authoredBy` is an array of exact author identities:

```json
{
  "authoredBy": [
    { "providerId": "example-provider", "modelId": "example-model", "effort": "xhigh" }
  ]
}
```

Only a candidate with the same provider, concrete model and reasoning effort
is an author of that test. Declared model aliases resolve to their concrete
target before comparison, and a context window variant names the same model
(`opus[1m]` is `opus`). Account, speed and execution profile are not part
of authorship. Use an explicit effort, or `null` only for a model without
reasoning control. Another effort of the same model is not an author.
Legacy string tags are provenance, not wildcard matches; convert them using
the original authoring evidence before publishing. Preserve unresolved tags
in `environment.legacyAuthoredBy` rather than guessing a model or effort.

An author's own test is planned, run, evaluated and stored like any other
cell and labeled as its own. Each analysis decides what the cell counts for:

- Quality, points and ranks on the boards, the design gallery, routing
  evidence, learned fits, held-out reports and workflow policies leave own
  cells out. An author cannot write a test that probes its own blind spots,
  and a rubric can favor the author's style.
- Speed and cost shares, each test's speed and cost record, and a row's
  duration and spend count own cells.
- A model's history compares the model with itself, so its points count the
  tests it wrote; the model page says so under the chart.
- An author never takes a judge seat on its own test.

`benchmark_get_home_advantage` reports, for each author identity, its quality,
speed and cost relative to the non-author candidates on the tests it wrote,
against the same relative measure on other authors' tests (recipe
`author-home-advantage-v1`). Only complete cells count, related tests are
resampled together as one group, and fewer than two independent groups on
either side give an estimate without an interval. Speed and cost compare as
logarithms of ratios, across admission bands. Use the report before deciding whether own cells may
enter quality or training; the defaults above do not change on their own.

The editor offers Training and Held-out evaluation. Development remains a
legacy data value for historical diagnostics, not a choice for new tests.
Optional files are added only when the task needs them. Imported source and
license metadata are preserved without adding fields to the authoring form.

Under Check, select text comparison, JSON comparison, manual review, a JavaScript
function, a web page or repository changes. Simple comparisons need an expected
answer; their sanity references and checker revision are generated automatically
when edited. Code and browser checks expose inputs, expected results, actions or
program arguments. Reference solutions verify the checker and stay hidden from
the model. Imported extra checker settings remain available under Advanced check
settings and are retained when editing individual fields.

Open Draft to make changes. Save draft preserves work; Create version freezes
the edited draft and retires its predecessor from new runs. Version tabs next to
the test title open its immutable history. The play button runs only the current
version of the open test; archived versions and unpublished drafts cannot run.

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

Browser specifications contain 1-200 `steps`, each with an `action` and a
`selector`. `fill` and `press` take a `value`; `click` needs no value.
`selectOption` selects a native select option by its exact string `value`, so
tests need not assume the option order. `expectText`, `expectValue` and
`expectCount` compare the observed text, input value and locator count.

Browser steps may set an integer `timeoutMs` from 1 to 5000. Actions use it as
their locator readiness budget and execute once; read-only assertions retry
native observations during that polling budget, followed by one final observation
if no match was found. An in-flight or final native read may finish after the
polling deadline; this is a settling allowance, not an exact timestamp check.
Each locator call uses the remaining budget, with a minimum of 1 ms for the
final observation. The outer evaluator limit still bounds the entire invocation. Without this option, actions retain their 1500 ms
default and assertions make one observation. Protected expected values and
retry decisions remain in the controller process.

The browser specification may set `timeoutSeconds` to an integer from 1 to 1200
for the entire evaluator invocation, including startup. The host validates this
before launch and caps it at the draft's time limit. Omitting it preserves the
existing limit of at most 60 seconds. Publish the action and aggregate budgets
in the task contract. `stopOnFailure: true` stops after recording the first
failed step; its default is false. Such negative results contain only the
executed prefix, while a passing result must complete every step.

`expectSize` takes `value: { width, height, tolerance? }` and compares one
element's rendered bounding box in CSS pixels, including borders and transforms.
Dimensions and tolerance must be finite nonnegative numbers; tolerance defaults
to 0.5 pixels per dimension. Missing, nonunique or unrendered elements fail.
The browser supplies the geometry, so equivalent CSS and attribute sizing are
accepted and page scripts cannot substitute a JavaScript geometry getter.

`expectBounds` takes `value: { x, y, width, height, relativeTo?, tolerance?, coordinateSpace? }`.
The default `coordinateSpace: "css"` compares one rendered bounding box in CSS pixels. Without `relativeTo`, x/y
are viewport coordinates. With a selector in `relativeTo`, they are offsets from
that element's rendered top-left corner; this does not invert its transforms.
Both selectors use native main-document CSS and must match exactly one rendered
element; Playwright selector extensions and shadow-root traversal are unsupported.
Coordinates must be finite numbers; dimensions and tolerance must also be nonnegative. Tolerance
defaults to 0.5 pixels per component. A fresh isolated browser world reads both
boxes synchronously from native layout, keeping relative coordinates coherent
during script and CSS animations. Equivalent SVG numeric spellings and translated
groups are accepted. Expected coordinates stay in the controller process.

With `coordinateSpace: "svg"`, the target must be an SVG `rect`, and `relativeTo`
must select an SVG `svg` viewport. Coordinates and tolerance are then in that
viewport's user coordinate system. The worker reads the native local `getBBox`
and both `getScreenCTM` matrices in the same isolated-world observation, inverts
the viewport matrix, and transforms the rectangle's four corners into that
coordinate system. All four corners must match the expected axis-aligned
rectangle, in any order, within the tolerance per coordinate. This accepts
equivalent local geometry, translated groups, axis-aligned reflections/rotations,
viewport borders/padding, and shared ancestor transforms; a skewed or rotated
rectangle with only a matching axis-aligned envelope does not pass. Both screen
matrices use the browser's native 2D SVG matrix interface and must be finite;
the viewport matrix must be invertible. This
checks the geometric rectangle, excluding stroke, clipping, and corner rounding;
it does not assert visibility, styling, or arbitrary SVG shape equivalence.

Accessibility checks read Chromium's accessibility tree outside candidate
JavaScript. `expectAccessibleName` requires a nonempty computed name, or compares
it exactly when a string `value` is supplied. `expectAccessibleDescription`
compares the computed description with its required string `value` (an empty
string checks that no description is present). Both require one element matched
by a CSS selector. `expectAccessibleError` requires a nonempty string `value`
and one CSS-matched control. It looks for that message in the computed
description or the accessible text of active `errormessage` relations, with
whitespace normalized and additional help text allowed. DOM descendants hidden
from accessibility do not count as error text. Use separate checks for visible
error text and invalid state when the public contract requires them. These
assertions accept equivalent markup without prescribing an attribute spelling
or the order of unrelated description nodes.

Error text alternatives use the pinned Playwright runtime in its isolated
utility world, restricted to Chromium's active error relations. The controller
checks the same control and active relations before and after readback. Native
reflection restricts the synchronous text computation to those live targets;
candidate scripts, pending timers and animation callbacks remain enabled.
ARIA element-reflection targets are resolved by browser node identity and do not
need element IDs. Temporary utility-world facades do not change the page's DOM.
Expected error text stays in the controller; it is never supplied to the page
or utility world. Runtime upgrades must rerun the worker's accessibility and
isolation regression tests because this readback uses a private Playwright API.

JavaScript checks require a callable `functionName` and 1-100 `argsCases`, each
with an `args` array and an explicit `expected` value. When the public contract
forbids input changes, set `immutableArgs` to the argument indices to preserve.
The worker checks those values independently of the returned result. Draft
validation rejects malformed cases and indices missing from any case before
publication starts reference execution.

Repository tasks use immutable public snapshots and an isolated workspace.
The workspace holds exactly the files of the snapshot's tree, so the tree must
survive `git archive` unchanged. `text` and `text=auto` keep committed line
endings; `export-ignore`, `eol=crlf` and `ident` would change the files, and
publication refuses a snapshot whose archive does not hold its tree.
Protected evaluator code and expected observations remain outside the candidate's
view. Where submitted code must run, the trusted checker and candidate process
communicate through the supported isolated probe boundary. Candidate stdout or
exit status alone must not forge the trusted verdict. Verify resource limits,
cancellation and cleanup as part of evaluator qualification.

A repository case whose check times what it checks (a planner on budgets of
seconds) sets `environment.timingSensitive: true`; planning-class cases are
treated so without it. Its check then runs with no new CPU-heavy job starting
beside it (see benchmark operations).

Without a frozen panel, a rendering's judges come from the judge pool: the
owner's list of models and efforts (`judgePool` in the benchmark settings
document, edited in Settings > Benchmarks), not a rule in code. A judge reads
private rubrics and the conditions a right answer meets, so a provider that may
train on submitted data never judges and is never calibrated (provider data
use, in benchmark operations). An entry takes seats only after it passed judge
calibration: alone, it judged every accepted and rejected control of the rubric
qualification records and scored each inside the record's bands
(`minimumAcceptedScore`, `maximumRejectedScore`); an invalid sheet or an
abstention is out of band. A visual rubric's controls are part of the
calibration of an entry whose provider is checked to see images (Claude). An
entry of another provider that judges visual rubrics is calibrated on them once
its text controls passed, and only that visual verdict decides its visual
seats: the accepted and rejected renderings with their bands are also the image
probe, since a judge that does not see the rendering cannot score both inside
them. A judge's account offers the models of its newest listing (a run's, an
inventory probe's or an earlier judge's, by the executable serving it now):
under an hour old it is not listed again, and up to twelve hours old it still
seats the judge when a refresh is refused, as the sandbox refuses a listing
under load. A rendering gets one calibrated judge per lab (Anthropic, OpenAI
and xAI, by provider), the roomiest account first (usage left in the windows
the model draws on, the last good read when the current one fails), up to three
(owner, 10-18, after BuseyBench's fixed three-lab ensemble): a judge of a
candidate's own lab, or the candidate's own model, may sit, its score diluted
by the other labs', and the rendering evaluation is marked `sameVendor` or
`ownModel` (aliases and context window variants resolved, so `opus[1m]` is
`opus`) so boards can show or leave out those scores. The exact configuration
that authored the case never judges it (provider, model and effort, as for
candidates): an author's lab with no other calibrated judge leaves the panel to
the other labs, and a panel with the model of an exact author at another effort
is marked `authorModel`. With fewer than two labs offered, more models of the
seated labs fill the panel to two (a visual rubric's Opus and Sonnet while no
other lab passed its visual calibration); with fewer than two judges a
rendering stays unjudged (pending review, with the panel's reason). Each seat
runs at its entry's effort, which its account must offer, and a judge turn has
ten minutes for its sheet (Grok 4.7 high takes two to three). The ordinary panel's
recipe (`three-lab-v1`) and the labs it seated enter its protocol and its hash,
so its scores never compare with earlier panels, and the hash names them
instead of the seated judges: the calibrated seats rotate by usage, so one
recipe, panel size and set of labs is one ruler. Calibrations count for their
own recipe (`strong-pool-v1`). A frozen panel names its own seats and is not
subject to this rule.

A text rubric's critical checks (`environment.criticalChecks`, policy
`critical-text-v1`) need from each judge a verdict and a reason for every
condition. A fail must quote the violation from the response. A pass may carry
no quote, since a condition the response meets by leaving something out has
nothing to quote, but a sheet that passes anything must quote the response
somewhere: passes without a single quote in the sheet are no verdict. Every
quote a judge gives must occur in the response, or the sheet is invalid.
Judges copy rendered text, so the comparison ignores case, white space,
Markdown emphasis and code marks, and typographic quotes and dashes, and an
ellipsis may join pieces of the response that occur in order; other or
reordered words are no quote. Each
judge evaluation records its quote-less passes (`quoteLessPasses`, split into
conditions that read as omissions and the others), and the app log names the
judge model, so their share can be watched. A failed condition scores that judge zero; an unknown one
makes it abstain. The judge instructions still ask for quotes on a pass, so the
judge protocol and its hash stayed the same when the parser began accepting a
pass without one, and when it began accepting quotes copied from the rendered
response.

Rubric tasks can freeze their judge seats in `environment.judgePanel`, with
`recipe: "frozen-native-panel-v1"` and a `judges` array of two or three complete
configurations. Each seat pins its account, model, effort, fast mode, billing
mode, native text profile and inventory revision. The rubric needs 1-32 distinct
criteria with finite positive weights. Authors and candidates cannot
occupy a seat. A null effort is allowed only when the model offers no effort
selection; it never means a moving default. Fast mode is always pinned off:
no benchmark candidate, judge or campaign lane may ask for it, and a session
that acknowledges no fast mode (a model without one, such as Sonnet) counts
as off. The runner checks current
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
active calibration turn. A control the local sandbox or busy judges refuse
before anything graded it waits and asks again; that refusal is no verdict.
Restart leaves a first qualification without a verdict interrupted, and the same
request resumes it: objective controls run again on the current evaluator, while
a calibration keeps its settled panels. Restart seals one whose open control
already asked a judge as failed without replaying it; unknown usage remains
unknown. These controls establish
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
and limits before starting a run. A run records its author rule as
`authorPolicy` at admission; a run admitted before own cells were measured
keeps leaving them out, including when it resumes or grows. Missing
measurements, infrastructure failures and unsupported configurations are explicit
states, not automatic failures or free execution. Preserve every planned outcome.

The leaderboard lists each combination of provider, model, effort and fast
mode once, and every row names its effort and fast mode: they are what a
selection chooses, so each is scored only from its own cells. Accounts,
execution profiles, billing and runtime revisions belong to its run evidence
and never create another row. An omitted effort is the default and an omitted
fast mode is off. A moving vendor alias retains the reported model generation.
The model page shows one score and history for that row across all its tests.
Each test contributes its newest scored cell, retaining one
run's configuration and repetitions together. Repeated tests count once,
infrastructure errors do not erase measured results, and scores are never
selected for being higher. Execution conditions remain in individual evidence.
Coverage labels count measured tests against the full eligible pool; hover
details separate passed, not passed and untested cases. Scores with incomplete
coverage are preliminary; untested cases are not failed cases. Speed and cost
percentages compare solved cases with their best measurements and are not test
pass rates. Speed compares a solved case with the fastest solve of that case
measured in the same recorded admission band: no CPU-heavy job beside it, one or
two, or three or more, by the most loaded of the cell's repetitions; a
repetition without a recorded admission (one measured before admissions were
recorded, or recovered after a restart) puts its cell in a band of its own. A
workflow takes its most loaded step's admission. A cell alone in its band sets
that band's record. Cost compares with every solve
of the case, and a solve that reported no spend at all sets no cost record.

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
identities and separately labeled outcomes. An author's own cell carries
`authoredByCandidate`, keeps `reward` empty and reports its measured score as
`authoredReward`; the training ledger keeps it masked and unowed. Protected
evaluator contents are not inference features. Held-out data requires explicit
export scope. Export files remain private local artifacts even when their schema
is documented publicly.

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
policy run as separate complete trajectories in the same campaign. Omitted
`parallelism` keeps legacy serial behavior and serialized identities. An explicit
bound from 1 to 12 is immutable; concurrent campaigns admit in frozen order,
refill collected slots and retain the shared provider/account limits. Steps
within each trajectory remain sequential. Reports collect in frozen order,
regardless of completion order. New v4 campaigns take each step's decided
worker when the step starts and give it back when it ends; waiting for that
slot is recorded and excluded from the whole-workflow clock. `accountSlots`
freezes the calls one account runs at once (1–8, default four). Saved v3
campaigns keep reserving every selectable worker account before the clock, and
saved v2 campaigns retain their original queue-inclusive timing. A campaign may
reuse the families of a cancelled campaign only; its plan then lists those
campaigns in `supersedes`, and its report is a repeat measurement rather than
an unseen-holdout claim.
See [campaign operations](benchmark-operations.md#6-preregister-a-held-out-workflow-comparison)
for reservation, pause and timing semantics.
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
bound over the registered policies. New concurrent step-admitted plans freeze
the `quality_weighted_relative_execution_elapsed_excluding_account_slot_wait_v1`
metric: whole workflow elapsed time minus validated persisted admitted-step
account-slot waits. Selection, orchestration, and interruptions remain included;
uncommitted waits are not subtracted. The first trajectory snapshot freezes raw
elapsed time, excluded wait, and execution elapsed time, also exposed in the
report's `timing` records. Invalid or missing timing prevents a new-contract
report; its first outcome is retained with a timing error. Existing plans,
including older v4 plans, retain raw wall-time utility, and saved reports are
never recalculated. Serial plans also retain their existing timing contract.
Cost remains the reported generation cost. Missing weighted resources prevent
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

For repository training intended to transfer to cumulative workflows, declare
`environment.nativeRepositoryRecipe = "repository-cumulative-v1"` together with
`environment.nativeBudgetRecipe = "native-root-wall-budget-v1"`. Individual
training tasks also require an explicit initial entry. The native runner creates
and persists the actual initial repository artifact and wall-budget lease before
dispatch; do not author either runtime record into a draft. Recovery uses that
saved context without renewing its budget. The declared recipe gives training
and frozen workflow steps the same public execution scope before those runtime
artifacts exist. Older manifests without this declaration retain their original
scope and collection behavior. A single class certificate still requires matching
roles, permissions and limits across its training tasks and workflow steps.

## Class selection in ordinary chats and waves

Once a work class has an active certificate, the newest one chooses for every
ordinary chat and wave of that class: its class model scores the available
candidates matching its trained provider, model, reasoning effort and speed
mode, and the selected one above the certificate's quality floor runs.
Interactive choices retain their own execution profile, billing information
and runtime revision, including unknown values. The benchmark runtime used as
evidence is not an attestation of the interactive session's isolation. Known
runtime conflicts and ambiguous evidence matches cannot select a worker.
This applies whatever the agent's
role, prompt or tools, so it reaches beyond the exact contract the campaign
evaluated. An explicit model pin or a bound session target stays binding. When
the class has no certificate, or its model abstains (no trained candidate is
available, or none reaches the floor), the preference order from Routing chooses
and the decision records why. Revoking a certificate exposes the next newest
active certificate, if one exists; with none, the class returns to that order.
`benchmark_class_policies` reports each class's certificate, or
the qualified training and held-out cases, fits and campaigns it still lacks;
Routing, the agent page and the chat hint show the same state.

## Learned selection recipe

New fits use a joint selection head trained against soft distributions of
measured candidate utility. Repeated rewards and the declared quality, speed
and cost weights determine those targets; masked observations are excluded,
not replaced with failures. Training gives related cases equal group weight.
Quality estimates remain separate and enforce the minimum quality floor.
The selector uses local public-task features and a linear selection head.
It does not train the candidate language models or evolve complete workflows.

The `family-weighted-softmax-kl-v1` recipe has its own immutable fit identity.
Existing `family-weighted-ridge-v1` fits keep their original predictions and
serialized form. A new fit requires its own evaluation and promotion; changing
the learning recipe does not activate a policy or reinterpret old campaign
results. Selection probabilities describe preference among available eligible
candidates, not calibrated probabilities of task success.

## Verification and maintenance

Follow `AGENTS.md` for source checks, tests and Windows runtime validation.
Exercise the affected path through the actual application when service or UI
behavior changes. Keep task-specific evidence and lifecycle checkpoints in the
private local store. Repository documentation should describe the application
contract and template rules, without identifying private tasks or disclosing
their solution mechanisms.
