#!/bin/sh
# pre-commit and pre-merge-commit hook: the full gate must pass for the tree
# Git will commit. See validate-tree.sh.
hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec sh "$hook_dir/validate-tree.sh" Commit
