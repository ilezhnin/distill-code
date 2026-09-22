# Proposal: a law for the Distill root

**This file is not a law.** It is a proposal for product review, kept apart
from the code change it follows. Delete it once the item below is decided, and
apply the adopted wording to `LAWS/ROOT.md`.

**No law change is required for the code in stage 1 to be correct.** Stage 1
only delivers the Markdown instruction files into prompts. The candidate text
below is the durable boundary that stages 2–6 would then have to meet.

## Proposed `LAWS/ROOT.md`

Each line is one requirement:

- Everything the operator owns MUST live under the Distill root.
- Only the root pointer and regenerable caches MAY live outside the root.
- A project's overrides MUST live in that project's own `.distill` folder.
- A Markdown file the operator placed in the root for agents MUST reach the
  prompts its ownership table says it reaches, and MUST NOT reach a wave
  executor when it is the operator's record.

Why this is a law candidate rather than feature policy: it is a sovereignty
boundary on where the operator's work lives and which sessions may see it,
in the same family as `LAWS/MEMORY.md`. Folder names, which five files exist
today, and how a preference is stored are feature policy and deliberately not
part of the wording.

The ownership table that the last requirement refers to lives in
`docs/distill-root-layout.md`.

## Call sites that still bypass the root

Stage 1 does not move AppData. Twelve `.app_data_dir()` call sites still write
or read outside `~/.distill`:

| File | Count |
| --- | --- |
| `src-tauri/src/commands/agent_skills.rs` | 2 |
| `src-tauri/src/commands/avatars.rs` | 1 |
| `src-tauri/src/commands/cache.rs` | 1 |
| `src-tauri/src/commands/message_queues.rs` | 1 |
| `src-tauri/src/lib.rs` | 1 |
| `src-tauri/src/services/agent_host/harness_env.rs` | 1 |
| `src-tauri/src/services/agent_host/router.rs` | 2 |
| `src-tauri/src/services/managed_acp_tools.rs` | 1 |
| `src-tauri/src/services/managed_node.rs` | 1 |
| `src-tauri/plugins/distillctl/src/lib.rs` | 1 |

Counted 2026-09-22. Stage 3 is the move.

How the code will conform, after the later stages: `distill_root.rs` already
states the archive-one-folder requirement. Stages 2–4 move preferences,
AppData state, personas and skills under that folder. Stage 1 already keeps
`user.md` and `lore.md` out of wave-executor prompts by riding them inside
`operatorProtocols`.
