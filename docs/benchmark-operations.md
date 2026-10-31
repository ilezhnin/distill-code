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

Build and start Flock using [Windows setup](windows-onboarding.md). From the
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

Chats and benchmarks use the same account model catalogue, including effort
levels and fast-mode support. Sandbox inventory observations only establish
execution readiness; they do not replace those model definitions. Claude's
models selected by opening a session with an explicit model name remain
selectable even when absent from the bridge's short model menu. Dispatch still
requires the runtime to acknowledge the exact requested model and options.

After a sandbox or CLI update, explicit Resume validates the same account,
model, profile, billing mode and options against the current catalogue. Only
unstarted work and fresh replacements adopt the installed runtime revision.
Sealed answers return to judging without being generated again, and completed
measurements retain their original evidence. Research workflows and runs that
forbid retries keep their frozen conditions. An unavailable selection stops
continuation instead of substituting another model.

Run cards distinguish queued judges from accepted judge calls. Resource waits
have their own clock; stopped queues do not animate. Accepted calls that are
still finishing retain their execution clock when another test needs attention.

All benchmark candidates, model inventory probes, judges, repository checks,
JavaScript checks and browser rendering require the dedicated WSL distribution.
Ordinary chats keep their existing provider runtime.

The installed app sets this sandbox up itself; it needs neither a source
checkout nor a host Node installation. **Settings > Benchmarks > Benchmark
sandbox** says what stands between the computer and a sandbox the running
build accepts, and so does a run dialog whose readiness check fails, with a
button that opens the same setup. The app checks, in order:

| What it finds | What happens |
| --- | --- |
| WSL, or its Virtual Machine Platform, is not installed | **Install WSL** runs `wsl --install --no-distribution` after Windows asks for administrator permission |
| Windows restarts to finish enabling WSL | The operator restarts Windows and checks again |
| Virtualization is off in the firmware | The operator turns on Intel VT-x or AMD-V in the UEFI or BIOS settings |
| No `distill-bench` distribution | **Set up sandbox** installs Ubuntu 24.04 under `benchmarks/sandbox` in the Flock folder, or registers the disk a removed registration left there again |
| The sandbox differs from the build's pins | **Repair sandbox** updates the helpers without downloads when only they differ, and provisions in full otherwise |
| The test browser has no readiness receipt | Setup issues it from a real sandboxed launch, as `benchmark-browser-ready.mjs` does |
| Less than 30 GiB free on the sandbox's drive, or no free memory | The operator frees space or waits, then checks again |

Setup observes the sandbox again after each step and takes the next one,
until the sandbox is ready or only the operator can act. A step that did not
help gives way to a heavier one, and none runs twice without progress. When
started from a run dialog, setup also renews that provider's offline policy
check (below). Setup never removes a distribution or its data: provisioning
again keeps the sandbox's sign-ins. Provisioning restarts that distribution
only; other WSL distributions keep running. Schedule it before measurement,
not during a run.

Provisioning installs the runtime the build pins, whatever Ubuntu has
published since: [`runtime-sources.json`](../src-tauri/resources/benchmark-sandbox/runtime-sources.json)
names the exact Node.js and git builds whose executables
[`runtime-pins.json`](../src-tauri/resources/benchmark-sandbox/runtime-pins.json)
pins, from their publishers' permanent URLs, and provisioning checks each
download's SHA-256 before installing it. The provider tool versions come from
the same file and `acp-tools.lock.json`. Change a pin and its source together.

From a checkout, the development scripts do the same and verify it further:

