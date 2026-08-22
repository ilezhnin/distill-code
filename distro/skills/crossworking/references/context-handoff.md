# Context Handoff Format

Use durable handoff files only when work must cross sessions, platforms, or a manual delegation boundary. Same-session agents receive a bounded direct prompt instead.

## Canonical Context

Write `.agents/plans/context-<work-item>.md` with:

- Goal and acceptance criteria.
- Starting branch, base SHA, initial dirty paths, and task-owned paths.
- Relevant files with precise locations and one line on why each matters.
- Confirmed ownership boundaries, existing patterns, dependencies, and risks.
- Asset/provenance constraints when relevant.
- Exact baseline and final validation commands.
- Decisions, assumptions, open questions, and stop conditions.

Keep source evidence once in this file. Link to logs or larger artifacts instead of copying raw output.

## Optional Portable Prompt

Create `.agents/plans/meta-prompt-<work-item>.md` only when a human or another platform must manually start the next agent. Keep it short:

```markdown
# Goal
<One concrete result for the next agent.>

# Canonical Context
Read [context-<work-item>.md](./context-<work-item>.md) before acting.

# Assigned Scope
<Exact task-owned paths and non-goals.>

# Required Output
<Changes or report to return, plus validation and stop conditions.>
```

Do not repeat evidence, constraints, or validation details from the canonical context.

## Rules

- Read real imports, call sites, tests, fixtures, configuration, and project contracts before writing the handoff.
- Study referenced URLs, issues, PRs, plans, or designs before summarizing them.
- Delegate current external research to the `researcher` role and asset work to `asset-pipeline`; link their briefs.
- Name information gaps explicitly.
- Create one work-item slug per distinct worker scope so concurrent handoffs cannot overwrite each other.

