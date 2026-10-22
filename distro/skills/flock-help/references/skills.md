# Skills

A skill is a `SKILL.md` file (frontmatter + instructions) that gets matched
against a request and loaded into a session's context when relevant. Skills
come from more than one source, and the source determines ownership and
precedence:

- **App-bundled** (`flockBundled` marker; a copy an older build installed
  carries `distillBundled`, rewritten at startup) — ships with Flock,
  read-only in the UI, lives in the Flock folder's `skills/`
  (`~/.flock/skills/`, or `~/.distill/skills/` on an install upgraded from
  Distill).
- **Personal** (`global`) — the user's own skills, portable across projects,
  from the same `skills/` folder.
- **Project** — scoped to a specific project/workspace, from
  `<workspace>/.distill/skills`. Vendor folders (`.claude/skills`,
  `.codex/skills`, `.gemini/skills`) are not scanned.

When a personal skill and an app-bundled skill share a name, the personal
one wins activation — this is deliberate (see `skill_source_priority` in
`src-tauri/src/commands/agent_skills.rs`), not a bug if a user reports their
own version of a bundled skill taking over. Creating or editing a skill is
the `skill-builder` skill's job — hand off rather than duplicate. Source of
truth for current source kinds, priority, and discovery lives in
`src/features/skills/api/skills.ts` and
`src-tauri/src/commands/agent_skills.rs`.
