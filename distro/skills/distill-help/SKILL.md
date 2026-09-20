---
name: distill-help
description: >-
  Help with Distill the desktop app: how-to, troubleshooting, settings, agents,
  skills, projects, sessions, providers, extensions, or distillctl. Use for app questions, not harness-specific behavior.
metadata:
  distillBundled: true
---

# Distill help

Use this skill to help users operate, troubleshoot, and script Distill — the
desktop app — from a normal chat. Topics below point to `references/` files;
read the one relevant to the user's question rather than guessing, and read
more than one if the question spans topics.

## First Principles

- Before giving exact product instructions, try to verify the behavior from
  available evidence. If source code is available, inspect it first. If
  source code is not available, use visible app state, screenshots, error
  messages, Doctor output, or `distillctl --help` output.
- Do not invent UI paths, menu names, frontmatter fields, feature existence,
  fallback workflows, or `distillctl` commands/flags. If you cannot verify the
  exact path, say that and ask for a screenshot, selected project/source
  access, or the specific screen the user is on. For `distillctl`, verify
  against `--help` rather than recalling flags from memory.
- Treat the current app behavior as the source of truth. Prefer evidence from
  visible UI, runtime state, error messages, Doctor output, local files,
  `distillctl --help`, and available source over memory or stale documentation.
- Give practical steps the user can try now. Keep the answer short unless the
  problem needs a deeper diagnosis.
- Do not claim access to private GitHub source unless it is actually
  available in the current environment.
- Distill changes fast. Prefer naming *where to look* (a file, a command's
  `--help`, a visible settings section) over naming specific section names,
  labels, flags, or IDs in this skill's own prose — those are exactly the
  details most likely to move. When a reference file below does name
  something specific, treat it as a hint of where to look, not a guarantee it
  still matches current behavior; verify before repeating it to the user.

## Scope

This skill is about Distill the app — not about any one harness running inside
a session (`claude-acp`, `codex-acp`, `grok-acp`, `copilot-acp`, `amp-acp`). A question about the app around the harness (where a
setting lives, how a session started, how to export a chat, how to file a
Distill bug) is in scope. A question about a specific harness's own behavior,
output, or errors is not — treat that as harness-specific and say so rather
than guessing at harness internals.

## What To Check

For how-to questions:

- Identify the feature area from the Topics list below and read that
  reference file.
- If source is available, search for the feature's UI, command, hook, tests,
  or i18n strings before answering.
- Use the app's current state when available: selected agent, project,
  model, provider, active session, attached files, visible errors, or
  screenshots.
- Explain the shortest path to the action, then mention important
  constraints or gotchas. If a `distillctl` command does the same thing faster
  or more reliably than a click path, offer it — see
  `references/distillctl.md`.

For troubleshooting:

- Ask for the exact error, screenshot, provider/model, project path, or
  Doctor result when the symptoms are ambiguous.
- Suggest low-risk checks first: rerun, reconnect, verify settings, check
  selected model/provider, restart the app, or run Doctor when relevant.
- Separate likely causes from confirmed causes.

## Topics

Read the matching reference file for a specific question. Read more than one
when a question spans topics (for example, a session failure that might
be a provider problem needs both):

- `references/distillctl.md` — the distillctl CLI, when to prefer it over UI steps
- `references/agents.md` — agents/personas
- `references/skills.md` — skills, source kinds, precedence
- `references/projects.md` — projects and workspaces
- `references/sessions.md` — sessions ("chat"), the right rail, files,
  worktrees, terminal
- `references/ai-providers.md` — provider connections and error causes
- `references/settings.md` — settings structure and gotchas

## Working With Bundled Builder Skills

- If the user wants to create, edit, or inspect an agent/persona, use or
  recommend the `agent-builder` skill.
- If the user wants to create, edit, or inspect a reusable skill, use or
  recommend the `skill-builder` skill.
- Do not duplicate those workflows inside this skill or its references. This
  skill helps users understand, troubleshoot, and drive the app around them.

## Source Of Truth

When source code is available, use it to verify behavior — the reference
files above may lag actual behavior since Distill changes fast. Good places to
inspect include UI feature folders, Tauri commands, distro bundled skills,
settings views, `distillctl` command modules
(`src/features/distillctl/commands/impl/`), and tests. If source code is not
available, rely on current app context and `--help` output, and be
transparent about uncertainty.
