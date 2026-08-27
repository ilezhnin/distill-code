#!/bin/sh
# Run a development tool, or say plainly that it could not be found.
#
# Git hooks started from a GUI client (Sourcetree, an IDE, GitHub Desktop) run
# with a trimmed environment. A pnpm installed through fnm, corepack or an npm
# global prefix lives on the operator's interactive PATH and nowhere else, so
# the hook died on "pnpm: command not found" before a single check had run.
# Every hook- and CI-facing just recipe goes through this launcher, so the
# search for a tool is written down once instead of per recipe.
#
# A tool that is genuinely not installed must not block a push. CI runs the
# same checks on the pushed commits, so refusing the push buys nothing and
# only teaches the operator to reach for --no-verify. The launcher warns
# loudly and skips instead. It never skips quietly, and it never skips where a
# missing tool means a broken image rather than a workstation quirk: on CI, or
# when BERD_REQUIRE_DEV_TOOLS=1 is set, a missing tool is still a hard error.

set -u

usage() {
  echo "usage: dev-tool.sh <tool> [args...]" >&2
  exit 2
}

tool="${1:-}"
[ -n "$tool" ] || usage
shift

# Candidate collector. Each candidate is an absolute path to a runnable file;
# the first one that exists wins.
resolved=""
try_candidate() {
  [ -z "$resolved" ] || return 0
  [ -n "${1:-}" ] || return 0
  [ -x "$1" ] || return 0
  resolved="$1"
}

# Newest match of a glob, so a per-shell fnm directory picks the live session
# rather than a stale one left behind by an earlier login.
try_newest_glob() {
  [ -z "$resolved" ] || return 0
  newest=""
  for candidate in $1; do
    [ -x "$candidate" ] || continue
    if [ -z "$newest" ] || [ "$candidate" -nt "$newest" ]; then
      newest="$candidate"
    fi
  done
  try_candidate "$newest"
}

# 1. Whatever PATH already offers.
path_hit="$(command -v "$tool" 2>/dev/null || true)"
case "$path_hit" in
  /*) try_candidate "$path_hit" ;;
esac

# 2. Version managers and package-manager prefixes, in the order a developer
#    would try them by hand.
if [ -z "$resolved" ]; then
  for fnm_root in \
    "${FNM_DIR:-}" \
    "${LOCALAPPDATA:-}/fnm" \
    "${XDG_DATA_HOME:-$HOME/.local/share}/fnm" \
    "$HOME/.fnm" \
    "$HOME/Library/Application Support/fnm"; do
    [ -n "$fnm_root" ] || continue
    [ -d "$fnm_root" ] || continue
    try_candidate "$fnm_root/aliases/default/bin/$tool"
    try_candidate "$fnm_root/aliases/default/$tool"
    try_newest_glob "$fnm_root/node-versions/*/installation/bin/$tool"
  done
  # fnm's per-shell directories are the case that started this: the operator's
  # pnpm lives only under one of them, keyed by the shell's pid.
  try_newest_glob "${LOCALAPPDATA:-/nonexistent}/fnm_multishells/*/$tool"
fi

if [ -z "$resolved" ]; then
  try_candidate "${npm_config_prefix:-/nonexistent}/bin/$tool"
  try_candidate "${APPDATA:-/nonexistent}/npm/$tool"
  try_candidate "$HOME/.npm-global/bin/$tool"
  try_candidate "$HOME/.volta/bin/$tool"
  if [ -z "$resolved" ] && command -v npm >/dev/null 2>&1; then
    npm_prefix="$(npm prefix -g 2>/dev/null || true)"
    try_candidate "${npm_prefix:-/nonexistent}/bin/$tool"
  fi
fi

# 3. Rust installs its own bin dir that a GUI client's PATH rarely carries.
if [ -z "$resolved" ]; then
  try_candidate "${CARGO_HOME:-$HOME/.cargo}/bin/$tool"
fi

# 4. corepack can materialise the pnpm this repo pins. It is last because it
#    may reach the network, which a pre-push hook should not do casually.
if [ -z "$resolved" ] && [ "$tool" = "pnpm" ]; then
  corepack="$(command -v corepack 2>/dev/null || true)"
  if [ -n "$corepack" ]; then
    exec "$corepack" pnpm "$@"
  fi
fi

if [ -z "$resolved" ]; then
  echo "" >&2
  echo "  ** $tool was not found on PATH, under fnm, or in an npm prefix." >&2
  if [ -n "${CI:-}" ] || [ "${BERD_REQUIRE_DEV_TOOLS:-0}" = "1" ]; then
    echo "  ** Refusing to skip it here: this is CI, or BERD_REQUIRE_DEV_TOOLS=1." >&2
    echo "" >&2
    exit 127
  fi
  echo "  ** Skipping the check that needs it. CI still runs it on this push." >&2
  echo "  ** Install $tool, or open the repo toolchain (source ./bin/activate-hermit)," >&2
  echo "  ** to get this check back locally." >&2
  echo "" >&2
  exit 0
fi

# A tool resolved outside PATH usually has its runtime beside it — an fnm pnpm
# shim calls the node next to it. Put its directory first so the tool can find
# its own neighbours.
tool_dir="$(dirname "$resolved")"
PATH="$tool_dir:$PATH"
export PATH

exec "$resolved" "$@"
