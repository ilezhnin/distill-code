#!/bin/sh
# Validate the tree Git is about to commit or push, without stashing or staging
# user work. The argument names the operation in messages (Commit or Push). A
# tree that passes is recorded, so pushing it later does not run the gate again.
set -eu

action=${1:-Commit}
hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$(git rev-parse --show-toplevel)"
. "$hook_dir/validated-trees.sh"

assert_staged_tree() {
  if ! git diff --quiet --ignore-submodules=none --; then
    echo "$action blocked: unstaged changes would make checks test a different tree." >&2
    echo "Stage only this task's changes; use a separate worktree for unrelated work." >&2
    exit 1
  fi
  if [ -n "$(git ls-files --others --exclude-standard)" ]; then
    echo "$action blocked: untracked files could affect checks but are absent from the commit." >&2
    echo "Stage intended source files or move unrelated work to a separate worktree." >&2
    exit 1
  fi
}

assert_staged_tree
tree=$(git write-tree)
(
  # Tests create independent Git repositories. Do not let the hook's temporary
  # index or repository variables redirect their Git commands into this commit.
  unset $(git rev-parse --local-env-vars)
  sh "$hook_dir/dev-tool.sh" just ci
)
assert_staged_tree
if [ "$tree" != "$(git write-tree)" ]; then
  echo "$action blocked: the staged tree changed during validation. Run the checks again." >&2
  exit 1
fi
record_validated_tree "$tree"
