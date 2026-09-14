#!/bin/sh
# commit-msg hook: Ivan Lezhnin is the only author of this project.
#
# No AI tool may take authorship or co-authorship of a commit: not as the
# author or committer identity, not through a Co-authored-by trailer, not
# through session links or "Generated with ..." footers. See AGENTS.md,
# "Authorship". Plain POSIX sh so it runs under Git's own sh even when a GUI
# client starts the hook with a trimmed PATH.
#
# Usage:
#   sh no-ai-attribution.sh <commit-msg-file>   # the commit-msg hook
#   ... | sh no-ai-attribution.sh -             # CI: scan a range of
#                                                # messages piped on stdin
#                                                # (e.g. `git log --format=%B
#                                                # origin/main..HEAD`); the
#                                                # local git identity is not
#                                                # relevant to a historical
#                                                # range, so identity checks
#                                                # are skipped in this mode.
msg_file="$1"
ai='claude|anthropic|openai|chatgpt|gpt-[0-9]|codex|copilot|gemini|grok'
fail=0

if [ "$msg_file" != "-" ]; then
  for ident in "$(git var GIT_AUTHOR_IDENT 2>/dev/null)" "$(git var GIT_COMMITTER_IDENT 2>/dev/null)"; do
    name_email=$(printf '%s\n' "$ident" | sed 's/ [0-9]* [-+][0-9]*$//')
    if printf '%s\n' "$name_email" | grep -Eiq "$ai|noreply@anthropic"; then
      echo "commit-msg: AI identity '$name_email' may not author or commit here." >&2
      fail=1
    fi
  done
fi

# Any "<word>-by:" trailer that names an AI catches the shapes a plain
# "co-authored-by:" scan misses (Assisted-by, Reviewed-by, Helped-by, ...);
# "(generated|made) (with|by) <ai>" catches body prose ("Made with Claude")
# as well as footers.
pattern="^[[:space:]]*co-authored-by:|^[[:space:]]*(claude|ai)-session:|(generated|made) (with|by) .*($ai)|^[[:space:]]*[a-z-]+-by:.*($ai)|claude\.ai/code|noreply@anthropic"

if [ "$msg_file" = "-" ]; then
  bad=$(grep -v '^#' | grep -Ein "$pattern")
elif [ -n "$msg_file" ] && [ -f "$msg_file" ]; then
  bad=$(grep -v '^#' "$msg_file" | grep -Ein "$pattern")
fi

if [ -n "$bad" ]; then
  echo "commit-msg: AI attribution is not allowed in commit messages:" >&2
  printf '  %s\n' "$bad" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "Remove it and commit as Ivan Lezhnin <ilezhnin@gmail.com>." >&2
fi
exit "$fail"
