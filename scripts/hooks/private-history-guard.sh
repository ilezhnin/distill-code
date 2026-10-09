#!/bin/sh
# pre-push hook: while `distill.privateBenchmarkHistoryPending` is true, older
# local tags and branches may still carry history that was removed from the
# published repository (docs/benchmark-authoring.md). Only a fast-forward of an
# existing branch whose new commits all grow from its published tip is let
# through; tags, new or deleted refs and merged-in older history are refused.
# Plain POSIX sh, so it runs under Git's own sh even when a GUI client starts
# the hook with a trimmed PATH that has no Node. Git passes one line per ref:
#   <local ref> <local sha> <remote ref> <remote sha>
value=$(git config --bool --get distill.privateBenchmarkHistoryPending 2>/dev/null)
status=$?
if [ "$status" -eq 1 ] || [ "$value" = "false" ]; then
  exit 0
fi
refuse() {
  echo "Push refused: $1 History remediation is pending (distill.privateBenchmarkHistoryPending)." >&2
  fail=1
}
fail=0
# A value Git cannot read as a boolean is not permission to publish.
[ "$status" -ne 0 ] && refuse "the setting is not a boolean."
zero=0000000000000000000000000000000000000000
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "$local_ref" ] && continue
  case "$remote_ref" in
    refs/heads/*) ;;
    *) refuse "$remote_ref is not a branch."; continue ;;
  esac
  if [ "$local_sha" = "$zero" ] || [ "$remote_sha" = "$zero" ]; then
    refuse "$remote_ref would be created or deleted."
    continue
  fi
  if ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
    refuse "$remote_ref is not a fast-forward of its published tip."
    continue
  fi
  all=$(git rev-list --count "$remote_sha..$local_sha")
  grown=$(git rev-list --count --ancestry-path "$remote_sha..$local_sha")
  if [ "$all" != "$grown" ]; then
    refuse "$remote_ref would publish commits that do not grow from its published tip."
  fi
done
exit $fail
