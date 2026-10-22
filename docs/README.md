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
| [Data storage](distill-root-layout.md) | What lives under `~/.distill` and in a project's `.distill/` folder, and how migrations keep older data. |

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
| [distillctl architecture](distillctl-architecture.md) | The app command registry, its generated contracts and the safety model behind the CLI. |
| [Driving the running app](app-e2e.md) | Exercising the dev build from a script or an agent, locally or through the relay. |
| [Assistive UX](assistive-ux.md) | The pattern for discover, suggest and auto-apply moments in the UI. |

## Help the app ships to its agents

The app installs two public skills into the user's skills folder:
[distill-help](../distro/skills/distill-help/SKILL.md) answers questions about
the app itself, and [distill-monitor](../distro/skills/distill-monitor/SKILL.md)
runs long commands outside the current turn. See the
[distro notes](../distro/README.md) for what may and may not ship there.

## A note on names

Flock grew out of a project called Distill, and this version still carries
that name inside: the window title, the `distillctl` and `distill-monitor`
tools, the `~/.distill` data root, and the `distill-wave`, `distill-report`,
`distill-verdict` and `distill-memory` protocol blocks. The guides use
"Distill" wherever they describe the current build literally. The product is
Levocat Flock, and the rename of the code base is in progress.
