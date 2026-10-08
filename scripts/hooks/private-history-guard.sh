#!/bin/sh
# pre-push hook: refuse publication while private material may remain in the
# outgoing history. Set `distill.privateBenchmarkHistoryPending` to `true`
# during history remediation and clear it only after the authorized review
# (docs/benchmark-authoring.md). Plain POSIX sh, so it runs under Git's own sh
# even when a GUI client starts the hook with a trimmed PATH that has no Node.
#
# A malformed value is not permission to publish: anything Git cannot read as
# a boolean refuses, like `true`.
value=$(git config --bool --get distill.privateBenchmarkHistoryPending 2>/dev/null)
status=$?
if [ "$status" -eq 1 ] || [ "$value" = "false" ]; then
  exit 0
fi
echo "Push refused: private material may remain in outgoing history. Complete the authorized history review before clearing distill.privateBenchmarkHistoryPending." >&2
exit 1