```powershell
node scripts/benchmark-sandbox.mjs
node scripts/benchmark-browser-ready.mjs
node scripts/benchmark-sandbox.mjs status
node scripts/benchmark-sandbox.mjs selftest
``` Claude, Codex, Grok and Z.ai accounts
sign in once, in Flock (Settings > AI providers; Grok through its own CLI
sign-in): every sandbox session of theirs runs on a lease of that sign-in (see
below), so there is nothing to sign in inside the sandbox, and the Z.ai key
reaches it the same way (see [Z.ai Coding Plan](zai.md#benchmarks)). Z.ai
sessions reach only the Z.ai API. Kimi alone keeps its own sandbox sign-in,
made once per account. When a Kimi run dialog's readiness check fails because
the sandbox lacks that account's sign-in, the dialog says so and offers
**Sign in to Kimi Code** (the provider's name as Flock shows it). The app
samples the Windows headroom the sandbox admits work against and opens a
console window of its own running `bench-login kimi ACCOUNT-ID` with that
sample; a bare `wsl ... bench-login` carries none and is refused. Sign in
there with Kimi's normal flow: it prints a link or code to open in a browser
on Windows. The app never reads, writes or keeps what that window shows. When
the sign-in fails, the window stays open on the reason until a key is pressed.
Once the window closes, the app observes the sandbox again and, when the
account is signed in, checks availability again. One window per account is
open at a time, and the sandbox setup waits until none is, as provisioning
restarts the sandbox under a sign-in.

From a checkout, `node scripts/benchmark-sandbox.mjs login kimi ACCOUNT-ID`
does the same in your terminal (see the top of
[the provisioning script](../scripts/benchmark-sandbox.mjs)). Never put
credentials in a task, command transcript intended for publication, or source
file.

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
tools. When **Run benchmarks** or a model's run dialog reports an expired sandbox
check, choose **Update sandbox check** there. The app runs the bundled offline
suite for that provider, verifies the runtime before and after it, installs a
receipt only on success, and refreshes the model list and availability, keeping
the selected tests and run settings. It needs neither a source checkout nor a
host Node installation. Existing attempts and results stay intact; the operator
starts or continues the run separately. A failed check leaves dispatch blocked
and can be retried in the same dialog. This renews policy verification, not
missing sandbox tools or helpers: when the sandbox itself differs, the dialog
offers **Repair sandbox** (above), which renews this check as its last step.

These explicit policy controls use synthetic credentials and local
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

Every provider runs every split, train and held-out alike: a candidate
receives only the public task (prompt, role context, public fixtures and, for
a repository task, the snapshot), never the evaluator, an expected answer, a
protected check, a rubric or its own score. A judge reads the rubric and the
response, so a provider that may train on submitted data never judges. The
owner states each provider's data use in Settings > Benchmarks > Provider data
use (`providerDataUse` in the benchmark settings document,
`{"<providerId>": {"trainsOnSubmissions": true|false}}`); a provider it does not
name keeps its default: Anthropic, OpenAI and xAI, whose accounts the owner
confirmed (10-18), do not train, and every other native provider is assumed
to, Z.ai and Moonshot today. A settings document that cannot be read counts
every native provider as training. The judge pool, its calibrations and frozen
judge seats refuse such a judge. `benchmark_get_provider_data_use` lists what
holds for every native provider. Until 2026-10-19 such a provider received
`train` versions only; a cell that rule settled `excluded` unsent holds no
measurement, so its case is owed again.

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

Benchmark jobs share a scratch filesystem that starts at 8 GiB with 131072
inodes and grows online. When a job's scratch claim does not fit, the broker
grows the image by the shortfall in whole GiB, at least 4 GiB, with inodes in
proportion, while the Windows volume the sandbox lives on keeps 30 GiB (the
host gate's floor) and an 8 GiB margin free after it; it never shrinks
(`bench-status` reports `budget scratch-size`). A class's scratch claim is
learned like its memory: what its finished jobs wrote (allocated bytes and
inodes of their scratch directories), the 95th percentile plus a quarter once
eight are recorded, until then its initial claim (`budget scratch-claims`).
Every job keeps its own memory, CPU, process and scratch I/O ceiling, and
admission never changes it; the aggregate is shared by measured use. The CPU weight decides
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

Admission is dynamic (policy measured-load-v1): no number of lanes is fixed. The next
job starts while what the sandbox measures leaves room for it, and waits,
naming the line that holds it, while it does not:

- Memory. Every admitted job claims the larger of what its process tree uses
  now and what jobs of its kind needed before: the 95th percentile of their
  recorded peaks plus a quarter, never above the ceiling and, until eight are
  recorded (a job its own memory ceiling stopped records no peak, and a
  recorded peak at or above the ceiling is ignored), the ceiling itself,
  except a repository session, which claims 3 GiB (half its ceiling) until
  then, so a wave starts at full parallelism,
  and a check, which claims 1 GiB (a quarter of its ceiling): checks follow
  repository sessions only, so they can stay unlearned for a long time.
  The claims and the new job's must fit 23 GiB, and an attempt must also leave
  room for one check and one preparation. No attempt starts while the jobs'
  anonymous, shared and kernel memory exceeds 70 % of those 23 GiB or the
  guest's memory pressure over ten seconds exceeds a tenth; page cache, which
  grows over a wave and is reclaimed first, does not count. Learned peaks
  persist across deploys.
- CPU. CPU-heavy jobs (repository sessions, checks, paired checks, browser
  runs) start by the host's measured load, not by summed reservations (owner,
  10-18: cautious past 70 %, not around 40): while the Windows host's CPU busy
  share, the mean of the gate samples of the last thirty seconds, stays below
  70 %, the jobs' CPU pressure and recent check stalls stay at or under a
  tenth (for new repository sessions), and fewer than three heavy jobs started
  in the last thirty seconds, so a burst of starts cannot overshoot before the
  samples show their load. One busy second among quiet ones does not hold a
  start. Every job keeps its own CPU ceiling (two CPUs a session), and with
  its CPU weight a timed job takes a CPU before any session beside it. A
  timing-sensitive check starts only when the measured load, with the jobs
  started in the last thirty seconds at their ceilings, leaves its whole
  ceiling free, and no other heavy job starts while it runs. Without a gate
  sample in the window the rule of earlier builds decides: the sessions'
  measured use and burst allowance, the timed jobs' ceilings and one check's
  two CPUs within the logical CPUs the host leaves, or every heavy job by its
  ceiling within the physical cores. Every admission decision, admitted or
  refused, is appended with what it measured (smoothed host load, the line,
  the new heavy jobs, pressure, stall, memory claims) to `decisions.jsonl` in
  the broker's state, its newest 2000 kept. More load slows checks: a check
  past its time limit is stopped by the broker's deadline as the
  infrastructure's and runs again; a paired check that bench-judge stops at
  its own limit (which it marks, so a checker's own exit 124 stays the
  candidate's fail) stays the candidate's fail unless its leaves waited for
  CPUs other jobs held more than a tenth of its run, which makes it the
  infrastructure's too. Light jobs and preparations need the jobs' measured
  load plus the host's load outside the VM to leave their own CPU ceiling and
  one supervisor CPU free, with measured CPU pressure below a quarter. CPU pressure
  and check stalls count only the time a job's tasks waited for CPUs another
  job held, never its own `cpu.max` throttling (a check sees all the guest's
  CPUs and starts that many workers on its two); a check's recorded stall
  counts for fifteen minutes. The measured use the repository line adds to the
  running timed jobs' ceilings leaves out what those jobs use. The CPU
  pressure these lines read is the highest of the running jobs' own, never the
  supervisors' control group. Every finished job records its CPU seconds,
  average cores, memory peak and wall time; `bench-budget usage` lists the
  latest.
- Priority. A check or a preparation refused memory, and a timed job refused
  CPUs, keeps what it needs from new attempts for ten seconds after each
  refusal: an attempt starts only if it fits beside that room as well as its
  own check's, so neither starves behind attempts, and an attempt that leaves
  the room starts instead of waiting for the queue to empty. Under the
  measured-load rule there is no CPU room to fit beside: a timed job refused
  CPUs holds every new attempt until it starts, checks first, which at a
  wave's start can pause session starts for up to the thirty seconds the ramp
  holds the check. A refusal by the light-job line keeps nothing, since that
  line protects no other job's room. A check the operator's cap refuses takes
  the next place a session frees the same way. While a repository attempt
  waits for memory that the running text sessions claim, a new text attempt
  starts only beside that room, so the smaller text claims cannot keep
  refilling it; and once repository peaks are learned, a text attempt leaves
  room for one more repository claim while a repository job ran in the last
  five minutes. A later step of a workflow whose earlier steps a provider
  already worked on goes ahead of new attempts like a check: no kept room, CPU
  pressure or check-stall guard holds it, only its ceilings, the memory claims
  and guard, the CPU lines and the Windows floors; when it is refused room,
  new attempts leave that room for it.
- Scratch. The filesystem's free space must cover the new job's scratch
  reservation (1 GiB and 16384 inodes for a repository session), half a GiB,
  and the reservations of jobs admitted in the last two minutes; an older
  job's use already shows in the free space. A job that
  fills the scratch while it runs ends as unscored infrastructure failure.
- Own memory ceilings. A check, a paired check, or a browser run whose
  candidate page started that its own memory ceiling stopped (the leaf's
  `memory.events.local` counts the oom; pressure from above the leaf is the
  infrastructure's) is the candidate's answer past its budget,
  `budget_reached`, scored 0. A session's leaf holds the agent CLI and the
  commands it runs, and the group kill takes the bridge with it: the broker
  keeps the leaf's processes from its last one-second poll and reads the
  kernel's OOM record (`/dev/kmsg`) for the victim. The record's pid is the
  kernel's and every WSL distro has its own pid namespace, so the victim is
  matched by its name: when every process of that name in the last poll ran
  below a shell under the agent CLI, the broker keeps a verdict by the
  session's job id (`bench-budget verdict ID`, for two days), and the attempt
  the bridge's exit ended as an infrastructure failure settles
  `budget_reached` instead, the verdict sealed in its evidence. The agent CLI
  itself, its other children, the confinement, a name the agent's own process
  shares, a victim the last poll did not see, or no kernel record stay the
  infrastructure's. The app logs `sandbox job session-ID = attempt ATTEMPT
  (PROFILE)` once per try, so a cgroup name maps to its attempt.
- Windows and the guest. The controller preserves at least 2 GiB of Windows
  available memory, 2 GiB of commit headroom and 30 GiB free on the registered
  sandbox volume, and 2 GiB free in the WSL guest. Each memory floor must also
  cover the claims of earlier jobs not yet in use. Commit headroom is the commit
  limit (physical memory plus page file) minus committed memory; with a small
  page file it can keep a job waiting even when the sandbox has room, and the
  wait names that cause. A larger page file raises the commit limit without
  lowering the RAM floor. Admission evidence also carries how busy the host's
  CPUs were over the last second.
  The Windows preflight checks these shared floors and its actual transport
  buffers; the broker adds measured job claims and outstanding reservations.
  Per-job memory ceilings are never charged as additional admission claims.
- Provider transport. Owned protocol frames are limited to 16 MiB and share
  bounded event queues. Stdout permits 128 MiB per minute; a long repository
  turn can continue streaming tool progress beyond 128 MiB in total. A burst
  over that window still stops with a transport-budget diagnostic.

No count bounds how many jobs run: as many run as the measured CPUs, memory
and pressure admit without errors in the sandbox, and as the providers take
without rate-limit answers. Jobs waiting for room ask the broker one ask per
resource class at a time, the others waiting in the app in turn for each ask
(so the broker still chooses among all of them): every ask
starts processes inside the distribution, and a burst of waiting renders
asking each second once exhausted its process budget (10-18). A render
refused room before it started cleans nothing. The only fixed amounts are safety margins,
fairness ceilings and starting points, never counts of jobs: the 2 GiB
available-RAM and commit floors on Windows, the 2 GiB guest-memory floor
and the 30 GiB sandbox-volume floor; each job's own ceilings by class (a
repository session two CPUs and 6 GiB, a text session one CPU and 2 GiB, a
check two CPUs), which keep measurements fair; the benchmark root's own
ceilings, `AGGREGATE_CPU` (14 CPUs) and its process budget (4096); the 3.5 GiB
each host preparation reserves against the Windows headroom; one check's two
CPUs that an attempt leaves free; an account's starting pace of four turns;
and a judge panel's size of three. `heavy-cap` is an emergency knob, off by
default, that no plan sets.

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
attempt, as unscored infrastructure failure. So does a wall budget that ran out
before the attempt's or step's own session started (a pause, the queue, a wait
for a local slot, setup that outlasted the deadline): no model time was
measured, so it is never a model's zero, and it settles rather than returning
to the queue. A standalone try that goes back to the queue takes its clock with
it, so its next try is timed from its own start; a quota limit hit mid-turn
discards the turn and its clock alike. A root-pinned workflow that goes back to
the queue with a paid prefix (a quota or account wait), or that a stopped app
left mid-trajectory, gets that time back: it is credited to its wall budget
from when it left flight, or from the service's last heartbeat, until its next
flight starts, in a hash-bound record that never changes once closed. Time in
flight is never credited, and campaign roots, which never continue
mid-trajectory, get no credit. Evaluator admission waits on the
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
sealed after each turn always observes the sandbox again; receipts that ask
while one such observation runs share the next one. The supervisors' own CPU (status,
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
quota and billing mode, and the provider/model/effort acknowledgement. A
sandbox session spends the account's one allowance under its Flock sign-in,
so dispatch reads the account's status in the app for it.

The Flock application is the only place an account signs in, and the only
process that refreshes a grant. A Claude, Codex, Grok or Z.ai benchmark session
runs on a lease of the app's own sign-in: once the broker reserved the session
and before it starts, the host reads the account's current grant (the Claude
or Codex home of the account, the user's Grok CLI sign-in, the Z.ai account's
saved key), reduces it to what a session runs on, with no refresh token, and
pipes it to `bench-auth stage ATTEMPT PROVIDER` on the helper's standard input,
never as an argument or in a log. The helper refuses a lease that carries a
refresh token under any name or is not the shape the host writes, writes each
file once, 0600 and the candidate's, into the attempt's private folder, and
never saves anything back: nothing in the sandbox can rotate a grant. The
account folder a session names (`/home/candidate/accounts/<account>/<provider>`)
only selects the provider and the egress; it holds no grant.
Grants these providers kept in the sandbox from before leases are used by
nothing; `bench-status` names each as `grant-left <provider> <account>` until
`node scripts/benchmark-sandbox.mjs retire-grants` (`bench-auth retire DAY`)
moves them to `/var/lib/distill-bench/retired-grants/<date>/`, root's alone. It
never deletes or overwrites; delete that folder once it is checked.

Admission requires the app's grant to cover the complete attempt, nine
minutes for its start and cleanup, the CLI's own renewal window (Claude: its
last five minutes; Grok: the window its chat bridge starts with) and two more
minutes, so a lease never runs while the app's own CLIs renew the grant. A
grant that falls short is
renewed on Windows first, in the account's own home: Claude through its pinned
CLI from the stored refresh token (the grant before it is kept until the CLI
left a longer one), Codex through its native account read with a refresh, Grok
through a short Grok process whose renewal window covers what is left of the
grant; no model is called. A renewal runs only while no lease of the account is
alive, so the account drains first: its new tests return to the queue as
unstarted admissions while later steps of workflows already running finish on
the grant they were admitted with. A renewal the provider refuses keeps the
grant and is not retried for the same grant for 15 minutes, nor does the
account drain for it meanwhile (tests the grant still covers go on); sign in
again in Settings > AI providers. Thirty seconds after the app starts and every five
minutes after that, the app also renews each Claude, Codex and Grok sign-in
that would otherwise reach its CLI's own window within 30 minutes, whether or
not anything runs, so a quiet night never ends with an expired sign-in; the
first pass also settles a Claude renewal a stopped app cut short. A renewal
runs as its own task: a stopped run or a closed listing never cuts a token
exchange in half, and a CLI that is slow gets a further minute before it is
stopped (a stopped exchange is logged, since it may cost one sign-in).

A forced renewal rotates the refresh token. Whether each pinned CLI (Claude,
Codex app-server, Grok 1.0.40) reads its credential store again before it
refreshes, instead of replaying the token it loaded, has not been verified.
So Flock renews by force only while nothing else may hold the token: no chat
of the account runs in the app, no `grok.exe` runs for Grok (the user's Grok
sign-in is shared), and no `codex.exe` runs for Codex (which home a Codex
process uses is not visible). Until then a test the grant still covers goes
on, and one it does not waits ("renewed once the chats and CLIs running on
that account stop"). A renewal in the CLI's own window is the refresh every
CLI of the account makes anyway and is not held back. Codex refreshes a grant
by itself once it is eight days old, so a Codex lease must end before that as
before the access token's own expiry.

A Grok lease covers at most one hour of a turn, as Grok sign-ins did before
leases: a Grok turn that runs longer than its lease ends with it, unscored,
and is run again. That keeps a six-hour Grok grant open to new tests for most
of its life at the 4 h default limit, where covering whole turns would admit
new tests only in the first ~47 minutes and drain the account the rest. A run
whose time limit no fresh grant of a provider covers (Claude about 7 h 45 min
on an 8 h grant) is refused when it is created; a forced renewal never runs
for a test it could not admit.


Kimi keeps its own sandbox-only sign-in (**Sign in to Kimi Code** in its run
dialog, or `node scripts/benchmark-sandbox.mjs login kimi ACCOUNT-ID` from a
checkout), never a copy of the user's Kimi home. A Kimi session
gets a private copy of it, and when the attempt ends bench-auth saves a
refreshed credential file back only when it can order it against the stored
grant. What it cannot settle (two refreshes it cannot order, an unreadable,
linked or oversized file) is kept in a conflict record under
`/var/lib/distill-bench/auth-conflicts/<account>/kimi/<attempt>/`, readable by
root alone: `conflict.json` names each file and the reason, and `evidence/`
holds a refreshed grant itself while the account has fewer than 20 records.
The stored grant stays, the attempt is still removed, and `bench-status` (and so
`node scripts/benchmark-sandbox.mjs status`) prints
`account-conflict kimi <account> <count>`; the application logs it once per
count. Inspect the records, keep or sign in again as needed, then remove the
account's conflict directory as root. Should a save fail outright, bench-clean
still removes the attempt but keeps its credential copy in
`/srv/bench/auth-unsaved/<attempt>/` (root only), and `bench-status` prints
`auth-unsaved <count>`, which the application logs once per count; remove the
copy once it is recovered.

A Kimi sign-in (`bench-login kimi`) sees only the account home it names,
writable, over an empty `/home` and a read-only root, never another account's
sign-in.

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

Local admission refusals wait with backoff while a control has not asked a
judge. A saved rendering alone does not spend the qualification. After thirty
minutes of admission refusals, qualification becomes interrupted and requires
the same request to resume; revocation stops the wait. A judge result or
in-flight placeholder prevents automatic replay, preserving the first result
and any uncertain usage.

Finite controls establish agreement on reviewed examples. Independently assess
coverage, verifier isolation and task usefulness before paying for model runs.

The same rubric controls calibrate the ordinary judges. `benchmark_judge_pool`
returns the pool from the benchmark settings (`judgePool`: `providerId`,
`modelId`, `effort`, optional `inputs`, optional `accounts`), each entry with
its newest calibration and whether it takes seats, plus every stored
calibration. `accounts` lists the account ids an entry may sit on, for seats
and calibration alike, to steer seats off a shared login; without it any
enabled account of the provider may take the seat. Settings keeps the list as
written; edit it in `benchmarks/settings.json`.
`benchmark_calibrate_judge` with one such `entry` starts a calibration in the
background: the roomiest allowed account offering that model and effort judges
each control alone, under the ordinary protocol, and the calibration fails at
the first control outside its band. It costs one judge call per control. Only a
pool entry is calibrated, and never one of a provider that may train on
submitted data (see the provider data use above). Calibrations live in
`judge-calibrations.json` beside the benchmark database; one cut off by a
restart, worker failure or a judge that gave no answer at all (a spent quota,
an unavailable sandbox, a failed bridge, judges busy for half an hour), reads
as interrupted. An interrupted visual probe preserves its passed text controls
and grants no visual seats; an actually scored control outside its band still
fails the probe. Settings >
Benchmarks shows the pool and starts calibrations too. After the pool changes
the panel, rescore ordinary rubric attempts so every candidate is judged by the
pool's recipe; their outputs are reused.

## 4. Freeze and run the measurement matrix

In **Run benchmarks**, choosing an available model, account and effort includes
that model in the plan immediately. Each model appears once; every selected test
uses the model's runtime for that task automatically, including repository tasks.
The operator does not choose execution profiles or add a model twice to cover
the full pool. A missing runtime or incompatible setting blocks the plan with a
reason instead of silently leaving out tests. **Add another configuration** keeps
the model and settings while opening the picker for another choice. The execution
ceiling follows the selected tests and repetitions until edited; an explicit ceiling
stays fixed, and an over-budget plan explains how to proceed beside the action
buttons. Counts pair tests with their execution profile and include judge calls.
The explicit execution ceiling applies to both admission and judging; there is
no additional 1000-execution cap that prevents a full pool from fitting one run.
Check the plan before starting; changing any run parameter invalidates that check.

Select immutable versions and complete live `Configuration` records. Freeze
model, account, effort, fast mode, billing, execution profile, runtime revision,
repetitions and limits. Preserve these original configuration IDs for subsequent
workflow campaigns; the fitting service normalizes evidence keys separately.

For objective single-step tasks, the planned candidate count is
`eligible versions x selected models x repetitions`. Each model's internal runtime
configurations cover their matching tests without multiplying the cases. A
candidate's own tests are planned too; a run admitted before that rule (no `authorPolicy`) leaves
them out. Workflow steps and rubric judges add calls; use
`benchmark_preview_run` and its `executionCount` instead of relying on the simple
formula. Qualification-control counts, candidate calls and judge calls are
different quantities and should be reported separately.

Set the research run's `executionLimits.retryPolicy` to `none`. Such a run still
waits out a usage limit: a turn the limit refused, or stopped before anything of
it was evaluated, is discarded, and the same attempt goes again on the same
account after the reset, never on another account. A try the limit refuses
again before any answer waits again, so only one answer is ever measured. A
limit no reset lifts (billing, an account on hold, no credit) settles the
attempt as it ended, and so does a turn the runner had already stopped itself.
A limit that names no reset (Claude's stop mid-answer says only "resets 7pm")
waits until the reset the account's last usage read shows (a weekly window
read spent makes it a reset the run cannot wait for, so the run stops for the
operator), or asks again every five minutes where the read shows none. A judge whose turn a limit refused or
cut off leaves the run's panels until that reset.
A persisted queue wait survives ticks and application restarts without
claiming an account seat or preparation slot; eligible candidates and judge
panels can continue while another account waits. Explicitly resuming a stopped
run rechecks quota and sign-in availability, while resource and transient-error
backoffs and dispatch admission deadlines remain in force. A judge's quota
refusal releases its preparation slot and panel lane. An ordinary run retains
the refusal and selects an eligible replacement for the unfilled seat.
Grok Build's HTTP 402 with an exhausted usage balance is a quota refusal;
an unexplained payment status alone is not.

Candidate dispatch checks CLI-owned sign-ins, including Kimi and Grok, against
the same account usage snapshot shown in the status bar. A spent allowance
parks the attempt before sending its prompt, even if the provider would still
accept requests. Running requests finish normally. The run summary exposes
the quota wait and whether the queue will resume automatically; a stopped run
instead asks the operator to resume after the reset.

When quota is already known before a judge starts, the saved answer and any
completed votes wait for the reset without creating an abstention or repeating
candidate generation. An unknown reset is checked again after five minutes.
An ordinary panel waits only when eligible judges on limited accounts could
complete it; enough available judges proceed immediately. Qualification and
preregistered workflow panels keep their exact seats and binding checks. These
waits release execution and preparation capacity so other candidates and panels
can continue.

If a judge session does not acknowledge its requested model, effort or fast
mode before any scoring prompt is dispatched, setup retries that exact seat
at most twice. Each refused session is retained, a fresh session owner is used,
and any completed votes and the sealed candidate answer stay in the same batch.
Paid or uncertain requests and invalid score sheets are not retried by this
setup recovery. Frozen runtime mismatches stop qualification and preregistered
workflow panels, with a specific refusal instead of only missing scores.

Ordinary benchmark runs score the retained artifact with the current eligible
judge pool, even when the task declares a panel for its calibration. Changes to
a judge's account, model or runtime do not invalidate the candidate answer.
On recovery, completed votes keep their original attribution; only unfilled
seats rotate. A replacement batch references the same sealed rendering and
each reused vote, without repeating its provider call or counting usage twice.
The panel size and sample count stay within the existing run's reservation.
If one lab is unavailable, another distinct calibrated model from a remaining
lab may finish a saved panel. Completed votes need no free account or remaining
quota. Missing seats report their actual quota, busy-account or eligibility
condition rather than treating every shortage as busy judges.
Actual judge settings and runtime are recorded with new scores. These ordinary
panels do not inherit a frozen calibration's authority for research certification.

A workflow root under it settles with its quota outcome instead, since its
committed steps are never replayed. A try the provider refused before any
answer (another model acknowledged at session open, a busy account, a prompt
the host never dispatched) goes again as the same attempt on the same account
after five minutes; after three such tries the run waits for the operator, and
a runtime the host would not start waits for the operator at once. The cell is
never settled by such a refusal. An answer the provider's CLI cut off at its own
output-token maximum is the model's own: it settles as a budget failure scored
zero. Use at least
three repetitions for a complete leaderboard measurement. Set an explicit
`maxExecutions` and a realistic `timeoutSeconds`; if applicable, also set
`executionLimits.dispatchNotAfterMs`. Review a valid preview and resource budget
before `benchmark_start_run`. Save the exact request, request key, returned run
ID and planned attempt IDs privately before doing further work.

No fixed number bounds how many attempts fly. A new ordinary run records
`parallelism: 0`: as many attempts of a configuration at once as its account's
pace and the sandbox admit. An operator may set a number instead, of any size,
which then bounds the configuration; a saved run without one flies one at a
time. An account with no history starts at four turns at once, in slow start:
the level doubles after each clean round, as many clean turns as the level that
were admitted with every slot taken, so an account its demand keeps below its
level never grows. The first sign the provider limits the account ends slow
start: a rate-limit answer to a sent prompt (HTTP 429, "rate limit", "too many
requests", "overloaded") halves the level. A level of concurrency whose turns
together stream clearly less (below three quarters of the tokens per second in
all) than a lower level's turns together sends the pace below it, counting only
turns admitted while the host's CPU, averaged over the same 30 seconds and held
to the same 70 % line as the broker's load line, was below it (admissions from
before that mean was kept use their one-second sample), so our own load never
reads as the provider's slowdown. Each stream slowing as
more fly at once is no slowdown while the account streams more in all. Since
providers limit by model, the level a model's turns were refused at (two or
more) then stands for an hour as the most turns of that model the account flies
at once; a slowdown sets no such ceiling. After slow start the pace grows
by one per stretch of clean turns, with no fixed most, never sooner than ten
minutes after it last changed. Every configuration on the account shares its
pace, and the app log records every move ("account pace ... -> ... turns at
once, model ceiling ...") and every resume, so a wave's log shows how far each
account climbed. Quota recovery imposes one turn until a turn lands. Each
account's level, its last stable level (the one it last finished a clean round
at, or a refusal sent it to), when it last flew turns (to the minute, from the
moment a turn is admitted), whether it is still in slow start, and its standing
model ceilings are kept in `account-pace.json` beside the benchmark store, so an
app restart (a gap's deploy) resumes there: an account that flew turns within
the hour before the restart goes on at its level, in the same slow start, and
so does one idle for up to six hours whose stable level was last set by a clean
round, not by a refusal or slowdown (a gap's drain and deploy change nothing on
the provider's side); one idle for longer, or over the hour right after a
refusal or slowdown, resumes at half its stable level, in slow start again. The
file keeps when the provider last pushed back. A file written before activity
was kept dates the stable level instead, and one written before push-backs were
kept loses its model ceilings on restart, since slowdowns set some then. While the app
keeps running, the pace stays as it is however long the account was idle.

The app prepares only as many ordinary attempts at once as the sandbox's recent
answers allow: one plus the attempts the sandbox admitted in the last minute
since it last refused one. A wave start ramps up as fast as the sandbox admits
(the window doubles each round), and a full sandbox is asked by one attempt at
a time. Admitted attempts are not counted, nor is one that has prepared for
five minutes without the sandbox's answer (the log says so), so an attempt
waiting for something else cannot hold the window shut. Sandbox admission (see [Prepare the
runtime](#1-prepare-the-runtime)) decides the rest. Inspect actual active
attempts and the reason for a lower count, not just the request value. An
existing ordinary run can be adjusted through `benchmark_set_run_parallelism`
(0 for as many as admitted); record the amendment and preserve its original
attempt identities.

Parallelism counts turns. Once a text or repository turn's answer is sealed
and its sandbox removed, its objective check no longer holds the
configuration's slot or the account's: the next attempt prepares and runs
while the check finishes, as its own sandbox job whose CPU weight puts it
ahead of the sessions beside it. A configuration keeps at most as many such
checks waiting as its parallelism; past that, a finished turn keeps its slot
until its verdict. Planning labs, whose checks time planners on budgets of
seconds, and judged renderings keep their slot until the verdict. A
timing-sensitive check (every planning lab's, and any case whose definition
sets `environment.timingSensitive: true`) starts only while the measured use
leaves its whole two-CPU ceiling free, and one runs at a time: a second
waits for the first. While it runs it keeps that ceiling: another CPU-heavy
job (repository session, check, paired check or browser run) starts beside
it only while the measured host load, less the jobs too new to show in it
and less the held ceiling, still leaves the new job its own ceiling; the
hold ends with the check, at the latest at its own time limit. Its rule
counts the measured use beside the running timed jobs, plus those jobs and
the sessions too new to show in the samples at their ceilings (every ceiling
while there is no sample), and a timing check refused for its ceiling or
waiting for another keeps its CPUs from new attempts. Its evaluation records the
admission it started under (`details.admission`: the measured sandbox, guest
and outside CPU, the capacity and the competing jobs), so a planning result
can be audited later. `heavy-cap` is an emergency knob, off by default, that no
plan sets.

After a restart, receipt recovery and local checking run as managed flights,
one recovered attempt per store at a time. A slow recovered check does not stop
eligible candidates or judge panels from being dispatched. It retains its
sealed output, follows the same sandbox admission rules and responds to run
cancellation; a planning check still holds its configuration's seat. Recovery
never regenerates the candidate answer, and restoring an unfinished judge panel
continues to follow the run's retry policy and frozen panel evidence.

Each attempt records the conditions its candidate session was admitted under,
as `sandboxAdmission` on the attempt and in its sealed evidence: the admission
policy and any operator cap, the jobs already running by class, the memory
they claimed and the CPU ceilings of the CPU-heavy ones, what this job was
expected to need, the CPU line, the logical CPUs left for the jobs, the
repository sessions running and the burst allowance counted for each, which
rule admitted it (`load` by the host's measured load, or, without a host
sample, by ceilings or by measured use), the time of the host's evidence, the CPUs the sandbox used
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
restart, do not have them; a try that went back to the queue drops its phase
times, so they always describe the attempt's last try. Compare speed across attempts admitted under
similar conditions (the policy, the rule, the sessions running and the
competing jobs), or stratify by them.

Benchmark turns do not draw on purchased Codex credits unless the owner sets
Credits benchmarks may spend in Settings > Benchmarks (`creditLimit` in
`benchmarks/settings.json`, empty for off). Without a limit, or once it is
reached, a test whose account's plan usage is spent waits for plan usage to
reset like any usage limit, and its waiting row says credits are not allowed.
Spending is measured from the balance Codex reports and kept in
`benchmarks/credit-spend.json`: every drop between two samples of an account
taken within 30 minutes counts, including other use of the account meanwhile.
A turn's recorded before-sample and its completion stay in the same stretch
even when the turn lasts longer; overlapping completions count each drop only
once. A purchase never offsets spending. New credit admission requires a
successful balance sample from the last five minutes and a saved ledger update;
stale telemetry or a failed ledger write cannot authorize more credits.
Before dispatch, a durable `unsettledSince` marker preserves accounting across
a failed final read, failed write, cancellation or restart. The next successful
balance sample charges that outstanding interval before admitting more credits;
until then an old cached before-sample cannot authorize spending. Successful
settlement clears the marker once no other candidate turn is active.
The limit stops new turns on credits; turns
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

Benchmark chats live only while their attempt may still need them. Each turn,
candidate or judge, runs as a hidden chat. Once its attempt is final (terminal,
with an outcome a restart does not recover, no judge vote in flight and no
evaluation running), its chats are removed with their host records as its
worker ends. Chats that settle elsewhere go on start and every half hour:
qualification and calibration judges, model inventory probes, and the chats
earlier builds kept. A chat no stored attempt names stays for an hour after its
last turn. A measurement keeps the attempt in the benchmark store and its
sealed evidence: the answer, the turn's events, usage and the native receipt.
Scoring, judging, certification, promotion and exports read only those. Open
transcript replays a finished attempt's turn from the sealed record, read-only;
a running attempt opens its live chat. A judge's full reply is kept only when
it gave no valid score sheet; a valid vote keeps its scores, reasons and
critical checks. Application task chats are not benchmark chats and stay.

A model's leaderboard warning concerns its unmeasured cells in the current
rating pool, including terminal answers awaiting judges. A stopped run whose
remaining cases have since been measured or retired stays in run history,
without keeping a warning on the current model row or its detail page. Both
surfaces use the same current-pool and completed-cell selection.

The fully-tested date records when the model last covered its measurement
suite. Publishing a pool release whose cases already have complete cells
establishes coverage at the release time, without new model calls. A case
completed later moves the date to that completion. Historical queries ignore
releases made after their cutoff; attempt timestamps and scores are unchanged.

On an observer timeout, find the saved run ID or reconcile `benchmark_list_runs`
by request key. Do not start a replacement. Pause through `benchmark_pause_run`
and wait for active attempts to finish before an authorized app update or account
refresh. With retries disabled, resume only the same run's untouched pending
attempts; a failed, cancelled or ambiguous dispatched attempt is not a fresh slot.
Do not extend a frozen research matrix after seeing its results.

For a sealed answer awaiting judges, explicit resume keeps the valid votes of
one saved panel and asks only its missing or rejected seats. If several batches
exist, it continues the one with most valid votes, newest on a tie; votes never
cross batches. Rejected sheets and their usage stay recorded, and a repeated
judge call has its own request key. A malformed sheet stops that pass for
attention rather than starting an automatic retry loop. An individual judge
vote does not make the test complete: every repetition needs its full panel.
Sheet errors identify the failed validation without including private quotes.

A provider's HTTP 403 request rejection is retained as a judge failure, never
as a zero for the candidate. On Resume or Evaluate again, an ordinary panel
excludes the rejecting model and effort for that answer and scoring protocol,
including its other accounts. The service selects a fresh panel from the
currently eligible, calibrated pool and records the rejected evaluations and
the replacement panel's own protocol hash. During run recovery it reuses the
sealed artifact and references completed votes without reducing the panel size.
Older generic errors are recognized only from their matching terminal host dispatch,
which is gone once the attempt's chats are removed; such an error then counts
as an ordinary judge failure, and Evaluate again does not exclude that model.
Preregistered workflow panels and calibration controls never substitute a judge.
A missing replacement is reported explicitly; no paid retry loop is started.

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

A fit request may set `runtimeMatch: "model_identity"`. The default (`exact`)
counts only cells measured on each candidate's newest runtime revision. Runtime
revisions include the sandbox helpers and the native harness, so every deploy
starts a new one. Under `model_identity` a candidate is its leaderboard identity:
cells from every recorded runtime count, as on the boards, and each cell lists
the revisions it used. The column takes its configuration from the newest direct
attempt, never from an auxiliary call inside a repository workflow. A silent
vendor-side change inside one identity stays possible, so read the revision
lists. Prospective held-out reports still require the exact frozen runtime.

`benchmark_evaluate_class({ request: { workClassId, excludedProviders, personaOrder } })`
fits one class and evaluates the fit; `benchmark_class_evaluations({ workClassId })`
lists the class's journaled evaluations, newest first.

- **Fit (recipe `family-weighted-softmax-kl-v2-random-subsets`).** The class's
  largest public scope, training cells only, with `model_identity`.
  - Every candidate with at least eight complete training cases there joins the
    pool; a candidate that falls below eight once cases without a second pool
    candidate are dropped leaves it. Any `excludedProviders` are left out.
  - Candidates need not share cases: every training case that measured two pool
    candidates counts, and an unmeasured candidate is masked, never a zero.
  - The selection head learns from each case's full measured set and seven seeded
    random subsets of it (each candidate joins a subset with probability one half,
    at least two per subset; the seed mixes in the case's version id), so it
    chooses among whatever candidates a task has. A new model or effort joins at
    the next fit once it has eight training cases; it needs no new tasks.
  - The draw count, inclusion probability, seed and case bound are stored in the
    model and enter its id. The fit's cutoff is the newest counted training
    measurement, so unchanged training cells give the same fit.
  - A fit refuses any held-out version.
- **Evaluation (recipe `held-out-certification-v2`).** The fit is replayed on
  every held-out case of the class and scope that ordinary runs measured.
  - The certified pool is the fit's candidates measured on at least eight
    held-out groups. Only they are compared, and a certificate lets the policy
    choose only among them; the others join at a later look once measured.
  - A case counts when its version has a current, attested, unrevoked
    qualification and at least two pool candidates have complete cells under the
    single-run rule (3/3 in one run).
  - A cell is the newest run that scored the case, the same rule as the
    leaderboard. A newer run stopped part-way leaves its candidate absent on
    that case (never a zero) even when an older run is complete. The rule never
    looks at scores, but a run stopped for an outcome-related reason would still
    bias which cells count.
  - A renderer-bound version's cells must have been graded by its qualified
    renderer.
  - Every repetition of a frozen rubric cell must match its qualified judge
    protocol and evaluator revision. Human overrides and votes from another
    panel cannot certify a selector; invalid cells stay absent, never zero.
  - The learned arm chooses among the pool candidates the case measured; when
    it abstains it falls back as a chat does, to the persona arm, else to the
    aggregate arm.
  - The persona arm is what an ordinary chat of the class falls back to: the
    operator's class override, else the built-in ranking, with each entry's
    provider, words, effort and fast mode (`personaOrder`). Only candidates the
    order names count; on a case none of them measured the arm is absent.
  - The aggregate arm is the first measured candidate in the training aggregate
    order: candidates ranked by mean case-centred utility (a case's utility
    minus the mean over the candidates it measured) over their own training
    cases, each group weighted equally.
  - The fixed rule (`superiority-noninferiority-sign-holm-v1`, alpha 0.05, gain 0,
    quality floor 0.5, margin 0.05) compares each worker only on the groups that
    measured it. Each comparison needs at least eight groups, and Holm covers all
    of them.
- **Journal.** Every evaluation is a look in the journal, numbered per class,
  with its fit, recipe, rule and recipe parameters, the order as sent and the
  keys it resolved to, the pool, the qualification ids, and every counted
  repetition (attempt id and a hash of its evaluations). Repeating the class's
  newest look (same fit, same cells) returns it; after any other look it is
  journaled again. One transaction checks for the same look,
  numbers it, and writes the look and its certificate. A look runs on demand: once after each new fit
  (the command fits first) and again when the held-out cells change. No
  correction is made across looks; the look count is shown with the result.
- **Certificate.** A passing look issues the class certificate (`source:
  "held_out_certification"`). It is active only while its look is the class's
  newest: a later look that does not certify returns the class to its fallback
  order. Certificates from older or unknown evaluation recipes remain readable
  history but cannot authorize selection. Evaluate the class again under the
  current recipe to validate its saved measurements, without new model calls.
  The newest look of each class, passed or not, and the look count
  appear in `benchmark_class_policies` and in the class status in Settings.

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

Campaign requests may freeze `parallelism`, any number from 1. Omission retains the
legacy serial plan and hashes. This bounds admitted, unfinished whole workflows;
it does not multiply the execution budget or change dependencies within a workflow.
The concurrent scheduling recipe admits cells in their frozen order and refills
after collecting a first result, even if an earlier child is still running.
Provider, account and global worker limits still apply. A campaign may also
freeze `accountSlots`, the model calls one account runs at once for it, any
number from 1; omission keeps the shared default of four. The bound is part of the plan,
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
spends the root wall budget. A root whose budget runs out that way before its
next step's session started measured the host, not the model, and is sealed as
unscored infrastructure failure (10-18), so such a campaign has no report and a
replacement measures those cells. Serial v1 plans retain their immediate busy
outcome.
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

Ordinary model runs also show the current child of each admitted workflow,
including while a pause drains its dependent steps. The strip shows up to three
active workflows; the run drawer shows the remaining admitted workflows. This
view uses the same run-summary snapshot as the overall counts, with only step
identity, phase, clock and model metadata. It does not load full workflow traces
or change saved root evidence. Finishing the steps displays grading until the
root verdict settles. Paused runs do not display a historical child as active;
an unavailable summary refresh is reported as unavailable.

### Class certificates from held-out evaluations

A class is certified for ordinary chats and waves by a passing held-out
evaluation (`benchmark_evaluate_class`, above); there is no reservation, freeze
or single-use exam. Held-out cases are a permanent evaluation set:
- Ordinary runs measure them for every model, and the boards show them.
- A fit never reads them.

Overfitting is controlled by discipline:
- the fit and evaluation recipes are frozen and versioned;
- nothing is tuned on held-out results;
- every look is journaled with its data snapshot, so the number of looks is visible.

The certificate's authority is its journaled evaluation, its qualifications and
its fit:
- A revoked or changed qualification of a counted case deactivates it, and so
  do a changed fit and a newer look of the class.
- The renderer installed later plays no part: the evaluation already checked
  which renderer graded the counted cells.
- It never covers an owned native task: owned task mode, binding and dispatch
  refuse it, and owned deployments still need a workflow campaign certificate.
- Revocation works as for any certificate (`benchmark_revoke_promotion`).

Certificates and reservations of the retired executor holdout (`source:
"executor_holdout"`, `selector_holdouts`, `selector_holdout_reservations` and
`executor_holdout` rows of `evaluation_reservations`) are history only. They
never hold a case back from a suite, lane or run, and never authorize dispatch.

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
