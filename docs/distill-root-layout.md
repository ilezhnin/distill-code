# Distill root layout

One folder for everything the operator owns (`~/.distill`, the Distill root in
`src-tauri/src/services/distill_root.rs`), a per-project `.distill/` for
overrides, and a fixed set of Markdown files the environment reads before
every chat. Global first, then the project extends or overrides.

This document is the layout, ownership, prompt order and stage list. It is
not a law. The candidate law lives in `LAWS/PROPOSAL-2026-09-distill-root.md`.

## Target layout

```
~/.distill/                        the Distill root (env DISTILL_ROOT / pointer / default)
  prompt.md                        master prompt: principles, priorities, explicit boundaries
  user.md                          who the operator is; durable collaboration preferences only
  lore.md                          map of past joint work: projects, decisions, results, lessons
  security-posture.md              disclosure rules and security boundaries
  research/
    index.md                       one line per record
    NN-topic.md                    question, evidence, options, decision, risks, when to revisit
  settings.json                    preferences that used to be localStorage (stage 2)
  agents/                          personas (stage 4; ~/.agents/agents stays an additional source)
  skills/                          personal skills (stage 4; ~/.agents/skills stays an additional source)
  hooks/                           reserved
  memory.json  conductor/  runs/  state/  artifacts/  projects/
  sessions/agent-host.db           (stage 3, from AppData)
  cache/                           packages, node, bridges, avatars: regenerable, not part of a backup

<project>/.distill/
  AGENTS.md                        project conventions; extends prompt.md
  research/index.md + NN-topic.md  project-level decision records, same format
  settings.json                    key-level overrides of the global settings (stage 2)
  wiki/  memory.json  agents/  skills/
```

The root is resolved as `DISTILL_ROOT`, then the `root-path` pointer in the OS
config dir, then `~/.distill`. The pointer is the one file that must stay
outside the root.

There is no global `AGENTS.md`. That name is the per-repo convention Codex
and Claude Code read natively; Distill's global file is `prompt.md`.

## Ownership and delivery

| File | Written by | Reaches the prompt | Project override |
| --- | --- | --- | --- |
| `prompt.md` | operator | always, every agent, full content | `<project>/.distill/AGENTS.md` extends it |
| `security-posture.md` | operator | always, every agent, full content | a project may add restrictions only |
| `user.md` | operator only; agents propose through `distill-memory` | plain chats and conductors, full content; never wave executors | none, it is about the person |
| `lore.md` | conductor loop after an accepted wave | pointer sentence only; never wave executors | none, projects have the wiki |
| `research/index.md`, `research/NN-*.md` | operator or conductor loop | pointer sentence only, plain chats and conductors; never wave executors | project has its own `research/` with its own pointer |
| `<project>/.distill/research/index.md` | operator or conductor loop | pointer sentence only, including wave executors | scoped to that project's chats |
| `security-audit` skill | operator | on demand like any skill | none |

`user.md`, `lore.md` and the global research pointer ride inside
`operatorProtocols`, which is withheld from wave executors. The operator's
record stays with plain chats and conductors (`LAWS/MEMORY.md`); executors
receive their own project's research pointer.

Existing project instructions (`project.prompt`) also reach that project's
chats, including wave executors. They are delivered before the workspace's
`AGENTS.md` files, which can extend or override them. A general chat receives
no project's instructions, regardless of which project is selected in the UI.

Agents never write `user.md`. The only agent write channel to the operator's
record is the `distill-memory` fence. The `<operator-profile>` block says so.

Missing or blank files produce no block. There are no size limits, no
warnings, no seeding of missing files, and no extra checks of file contents.

## Prompt assembly order

Handed off once per session/provider/fingerprint, in this order:

1. `[Defaults]` (code constant)
2. Style guidelines (localStorage today; `settings.json` after stage 2)
3. `[Distill]` distillctl preamble
4. `<operator-instructions>`: `~/.distill/prompt.md`, then `security-posture.md`
5. Persona (`<active-persona>`)
6. Spawn policy sentence
7. Included workspaces
8. `<project-instructions>`: the target project's existing instructions (`project.prompt`)
9. `<workspace-instructions>`: `AGENTS.md` and `.distill/AGENTS.md` per folder, git root first
10. Project wiki pointer
11. Project research pointer
12. App skills catalog, available skills catalog
13. `operatorProtocols` (not for wave executors): `<operator-profile>` (`user.md`), lore pointer, global research pointer, memory block, planner protocol

App-authored blocks come first so operator-authored text reads as the override.

The five send paths preserve this operator protocol order: foreground send,
queued drain, captured queue, background/distillctl send, and wave spawn.
The foreground controller composes the visible chat's prompt; queued drains
compose missing context at dispatch. A captured send freezes
`operatorProtocols` at capture time along with the accepted persona and
workspace context, and dispatch uses that captured prompt unchanged. While
root instructions or project research are still loading, acceptance queues
the message and its persona intent immediately without freezing an incomplete
execution prompt. The queue resumes after those reads finish.
Background/distillctl sends and uncaptured queued sends await the root files
and project research presence before composing their own prompt. Concurrent
research reads share the pending listing, so a cold cache cannot omit an
existing index from the first send. An explicit `executionSystemPrompt`
passes through unchanged and does not start another research lookup.
Wave spawns dispatch through the queue with the executor gate: project
research stays beside the wiki pointer, while profile, lore, global research,
memory and planner protocols are withheld. The same gate applies when any
other path addresses a wave executor, including after its graph node is gone.

## Stages

Stage 1 (this delivery): root instruction files reach every chat.

- `prompt.md` and `security-posture.md` ride in the ACP handoff after the
  distillctl preamble.
- `user.md`, lore pointer and the global research pointer ride inside
  `operatorProtocols`.
- Project research pointer sits beside the wiki pointer.
- Workspace discovery reads `AGENTS.md` then `.distill/AGENTS.md` at every
  level the existing walk visits.

Stage 2: preferences out of localStorage into `~/.distill/settings.json`, with
key-level overrides in `<project>/.distill/settings.json`.

Conductor graph and wave documents already use the root on desktop. A
successful first migration removes their legacy localStorage copy; browser
previews retain localStorage, and a failed migration preserves the old data.
Their synchronous bootstrap is not a second live desktop persistence store.

Stage 3: AppData state under the root (sessions db, message queues, bundled
skills, packages/cache). After one start, `%APPDATA%\com.levocat.distill.dev`
holds only the `root-path` pointer and regenerable caches.

Stage 4: personas and skills under the root. `~/.agents` remains an additional
source; a name in both resolves to the root copy.

Stage 5: Settings surface for the five files, `security-audit` skill scaffold,
templates in this document. The app does not seed the files.

Stage 6: canonise `LAWS/ROOT.md` from the proposal, after product approval.
