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

All benchmark candidates, model inventory probes, judges, repository checks,
JavaScript checks and browser rendering require the dedicated WSL distribution.
Ordinary chats keep their existing provider runtime. With WSL
available and no benchmark sessions running, provision the helpers from the same
checkout as the application, then verify them:

```powershell
node scripts/benchmark-sandbox.mjs
node scripts/benchmark-browser-ready.mjs
node scripts/benchmark-sandbox.mjs status
node scripts/benchmark-sandbox.mjs selftest
```

Provisioning installs dependencies and restarts that distribution. Schedule it
before measurement, not during a run. Sign in to the selected account through
`bench-login` inside the sandbox, following the command described at the top of
[the provisioning script](../scripts/benchmark-sandbox.mjs). Use the account ID
from the application and the provider's normal login flow. Never put credentials
in a task, command transcript intended for publication, or source file. A Z.ai
Coding Plan account has no login flow: **Copy key to benchmark sandbox** in
Settings > Benchmarks (the `benchmark_sandbox_sign_in` command) copies its saved
key into the sandbox on the helper's standard input (see
[Z.ai Coding Plan](zai.md#benchmarks)). Z.ai sessions reach only the Z.ai API.

For an existing distribution, update helpers without downloading dependencies
or restarting other WSL distributions:

```powershell
node scripts/benchmark-sandbox.mjs deploy-helpers
node scripts/benchmark-browser-ready.mjs
node scripts/benchmark-linux-text-policy-probe.mjs codex
node scripts/benchmark-linux-text-policy-probe.mjs claude
node scripts/benchmark-linux-text-policy-probe.mjs grok
node scripts/benchmark-linux-text-policy-probe.mjs kimi
node scripts/benchmark-linux-text-policy-probe.mjs zai
```

To add or update one provider tool in an existing distribution, for example
OpenCode for Z.ai, install only that tool. This downloads its pinned packages
and leaves helpers, users, the browser and other tools as they are:

```powershell
node scripts/benchmark-sandbox.mjs install-tool zai
```

Run qualification for the providers you use after installing their pinned Linux
tools. These explicit policy controls use synthetic credentials and local
loopback endpoints. They produce protected receipts bound to the Linux tools,
adapters and execution policy. Missing or changed receipts refuse benchmark
admission. Browser checks additionally require the pinned Linux renderer from
provisioning and its explicit readiness command. This command performs an
invented interaction and PNG capture under the real Chromium sandbox before
issuing its receipt. Kernel or confinement changes invalidate readiness.
Windows browser installations cannot satisfy this requirement.

Every owned execution has its own home and workspace, bounded mount, process,
network and IPC namespaces, and no access to Windows drives, personal skills or
ordinary chat configuration. The native-text profile still forbids tools;
placing it in Linux does not grant repository permissions. The controller only
stages declared task inputs and the selected provider's credential material.
Provider inference sends those inputs to its endpoint under the account's
existing data-use policy.

A repository attempt works in its own copy of the published snapshot, with a
pristine root-only base beside it from which its answer is read. Every check
gets its own copy too. Nothing unpacked is shared, but the archives they
unpack are cached: `/srv/bench/cache` keeps one read-only, root-only archive
per published tree, named by the tree's id, which no run can see (sessions,
checks and probes have `/srv/bench` hidden). An archive is kept only once
its files hold that tree, and each use checks the tree again; an entry that
fails the check, or that anyone but root could have changed, is removed and
counts as absent. While the cache directory itself is not root's alone
(mode 0700), nothing is read from it or kept in it, and every copy comes
from the sent archive. The controller asks the cache only for trees it found
there before since the application started; for any other tree, or when the
cache no longer has it, the controller archives the snapshot on Windows and
sends it, as every attempt did before, and the sandbox keeps it for the
attempts and checks after. A later workflow step
starts from its predecessor's archive instead. Entries unused for seven days
go, and beyond 256 MiB or 512 entries the least recently used go first; an
archive is kept only while 3 GiB of scratch stay free. Removing
`/srv/bench/cache` while no job runs is always safe.

Benchmark jobs share an 8 GiB scratch filesystem with 131072 inodes. Every job
keeps its own memory, CPU, process and scratch I/O ceiling, and admission never
changes it; the aggregate is shared by measured use. The CPU weight decides
who gets a CPU first when jobs want more than there is:

