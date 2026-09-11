#!/bin/sh
# commit-msg hook: Ivan Lezhnin is the only author of this project.
#
# No AI tool may take authorship or co-authorship of a commit: not as the
# author or committer identity, not through a Co-authored-by trailer, not
# through session links or "Generated with ..." footers. See AGENTS.md,
# "Authorship". Plain POSIX sh so it runs under Git's own sh even when a GUI
# client starts the hook with a trimmed PATH.
msg_file="$1"
ai='claude|anthropic|openai|chatgpt|gpt-[0-9]|codex|copilot|gemini|grok'
fail=0

for ident in "$(git var GIT_AUTHOR_IDENT 2>/dev/null)" "$(git var GIT_COMMITTER_IDENT 2>/dev/null)"; do
  name_email=$(printf '%s\n' "$ident" | sed 's/ [0-9]* [-+][0-9]*$//')
  if printf '%s\n' "$name_email" | grep -Eiq "$ai|noreply@anthropic"; then
    echo "commit-msg: AI identity '$name_email' may not author or commit here." >&2
    fail=1
  fi
done

if [ -n "$msg_file" ] && [ -f "$msg_file" ]; then
  bad=$(grep -v '^#' "$msg_file" | grep -Ein \
    "^[[:space:]]*co-authored-by:|^[[:space:]]*(claude|ai)-session:|generated (with|by) .*($ai)|claude\.ai/code|noreply@anthropic")
  if [ -n "$bad" ]; then
    echo "commit-msg: AI attribution is not allowed in commit messages:" >&2
    printf '  %s\n' "$bad" >&2
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "Remove it and commit as Ivan Lezhnin <ilezhnin@gmail.com>." >&2
fi
exit "$fail"
