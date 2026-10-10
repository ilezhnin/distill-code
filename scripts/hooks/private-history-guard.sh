#!/bin/sh
# pre-push hook: while `distill.privateBenchmarkHistoryPending` is true, older
# local tags and branches may still carry history that was removed from the
# published repository (docs/benchmark-authoring.md). Outgoing commits must grow
# from a reviewed, already published base. Without that local base, retain the
# stricter existing-branch policy. Tags, deletions and history rewrites refuse.
# Plain POSIX sh, so it runs under Git's own sh even when a GUI client starts
# the hook with a trimmed PATH that has no Node. Git passes one line per ref:
#   <local ref> <local sha> <remote ref> <remote sha>
# The first argument is the actual push URL, forwarded by lefthook. Only new
# branches need a remote lookup; existing branches use Git's advertised tip.
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
if [ "$status" -ne 0 ]; then
  refuse "the setting is not a boolean."
  exit 1
fi
reviewed_base=$(git config --get distill.privateBenchmarkReviewedBase 2>/dev/null)
status=$?
if [ "$status" -ne 0 ] && [ "$status" -ne 1 ]; then
  refuse "the reviewed base setting cannot be read."
  exit 1
fi
if [ "$status" -eq 0 ]; then
  # Require an immutable full commit ID, never a moving branch/tag or revision.
  case "$reviewed_base" in
    ''|*[!0-9a-f]*) refuse "the reviewed base must be a full commit ID."; exit 1 ;;
  esac
  resolved=$(git rev-parse --verify "$reviewed_base^{commit}" 2>/dev/null)
  if [ $? -ne 0 ] || [ "$resolved" != "$reviewed_base" ]; then
    refuse "the reviewed base must be an available full commit ID."
    exit 1
  fi
fi
shallow=$(git rev-parse --is-shallow-repository 2>/dev/null)
if [ $? -ne 0 ] || [ "$shallow" != false ]; then
  refuse "complete local history is required to verify publication."
  exit 1
fi

published_base_tip() {
  [ -n "$1" ] || return 1
  tips=$(git ls-remote --heads -- "$1") || return 1
  while read -r tip ref; do
    case "$ref" in refs/heads/*) ;; *) continue ;; esac
    # Do not trust stale remote-tracking refs, another remote, or missing objects.
    if git merge-base --is-ancestor "$reviewed_base" "$tip" 2>/dev/null; then
      printf '%s\n' "$tip"
      return 0
    fi
  done <<EOF
$tips
EOF
  return 1
}

zero=0000000000000000000000000000000000000000
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "$local_ref" ] && continue
  case "$remote_ref" in
    refs/heads/*) ;;
    *) refuse "$remote_ref is not a branch."; continue ;;
  esac
  if [ "$local_sha" = "$zero" ]; then
    refuse "$remote_ref would be deleted."
    continue
  fi
  if [ "$remote_sha" = "$zero" ]; then
    if [ -z "$reviewed_base" ]; then
      refuse "$remote_ref is new; configure a reviewed published base first."
      continue
    fi
    published_tip=$(published_base_tip "${1:-}") || {
      refuse "$remote_ref cannot verify its reviewed base on the push destination."
      continue
    }
  else
    published_tip=$remote_sha
    if ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
      refuse "$remote_ref is not a fast-forward of its published tip."
      continue
    fi
  fi
  base=${reviewed_base:-$published_tip}
  if ! git merge-base --is-ancestor "$base" "$published_tip" 2>/dev/null; then
    refuse "$remote_ref does not contain the reviewed base on the push destination."
    continue
  fi
  if ! git merge-base --is-ancestor "$base" "$local_sha" 2>/dev/null; then
    refuse "$remote_ref does not descend from the reviewed published base."
    continue
  fi
  outgoing=$(git rev-list "$published_tip..$local_sha") || {
    refuse "$remote_ref outgoing history cannot be read."
    continue
  }
  # Check each commit itself. --ancestry-path over a range can omit valid side
  # commits when the reviewed base is behind the range's excluded remote tip.
  for commit in $outgoing; do
    if ! git merge-base --is-ancestor "$base" "$commit" 2>/dev/null; then
      refuse "$remote_ref would publish commits outside its reviewed published history."
      break
    fi
  done
done
exit $fail