| Job | Kind | Memory | CPUs | Processes | Scratch read/write | CPU weight |
| --- | --- | --- | --- | --- | --- | --- |
| Repository session | CPU-heavy attempt | 6 GiB | 2 | 768 | 128/32 MiB/s | 100 |
| Repository check | CPU-heavy, timed | 4 GiB | 2 | 512 | 128/32 MiB/s | 10000 |
| Paired check, split over its two halves | CPU-heavy, timed | 8 GiB | 2 | 768 | 128/32 MiB/s | 10000 |
| Browser check or rendering | CPU-heavy, timed | 2 GiB | 1 | 384 | 128/32 MiB/s | 10000 |
| Preparation | preparation | 2 GiB | 1 | 256 | 128/32 MiB/s | 300 |
| Text session | light attempt | 2 GiB | 1 | 256 | 32/8 MiB/s | 100 |
| Sign-in or model probe | light | 2 GiB | 1 | 256 | 32/8 MiB/s | 100 |

Admission is dynamic (policy dynamic-v2): no number of lanes is fixed. The next
job starts while what the sandbox measures leaves room for it, and waits,
naming the line that holds it, while it does not:

- Memory. Every admitted job claims the larger of what its process tree uses
  now and what jobs of its kind needed before: the 95th percentile of their
  recorded peaks plus a quarter, never above the ceiling and, until eight are
  recorded, the ceiling itself, except a repository session, which claims
  3 GiB (half its ceiling) until then, so a wave starts at full parallelism,
  and a check, which claims 1 GiB (a quarter of its ceiling): checks follow
  repository sessions only, so they can stay unlearned for a long time.
  The claims and the new job's must fit 23 GiB, and an attempt must also leave
  room for one check and one preparation. No attempt starts while the jobs'
  anonymous, shared and kernel memory exceeds 70 % of those 23 GiB or the
  guest's memory pressure over ten seconds exceeds a tenth; page cache, which
  grows over a wave and is reclaimed first, does not count. Learned peaks
  persist across deploys.
