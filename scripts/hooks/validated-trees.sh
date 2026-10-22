#!/bin/sh
# Trees that passed the full gate, one hash per line, kept in the repository's
# common Git directory so every worktree shares them. validate-tree.sh records
# the tree it validated; validate-push.sh skips the gate for a recorded tree.
validated_trees_file() {
  printf '%s/flock-validated-trees\n' "$(git rev-parse --git-common-dir)"
}

tree_is_validated() {
  file=$(validated_trees_file)
  [ -f "$file" ] && grep -qx "$1" "$file"
}

record_validated_tree() {
  file=$(validated_trees_file)
  {
    [ -f "$file" ] && grep -vx "$1" "$file"
    printf '%s\n' "$1"
  } | tail -n 200 > "$file.tmp"
  mv "$file.tmp" "$file"
}
