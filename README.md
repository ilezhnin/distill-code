# Berd

Berd is an open-source desktop app for working with AI agents. It is built with
Tauri 2 and React 19. A built-in Rust host speaks ACP to the agent harnesses
(Claude Code, Codex, Grok, Copilot, Amp) and keeps every session locally.

The repository builds a general-purpose public distribution. Organizations can
also create enterprise distributions by supplying managed provider settings,
private resources, and release infrastructure through the repository's
distribution seams without adding private material to the public source tree.

## Getting started

```bash
just setup
just dev
```

`just setup` installs pnpm dependencies and git hooks. `just dev` builds the
workspace CLIs and starts the Tauri dev app; the ACP bridges are installed at
runtime from `acp-tools.lock.json`.

## Bundling and distributions

`just bundle` stages the `berdctl` and `berd-monitor` sidecars and runs
`pnpm tauri build`:

```bash
just bundle
```

The public build is self-contained and does not require private package
registries or enterprise credentials. Enterprise distributors may overlay
private agents, runtime configuration, update channels, and signing or
publishing infrastructure in their own private build orchestration.

## Participating

Berd is built by a small team at Block, in the open. You can read the source,
build it, and fork it freely — but **we don't accept pull requests from outside
authorized repository collaborators**, and outside PRs are closed automatically.

The way to participate is to **open a well-formed issue**. A bug report we can
reproduce is worth more to us than a patch, because it's the part we can't do
ourselves. [CONTRIBUTING.md](CONTRIBUTING.md) spells out exactly what each kind
of issue needs; the [issue forms](https://github.com/block/berd/issues/new/choose)
require it.

Filing one? Hand this to your coding agent:

```
Read https://raw.githubusercontent.com/block/berd/main/CONTRIBUTING.md
and help me file a Berd issue. Interview me for anything the guide
requires that I haven't given you, and tell me if what I'm reporting
is actually two separate issues.
```

Please also review the [Code of Conduct](CODE_OF_CONDUCT.md) and
[Security Policy](SECURITY.md). Never report a security vulnerability as a
public issue.

## Useful commands

- `just check` — Biome, design-system, i18n, contract, and type checks
- `just test` — unit and component tests
- `just tauri-check` — Rust type check with sidecars disabled
- `just clippy` — Rust lint with warnings denied
- `just bundle` — stage the sidecars and run `pnpm tauri build`
