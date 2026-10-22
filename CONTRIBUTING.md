# Contributing to Levocat Flock

Thanks for looking under the hood. This page is the short version; the
complete contributor guide, code map, and conventions are in
[AGENTS.md](AGENTS.md), which both people and coding agents follow.

## Before you start

- Read [PRODUCT.md](PRODUCT.md) for what the product is and is not.
- Read [LAWS/README.md](LAWS/README.md). The laws describe required product
  behavior and take precedence over the current code and tests. A change that
  touches a law has to update the code, the tests, or the law so they agree.
- Browse the [documentation index](docs/README.md) for the area you are
  changing.

## Set up a development machine

Flock builds and runs on Windows. From PowerShell, in the repository:

```powershell
just bootstrap-windows install
just setup-windows
just dev-windows
```

The [Windows setup guide](docs/windows-onboarding.md) covers prerequisites,
running the scripts without `just`, troubleshooting, and building an installer.

## Make a change

- Keep responsibilities clear, reuse existing feature APIs and shared UI, and
  follow the nested `AGENTS.md` of the area you are in.
- Use focused checks while you work: `just check` and the relevant tests for
  frontend code, `just tauri-check` and the affected Rust tests for the host,
  `git diff --check` and a readback for documentation.
- Check the affected user flow in the running app for UI or runtime changes,
  and say in the pull request what you verified.
- Keep user-facing text focused on the user's task. Add new strings to the
  locale files rather than hardcoding them.

## Before you open a pull request

- Run the full local gate, `just ci`, on the final tree. The commit and push
  hooks installed by `just setup-windows` run the same gate; they reject
  unstaged changes and do not rewrite or stage files for you.
- Write an imperative subject line that says what the change does.
- Do not add AI attribution trailers, generated-by footers, or agent session
  links to commits, code, or documentation. The commit-message hook rejects
  them. Commits carry the human author's name and email.
- Keep private material out of the tree: profiles, memory, conversations,
  roles, working skills, credentials, account exports, benchmark tasks, and
  internal plans belong under the app's data root, never in Git. Use
  fictional names and paths in examples and tests.

## Reporting problems

Open an issue on GitHub with the app version, the provider and model in use,
and the exact error or a screenshot. For a security problem, see
[SECURITY.md](SECURITY.md) instead of a public issue.
