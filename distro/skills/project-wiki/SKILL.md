---
name: project-wiki
description: Compile what a project knows into its own `.distill/wiki/` — pages, index, append-only log. Use after an accepted wave taught something durable, when the operator asks to record or lint project knowledge, or before re-exploring a repository.
metadata:
  berdBundled: true
---

# Project Wiki

A memory is one short standing fact about the operator. A wiki page is the
compiled knowledge of one project — how a module works, why a choice was made,
what a wave found. Different stores: durable lessons go through the
`distill-memory` fence, project knowledge goes here.

The wiki lives in the project's own folder, is plain markdown, and stays
readable with the app closed. Nothing about it may depend on Distill running.

## Where it lives

```
.distill/wiki/
  index.md        — catalogue of every page
  log.md          — append-only trail of what was written, asked, linted
  pages/<slug>.md — one page
```

A slug matches `[a-z0-9-]+`, is the file stem, and is the id used everywhere
else: the index row, the `[[slug]]` links, the log line.

## Who writes

The operator, or the conductor loop. A wave executor never writes the wiki —
its findings travel in its `distill-report`, and the conductor ingests them
after the verdict. This is a law (`LAWS/MEMORY.md`, "Project knowledge"), not
a convention: an executor that edits `.distill/wiki/` has broken the contract
even if the page is good.

## When to write

- After an `accept` verdict, when the wave taught something that outlives it.
- When the operator asks for it.

Not on `revise`, not on `needs-operator`, not mid-wave. A wave still in flight
has nothing settled to compile.

## Ingest, step by step

1. Read `.distill/wiki/index.md`. If the tree does not exist, create it: an
   empty `pages/`, and `index.md` and `log.md` carrying the headings below
   and no entries.
2. Pick at most three subjects worth keeping. One ingest touches **1–3 pages
   plus `index.md` plus `log.md`, and nothing else**. If more looks necessary,
   the knowledge is not compiled yet — write the most durable page and say in
   the report what was left out.
3. Merge before you add. Scan the index for a near-duplicate slug — same
   subject under a synonym, a singular/plural, a wider or narrower name. If
   one exists, update that page. Updating an existing page always beats
   creating a neighbour.
4. Set `updated:` to today. Extend `sources:`, do not replace it.
5. Update or add the page's index row.
6. Append one `ingest` line to `log.md`.
7. Tell the operator in one line which pages moved.

Split a page when it passes ~150 lines: the new page gets its own slug, index
row and `[[link]]` from the original.

## Formats

### `index.md`

```markdown
# Wiki index

| slug | what it is | type | updated |
| --- | --- | --- | --- |
| retry-policy | How src/net/retry.ts schedules and caps retries | concept | 2026-08-31 |
| goose-sidecar | The pinned Goose backend and how a build stages it | entity | 2026-08-14 |
```

Keep the heading and both header rows exactly as written. One row per file in
`pages/`, sorted by slug. The second column is one line of substance — what a
reader would learn — never a restatement of the title.

### `log.md`

```markdown
# Wiki log

## [2026-08-28] query | how does the sidecar get staged
## [2026-08-30] lint | 2 orphans, 1 stale page reported to operator
## [2026-08-31] ingest | retry-policy: backoff caps confirmed against src/net/retry.ts
```

Append-only: new lines go at the bottom, and a line already there is never
edited or deleted. The kind is exactly one of `ingest`, `query`, `lint`. One
line per entry, no body.

### `pages/<slug>.md`

```markdown
---
title: Retry policy
type: concept
updated: 2026-08-31
sources:
  - src/net/retry.ts
  - wave: 2026-08-31 retry comparison
---

# Retry policy

## What it is

One paragraph a newcomer can act on.

## How it works

Short sections, one claim each. Name files instead of copying them.

## Gotchas

What surprised someone and cost time.

## See also

- [[goose-sidecar]]
```

The four frontmatter keys, in that order, one value per line — the wiki is
parsed line by line, so no nested or quoted YAML beyond the `sources:` list.
`type` is exactly one of `entity`, `concept`, `decision`, `report`. `updated`
is the day you wrote, `YYYY-MM-DD`. `sources` holds repo paths, or
`wave: <date> <label>` for a wave that produced the finding. Link with
`[[slug]]`, and only to a slug the index already lists.

| type | for |
| --- | --- |
| entity | a thing that exists: module, binary, service, file cluster, external system |
| concept | how something works, or a term this project uses in its own way |
| decision | a choice, its reason, and what it rejected |
| report | a dated finding that stays useful — a benchmark, an audit, a comparison |

## What not to write

- Secrets — tokens, keys, credentials, private hosts. Never, in any form.
- What the repo already says. If a file answers the question, name the file.
- Facts true for one turn: a run's numbers, a branch in flight, a temporary path.
- Anything unverified. A guess in a wiki outlives the guesser.
- The operator's preferences — those are memories, not pages.

## Lint

On the operator's request, read `index.md` and every page and report a list.
Do not fix anything while linting.

- **Orphans** — a page missing from the index, an index row with no page, a
  page nothing links to.
- **Contradictions** — two pages stating different things about one subject.
- **Stale** — `updated` older than the sources it names, or a page naming
  files that are no longer in the repo.
- **Oversize** — a page past ~150 lines that wants splitting.
- **Near-duplicate slugs** — two pages that should be one.

Append one `lint` line to `log.md` with the counts. Fixing is a separate
ingest, after the operator says which findings to act on.

## Reading it

Before exploring a repository, read `.distill/wiki/index.md` and open only the
pages whose row touches your zone. Where the wiki already covers the zone,
check it against the code for discrepancies instead of re-scanning the tree.
A discrepancy is a finding for the report, not an edit.
