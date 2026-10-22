# Documentation

Levocat Flock is documented in three layers: product and contract texts at the
repository root, guides in this folder, and the help the app installs for its
own agents under `distro/`. Start from the audience that fits you.

## I want to run it

| Guide | What it answers |
| --- | --- |
| [Windows setup](windows-onboarding.md) | Prerequisites, first bootstrap, running the dev app, building an installer, troubleshooting. |
| [Provider accounts](provider-accounts.md) | Connecting Claude Code, Codex, Grok, Kimi Code, Z.ai, Copilot and Amp; usage limits and automatic account switching. |
| [Z.ai Coding Plan](zai.md) | Running GLM models through the OpenCode harness, and how they take part in benchmarks. |
| [Data storage](flock-root-layout.md) | What lives in the Flock folder (`~/.flock` on new installs, `~/.distill` on installs upgraded from Distill) and in a project's `.distill/` folder, and how migrations keep older data. |

## I want to understand how the flock flies

| Guide | What it answers |
| --- | --- |
| [Waves: the conductor's contract](../LAWS/WAVES.md) | How a conductor plans steps, how executors report, and how a verdict closes a wave. |
| [Memory: the operator's record](../LAWS/MEMORY.md) | What an agent may remember on your behalf and what it may never delete. |
| [Model, effort and fast mode](model-effort-fast-selection.md) | How provider, model, effort and fast mode are selected and applied per harness. |
| [Operating benchmarks and learned routing](benchmark-operations.md) | Measuring models on your own tasks, fitting a selector, preregistering a held-out comparison, certifying a class of work. |
| [Benchmark authoring](benchmark-authoring.md) | Writing task definitions and evaluators, data ownership, isolation in the Linux sandbox. |

## I want to change it

| Guide | What it answers |
| --- | --- |
| [Contributor guide](../AGENTS.md) | Working rules, code map, validation gate, publication rules. |
| [Contributing](../CONTRIBUTING.md) | The short path from a clone to a pull request. |
| [Architectural laws](../LAWS/README.md) | Required product behavior that code and tests must follow. |
| [Product](../PRODUCT.md) | Purpose, users, personality and design principles. |
| [Design system](../DESIGN.md) | Tokens, typography and component rules of the app UI. |
| [Color token mapping](color-token-mapping.md) | Which semantic tokens to use, and which raw CSS consumers remain. |
| [flockctl architecture](flockctl-architecture.md) | The app command registry, its generated contracts and the safety model behind the CLI. |
| [Driving the running app](app-e2e.md) | Exercising the dev build from a script or an agent, locally or through the relay. |
| [Assistive UX](assistive-ux.md) | The pattern for discover, suggest and auto-apply moments in the UI. |

## Help the app ships to its agents

The app installs two public skills into the user's skills folder:
[flock-help](../distro/skills/flock-help/SKILL.md) answers questions about
the app itself, and [flock-monitor](../distro/skills/flock-monitor/SKILL.md)
runs long commands outside the current turn. See the
[distro notes](../distro/README.md) for what may and may not ship there.

## A note on names

Flock grew out of a project called Distill. The app, its tools, its
identifier, its bundled skills and its default data folder are Flock now: the
window title says Levocat Flock, the CLIs are `flockctl` and `flock-monitor`,
the application identifier is `com.levocat.flock`, the installed help skills
are `flock-help` and `flock-monitor`, and a new install keeps its data in
`~/.flock`. The guides use "Flock" for the product and "Distill" only for the
earlier name.

Some names stay Distill on purpose, because they are persisted in user data,
read by other programs, or live in a frozen area:

- the protocol fences `distill-wave`, `distill-report`, `distill-verdict`,
  `distill-memory` and `distill-recall`, and the `_meta.distill` and
  `_meta.distillHistory` event metadata;
- the persisted queued-message keys `distillctl_cross_session`,
  `distillSenderLabel` and `distillDeliveryId` (the UI renders them as "Sent
  by Flock from another session");
- the workspace-lifecycle owner value `"distill"`, the ACP client name
  `"distill"` and the Codex client name `"distill_accounts"` (the Codex client
  title is "Levocat Flock");
- each project's `.distill/` folder, and `~/.distill` on an install upgraded
  from Distill, which is adopted in place rather than moved;
- `flock-monitor`'s state on disk: its state folder
  (`%LOCALAPPDATA%\Distill\monitor`), the `DISTILL_MONITOR_*` variables, the
  pending-file header and the `distill-monitor-` delivery-id prefix, so
  monitors an older build started are still found and flushed;
- the benchmark sandbox (`distill-bench`, `DISTILL_BENCH_*` and its other
  variables) and the shipped SQL migrations;
- two more identities other systems key on: the `client-app/distill` token in
  the user agent of the Claude usage check, and `distill-managed-acp-install`,
  the package name of the managed ACP bridge install in `acp-tools.lock.json`
  and in every installed copy;
- the benchmark runtime identity, because every measurement records it: the
  native policy revisions (`distill-native-text-*`), the `distillNativePolicy`
  evidence key, the process policy names, the host-side adapters and probe
  records under `src-tauri/resources/benchmark-*`, the sandbox paths
  (`/opt/distill-browser`, `/opt/distill-tools`) and the Git identity of
  benchmark repositories.

For one release the old spellings are also accepted as input: `distillctl`
and `distill-monitor` are aliases of the new CLIs, `DISTILL_ROOT` and the
other `DISTILL_*` developer variables are read when their `FLOCK_*` spelling
is unset, `distill://` session links still open, and the `distillBundled`
marker and the `distill-sounds-N.mp3` sound ids are rewritten to their Flock
names once. See
[Upgrading from Distill](windows-onboarding.md#upgrading-from-distill).