- CPU. A repository session spends most of its time waiting for the remote
  model, so it is admitted by what the sandbox measures: the CPUs the jobs used
  over the last seconds, a burst allowance for every running session and the
  new one, the ceilings of the running timed jobs (checks, paired checks,
  browser runs) and one check's two CPUs must fit the guest's logical CPUs
  less what the host runs outside the VM and one CPU for the supervisors.
  Outside is the host's busy CPUs less the work of the whole guest
  (`/proc/stat`), so the VM's own work for the jobs is not counted twice;
  the pressure and stall guards below see what it takes from them. The allowance is half a core until eight sessions finished,
  then the 95th percentile of their average use, between a quarter core and
  the session's ceiling. New sessions also wait while the guest's CPU pressure
  over ten seconds exceeds a tenth or recent checks spent more than a tenth of
  their time waiting for a CPU, and at most eight run at once. A timed job
  starts while its ceiling, the other timed jobs' ceilings and the sessions'
  allowances fit the same CPUs; with its CPU weight it takes a CPU before any
  session that bursts beside it. The ceiling rule of earlier builds still
  admits whatever it admitted: every CPU-heavy job by its ceiling within the
  physical cores (half the guest's CPUs) less the host's own use, an attempt
  leaving one check's two CPUs, the line dropping by one check while checks
  waited for CPUs. Light jobs and preparations need the jobs' measured load
  plus the host's load outside the VM below three quarters of the guest's
  CPUs and, where Linux reports it, CPU pressure below a quarter. CPU pressure
  and check stalls count only the time a job's tasks waited for CPUs another
  job held, never its own `cpu.max` throttling (a check sees all the guest's
  CPUs and starts that many workers on its two); a check's recorded stall
  counts for fifteen minutes. The measured use the repository line adds to
  the running timed jobs' ceilings leaves out what those jobs use. The CPU pressure these lines read is the highest of the
  running jobs' own, never the supervisors' control group. Every finished job
  records its CPU seconds, average cores, memory peak and wall time;
  `bench-budget usage` lists the latest.
- Priority. A check or a preparation refused memory, and a timed job refused
  CPUs, keeps what it needs from new attempts for ten seconds after each
  refusal: an attempt starts only if it fits beside that room as well as its
  own check's, so neither starves behind attempts, and an attempt that leaves
  the room starts instead of waiting for the queue to empty. A refusal by the
  light-job line keeps nothing, since that line protects no other job's
  room. A check the operator's cap refuses takes the next place a session
  frees the same way. While a repository attempt waits for memory that the
  running text sessions claim, a new text attempt starts only beside that
  room, so the smaller text claims cannot keep refilling it; and once
  repository peaks are learned, a text attempt leaves room for one more
  repository claim while a repository job ran in the last five minutes.
  A later step of a workflow whose earlier steps a provider already worked on
  goes ahead of new attempts like a check: no kept room, CPU pressure or
  check-stall guard or session cap holds it, only its ceilings, the memory
  claims and guard, the CPU lines and the Windows floors; when it is refused
  room, new attempts leave that room for it.
- Scratch. The filesystem's free space must cover the new job's scratch
  reservation (1 GiB and 16384 inodes for a repository session), half a GiB,
  and the reservations of jobs admitted in the last two minutes; an older
  job's use already shows in the free space. A job that
  fills the scratch while it runs ends as unscored infrastructure failure.
- Windows and the guest. The controller preserves at least 12 GiB of Windows
  available memory, 8 GiB of commit headroom and 30 GiB free on the registered
  sandbox volume, and 2 GiB free in the WSL guest. Each memory floor must also
  cover the claims of earlier jobs not yet in use. Commit headroom is the commit
  limit (physical memory plus page file) minus committed memory; with a small
  page file it can keep a job waiting even when the sandbox has room, and the
  wait names that cause. A larger page file raises the commit limit without
  lowering the RAM floor. Admission evidence also carries how busy the host's
  CPUs were over the last second.

The Windows evidence each admission needs (`DISTILL_BENCH_HOST_GATE`) has five
comma-separated integers: the time in milliseconds, available RAM, commit
headroom and the sandbox volume's free space in bytes, and how busy all
logical CPUs were in thousandths. The application samples the last field once
a second. Operator scripts that do not sample it send 1001, meaning unknown;
admission then counts no host load outside the sandbox, as for an idle host.
Evidence with four fields, from scripts written for earlier builds, is refused.
Evidence whose time is more than a minute from the sandbox clock is refused as
expired, naming the clock: WSL's clock can fall behind Windows after sleep
until it is resynchronised. Each admission records the evidence's age
(`hostGateAgeMs`), and `status` reports `budget clock-offset` (the sandbox
clock minus the evidence's time, the call's transport included).

All jobs share an aggregate of 24 GiB, 15 CPUs, 4224 processes and
1024/256 MiB/s of scratch I/O, of which trusted supervisors keep their own
CPU, 128 processes and one GiB. The host disk, Windows and other WSL
distributions are outside these limits; each attempt records the measurements
it was admitted under (see [Freeze and run](#4-freeze-and-run-the-measurement-matrix)).
Cleanup retains its own capacity. A finished job's control group whose
processes have not left a few seconds after the kill, exiting or stuck, is
left with its expired lease for the next cleanup, which then checks it once
without waiting, so a stuck process never holds other jobs' admission; a job
whose admission finds a control group busy for a moment returns to the queue
unstarted. A process sitting in the sandbox's root control group itself, which
keeps the job controllers from being enabled, fails admission with that
cause instead. No additional virtual machine is created per test.

The operator may cap CPU-heavy jobs at once (sessions and timed jobs
together), for example to six for the first wave on a new admission policy or
to one while CPU-sensitive planning labs run:

```powershell
node scripts/benchmark-sandbox.mjs heavy-cap 1
node scripts/benchmark-sandbox.mjs heavy-cap off
```

A cap applies to jobs admitted after it; running jobs finish. `status` reports
it as `budget heavy-cap`. It is not part of the sandbox runtime identity, so
changing it keeps selected inventories valid. The fixed heavy-lane setting of
earlier builds is no longer read.

Resource pressure keeps unstarted candidate work waiting. It does not consume a
model call or permit replay of an already submitted answer. Work that belongs
to a turn already sent waits for room as well: its answer's collection, a
later workflow step's workspace and the transitions between steps wait inside
their own native deadline, and a collection without one waits up to thirty
minutes. A later workflow step whose session the sandbox refuses asks again
every ten seconds on its root's seat, under every retry policy, while no more
than a quarter of its allowance has passed; on the wall-clock budget that time
comes off the step's own allowance. Past that quarter the refusal ends the
step, unscored. The first step of a workflow returns to the queue instead. A check's own time limit starts once it is admitted, so waiting for
room never shortens it. Only a deadline that passes while waiting ends the
attempt, as unscored infrastructure failure. Evaluator admission waits on the
captured answer; a runtime resource failure is inconclusive infrastructure
evidence, not a model score. The application does not change global
`.wslconfig` or the resources of other distributions.

Readiness reports the digest of every sandbox helper, pinned executable and
provider entrypoint, and the renderer status reports the digest of every
renderer file. Both read a file again only when its identity changed: its
resolved path, device, inode, size, modify and change times, owner, mode or
link count. The recorded digests live in a root-only directory under `/run`,
which empties at every WSL start; a damaged or unprotected record is read as
absent. One sandbox observation answers the readiness checks that follow it
within ten seconds, and checks that arrive while it runs share it. The receipt
sealed after each turn, and each step of a sign-in renewal, always observe the
sandbox again, so the checks after a renewal read the renewed grant; those that
ask while one such observation runs share the next one. Copying a Z.ai key into
the sandbox drops the shared observation. The supervisors' own CPU (status,
cleanup and admission work) is one CPU of its own, outside the jobs' share. A
watchdog in the sandbox reaps expired jobs and samples their CPU use every five
seconds. It records its pid with the process's start time, so a reused pid
never passes for it. A failed pass does not stop it; a minute of failed passes
does, and the next job, network or status call starts a fresh one. `status`
reports `budget reaper ok` or `down` and, for an hour, the last line of its
bounded log (`/run/distill-bench-budget/reaper.err`, UTC times). A state file
that a crash left half written is renamed `.unreadable` and logged instead of
failing every pass. The first admission after the distribution boots waits up
to thirty seconds while the boot's setup mounts the scratch disk.

Helper updates retain a backup of old helpers and any previous scratch tree.
They stop the running watchdog, which keeps the old helpers in memory, so the
setup that follows starts one with the new helpers.
Keep those local recovery copies until the update is verified. Runtime changes
require fresh inventory selection and compatible qualification. Linux renderer
identity includes installed browser libraries and fonts, so previous Windows
rendering results do not qualify the new renderer.

Before dispatch, verify sandbox readiness, the exact account's authentication,
quota and billing mode, and the provider/model/effort acknowledgement. Windows
and sandbox authentication are separate runtime checks even for the same
account. Refresh expiring credentials only after that account's active sessions
have drained. Choose a dispatch deadline that leaves a complete attempt budget
before a known authentication deadline.

Sandbox status reports redacted local credential health separately from its
runtime identity. Claude/Grok benchmark admission requires an OAuth
expiry that covers the complete attempt plus five minutes for cleanup, and checks again
before execution. Missing or invalid OAuth metadata refuses admission. A local
expiry does not prove remote acceptance or refreshability; non-expiring key
accounts make no expiry claim and retain their existing usage-policy checks.
Providers without an expiry adapter retain their existing account checks.

When an attempt ends, bench-auth saves a refreshed credential file back to its
account only when it can order it against the stored grant. What it cannot
settle (two refreshes it cannot order, an unreadable, linked or oversized
file) is kept in a conflict record under
`/var/lib/distill-bench/auth-conflicts/<account>/<provider>/<attempt>/`,
readable by root alone: `conflict.json` names each file and the reason, and
`evidence/` holds a refreshed grant itself while the account has fewer than 20
records. The stored grant stays, the attempt is still removed, and
`bench-status` (and so `node scripts/benchmark-sandbox.mjs status`) prints
`account-conflict <provider> <account> <count>`; the application logs it once
per count. Admission goes on with the stored grant. Inspect the records, keep
or sign in again as needed, then remove the account's conflict directory as
root. Should a save fail outright, bench-clean still removes the attempt but
keeps its credential copy in `/srv/bench/auth-unsaved/<attempt>/` (root only),
and `bench-status` prints `auth-unsaved <count>`, which the application logs
once per count; remove the copy once it is recovered.

A sign-in (`bench-login`) and the application's sandbox account service see
only the account home they name, writable, over an empty `/home` and a
read-only root, never another account's sign-in.

Distill renews a sandbox Grok sign-in itself when an attempt, judge turn or
model listing needs it to last longer than it does, or when it has expired.
Every session of the account runs on a private copy of that sign-in, so the
renewal waits until none of them is alive. Meanwhile the account's new tests
return to the queue ("Waits for a running Grok test") as unstarted
admissions, under every retry policy, while later steps of workflows already
running finish on the sign-in they were admitted with. A later step whose own
limit needs the renewal waits only under automatic retry; a run without it
stops for the operator. The renewal then starts
one short session on the account, admitted as a text session under the same
rules as every other job (a host build that keeps the measured load above the
light line defers it), whose Grok CLI begins with
`GROK_AUTH_EARLY_INVALIDATION_SECS` past the sign-in's remaining lifetime and
renews it before its model listing; no model is called. Stopping that session
saves the renewed grant to the account with bench-auth's rules for a
refreshed OAuth file. Admission then reads the renewed grant under the
unchanged rule. If the CLI does not renew it, the run stops with the reason,
and the account needs `bench-login` again. The Claude CLI renews a sign-in
only in its last five minutes and has no such setting, so a sandbox Claude
sign-in still needs `bench-login` once it no longer covers an attempt. Codex
and Kimi renew inside their own sessions and have no expiry check here.

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
| `source`, `license`, `environment.authoredBy` | Record provenance, permission to use the material, and which candidates wrote the task |
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
`eligible versions x configurations x repetitions`. A candidate's own tests
are planned too; a run admitted before that rule (no `authorPolicy`) leaves
them out. Workflow steps and rubric judges add calls; use
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
each account's pace and sixteen attempts across the app. An account's pace
starts at four turns at once. A rate-limit answer to a sent prompt (HTTP 429,
"rate limit", "too many requests", "overloaded") halves it, and so does a level
of concurrency whose turns stream clearly slower (below three quarters of the
tokens per second) than turns with fewer beside them. It grows by one per
stretch of clean turns, up to eight, and never sooner than ten minutes after it
last changed or was first used. Every configuration on the account shares its pace, so two runs of one
configuration at four reach eight together. Quota recovery imposes one turn
until a turn lands. The pace lives in the running app and starts again after a
restart. Sandbox admission (see [Prepare the runtime](#1-prepare-the-runtime))
can keep further attempts waiting. Inspect actual active attempts and the
reason for a lower count, not just the request value. An existing ordinary run
can be adjusted through `benchmark_set_run_parallelism`; record the amendment
and preserve its original attempt identities.

Parallelism counts turns. Once a text or repository turn's answer is sealed
and its sandbox removed, its objective check no longer holds the
configuration's slot or the account's: the next attempt prepares and runs
while the check finishes, as its own sandbox job whose CPU weight puts it
ahead of the sessions beside it. A configuration keeps at most as many such
checks waiting as its parallelism; past that, a finished turn keeps its slot
until its verdict. Planning labs, whose checks time planners on budgets of
seconds, and judged renderings keep their slot until the verdict; run planning
labs under `heavy-cap 1`, so nothing CPU-heavy runs beside their checks.

Each attempt records the conditions its candidate session was admitted under,
as `sandboxAdmission` on the attempt and in its sealed evidence: the admission
policy and any operator cap, the jobs already running by class, the memory
they claimed and the CPU ceilings of the CPU-heavy ones, what this job was
expected to need, the CPU line, the logical CPUs left for the jobs, the
repository sessions running and the burst allowance counted for each, which
rule admitted it (by ceilings or by measured use), the CPUs the sandbox used
over the last sampled seconds and the guest's CPU pressure, how long recent
checks waited for CPUs,
the sandbox's memory in use, the WSL guest's load averages, CPUs and free
memory, Windows available RAM and commit headroom, and Windows CPU use over the
last second. It describes the moment of admission; a job admitted later does
not change it. Each attempt also records, as `accountLoad`, how many turns its
account had in flight when it was admitted and the pace then, and, as
`phaseTimes`, when it opened its session (workspace ready), sent its prompt,
had its answer collected and sealed, and began its evaluation; with
`startedAt` and the evaluation's `createdAt` these split its preparation,
turn, collection and check. Attempts recorded
before these fields existed, and attempts recovered after an application
restart, do not have them. Compare speed across attempts admitted under
similar conditions (the policy, the rule, the sessions running and the
competing jobs), or stratify by them.

Benchmark turns do not draw on purchased Codex credits unless the owner sets
Credits benchmarks may spend in Settings > Benchmarks (`creditLimit` in
`benchmarks/settings.json`, empty for off). Without a limit, or once it is
reached, a test whose account's plan usage is spent waits for plan usage to
reset like any usage limit, and its waiting row says credits are not allowed.
Spending is measured from the balance Codex reports and kept in
`benchmarks/credit-spend.json`: every drop between two samples of an account
taken within 30 minutes counts, including other use of the account meanwhile,
and a purchase never offsets it. The limit stops new turns on credits; turns
already running finish, so spending can pass the limit by what they use. A
turn whose account runs out of plan usage while it runs may go on on credits
on the provider's side, whatever the setting. An attempt paid with credits, from its start or
from the point its plan usage ran out, records `creditUse` (account, whether
from the start, and the balance before and after) on the attempt, in its
sealed evidence and in exports. The balances include other turns on the
account at the same time.

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

Before starting or resuming v4, and before refilling its next batch, the host
checks exact inventory, account availability, supported task capabilities and
runtime readiness. A failed check pauses admission without creating new roots.
An older in-flight check cannot pause a newer operator resume. These checks do
not preselect future dependent steps or rewrite a frozen plan.

Saved v3 plans (`sha256-campaign-cell-reserved-workers-v3`) keep their pool
reservation: a root stays pending, without an execution clock or worker call,
until it can reserve all worker accounts and lanes its policy may select, and
holds them through its dependent steps. That reservation can leave a provider
idle while another provider executes the current step.

A family that any run already measured cannot be frozen into another
campaign, with one exception: the cells of a campaign that was cancelled, for
example after its runtime failed. The replacement plan records those campaigns
in `supersedes`, their first outcomes stay as recorded, and the new report is a
repeat measurement of exposed families, not an unseen-holdout claim.
Such a report retains its `supersedes` provenance and cannot promote a selector,
even if its numeric comparison passes the registered acceptance rule.

Saved concurrent v2 plans keep their original semantics: local slot contention
spends the root wall budget. Serial v1 plans retain their immediate busy outcome.
Installing a newer backend never rewrites a frozen campaign or its results.
Freeze and review the concurrency contract before preregistration, and check
that the installed backend supports it. No recipe changes accounts, replaces
an attempt or retries a provider call.

Record the runtime and competing load when interpreting speed; each step's
`sandboxAdmission` holds the load at its admission. Whole-workflow
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

For a new automatic chat, selection uses the accepted first message, attachments
and role snapshot before the queue acquires its dispatch target. Later draft
edits cannot change that accepted decision. An explicit model or settings choice,
including selecting the same value, pins the target; established conversations
keep their bound target. Foreground and background queue owners use the same
saved decision and native dispatch receipt.

Verify the real application path with an authorized task: inspect the work class,
candidate set, decision reason, certificate, chosen provider/model/effort and
the worker's actual acknowledgement. For a wave, inspect each step and its entry
state. Check explicit pins and fallback behavior too. A prediction preview alone
does not prove dispatch. Revoke a certificate through
`benchmark_revoke_promotion({ id, reason })`, then inspect
`benchmark_class_policies`: an older active certificate can become the class
policy. The class returns to its preference order when no active certificate
remains. Revocation preserves the research evidence.
Saved ordinary chat and wave decisions are checked against their original
certificate immediately before native provider handoff. A queued decision whose
certificate was revoked is refused; it is not silently reselected under another
certificate. Explicit pins remain independent of learned authority.

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

`benchmark_list_definitions` lists the catalog as summaries: each definition's
identity, archive state and draft revision, and for its draft and every version
the listed manifest facts (name, family, class, split, difficulty, limits,
evaluator kind and revision, workflow step scopes, authors, judge seats, split
group and generator family). It never carries prompts, fixtures, checks or the
rest of the environment, so its size does not grow with the tasks. Read one
test's contents with `benchmark_get_definition({ id })`, which returns its
draft and every published version, or one version with
`benchmark_get_version({ id })`.

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
