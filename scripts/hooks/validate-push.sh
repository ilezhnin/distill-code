#!/bin/sh
# pre-push hook: the full gate must have passed for every tree being pushed.
# A tree the commit hook validated is on record and is not checked again. Any
# other tree (committed elsewhere, or with hooks off) is validated now, which
# needs it to be the clean checked-out tree. Git passes one line per ref on
# stdin: <local ref> <local sha> <remote ref> <remote sha>.
set -eu

hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$(git rev-parse --show-toplevel)"
. "$hook_dir/validated-trees.sh"

pending=
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "$local_ref" ] || continue
  # A deletion pushes no tree.
  case "$local_sha" in *[!0]*) ;; *) continue ;; esac
  tree=$(git rev-parse --verify "$local_sha^{tree}")
  if tree_is_validated "$tree"; then
    echo "validate-push: $local_ref was validated at commit; not checking it again."
    continue
  fi
  if [ "$tree" != "$(git write-tree)" ]; then
    echo "Push blocked: $local_ref ($local_sha) was not validated at commit, and the checked-out tree is not the one being pushed." >&2
    echo "Check it out with a clean tree and push again, so the gate can run on it." >&2
    exit 1
  fi
  pending=1
done
if [ -n "$pending" ]; then
  sh "$hook_dir/validate-tree.sh" Push
fi
