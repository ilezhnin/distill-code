#!/usr/bin/env bash
set -euo pipefail

# Repo-local by default. A debug Tauri build of this workspace is 30-60 GB
# (deps + incremental + debug info); parking that in the user cache dir fills
# the system/home volume, and on Windows it also duplicated the target tree the
# desktop launcher already builds inside the checkout. Set
# BERD_TAURI_CARGO_TARGET_DIR to move it somewhere else on purpose.
if [[ -n "${BERD_TAURI_CARGO_TARGET_DIR:-}" ]]; then
  printf '%s\n' "$BERD_TAURI_CARGO_TARGET_DIR"
else
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  printf '%s/src-tauri/target\n' "$repo_root"
fi
