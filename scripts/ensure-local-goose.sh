#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
default_lock_file="$repo_root/goose-backend.lock.json"

usage() {
  cat <<'USAGE'
Usage: scripts/ensure-local-goose.sh [--print-bin | --check-bin]

Syncs and builds the pinned Goose backend checkout for Berd development.
By default, the repo root goose-backend.lock.json controls the upstream repo,
ref, commit, cargo package, and binary name.

Environment variables:
  GOOSE_BACKEND_LOCK_FILE    lockfile path (default: ./goose-backend.lock.json)
  GOOSE_DEV_MODE             auto|required (default: auto)
  GOOSE_DEV_ROOT             cache root (default: platform cache dir)
  GOOSE_DEV_REPO             goose checkout path (the managed clone, or the
                             local source tree when GOOSE_DEV_LOCAL=1)
  GOOSE_DEV_STAMP_FILE       build stamp path
  GOOSE_DEV_CLONE_URL        override clone URL from lockfile
  GOOSE_DEV_REMOTE           git remote to sync from (default: origin)
  GOOSE_DEV_REF              override ref from lockfile (branch, tag, or sha)
  GOOSE_DEV_BRANCH           deprecated alias for GOOSE_DEV_REF
  GOOSE_DEV_COMMIT           override pinned commit from lockfile
  GOOSE_DEV_PACKAGE          override cargo package from lockfile
  GOOSE_DEV_BIN              override built binary name from lockfile
  GOOSE_DEV_PATCH_DIR        Goose patch directory (default: ./patches/goose)
  GOOSE_DEV_ALLOW_DIRTY      1 to allow building a dirty checkout
  GOOSE_DEV_LOCAL            1 to build from a local Goose source checkout
                             instead of the managed clone (0 forces managed;
                             default: the lockfile's "local" field)
  GOOSE_BUILD_PROFILE        debug|release (default: debug)
  GOOSE_DEV_OPT_LEVEL        opt-level when GOOSE_BUILD_PROFILE=debug (default: 1)
USAGE
}

action="build"
print_bin=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --print-bin)
      print_bin=1
      shift
      ;;
    --check-bin)
      action="check"
      print_bin=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

lock_file="${GOOSE_BACKEND_LOCK_FILE:-$default_lock_file}"

read_lock_field() {
  local field="$1"
  [[ -f "$lock_file" ]] || return 0
  python3 - "$lock_file" "$field" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as fh:
    value = json.load(fh).get(sys.argv[2], "")
print(value if value is not None else "")
PY
}

lock_repo="$(read_lock_field repo)"
lock_ref="$(read_lock_field ref)"
lock_commit="$(read_lock_field commit)"
lock_package="$(read_lock_field package)"
lock_bin="$(read_lock_field bin)"

mode="${GOOSE_DEV_MODE:-auto}"
clone_url="${GOOSE_DEV_CLONE_URL:-${lock_repo:-https://github.com/aaif-goose/goose.git}}"
remote="${GOOSE_DEV_REMOTE:-origin}"
pinned_ref="${GOOSE_DEV_REF:-${GOOSE_DEV_BRANCH:-${lock_ref:-main}}}"
pinned_commit="${GOOSE_DEV_COMMIT:-$lock_commit}"
goose_package="${GOOSE_DEV_PACKAGE:-${lock_package:-goose-cli}}"
goose_bin="${GOOSE_DEV_BIN:-${lock_bin:-goose}}"
goose_patch_dir="${GOOSE_DEV_PATCH_DIR:-$repo_root/patches/goose}"
allow_dirty="${GOOSE_DEV_ALLOW_DIRTY:-0}"
build_profile="${GOOSE_BUILD_PROFILE:-debug}"
if [[ "$build_profile" != "debug" && "$build_profile" != "release" ]]; then
  echo "GOOSE_BUILD_PROFILE must be debug or release, got: $build_profile" >&2
  exit 1
fi

log() { echo "[berd-goose-dev] $*" >&2; }

fail_or_skip() {
  local message="$1"
  if [[ "$mode" == "required" ]]; then
    echo "$message" >&2
    exit 1
  fi
  log "$message"
  if [[ "$action" == "check" ]]; then
    exit 2
  fi
  exit 0
}

# Resolve the managed checkout / cargo target / stamp paths via the shared
# helper so regenerate-sdk-schema.sh can land its build in the same target
# dir without a parallel copy of this logic.
#
# Pinning a dedicated cargo target dir keeps the managed upstream Goose
# checkout isolated from this repo's Tauri workspace. A dedicated target dir
# under the dev cache root preserves the shared-cache benefit across Berd
# worktrees (they still all hit the same location) without ever sharing with
# src-tauri or any other workspace that honours `$HOME/.cargo/config.toml`'s
# `[build] target-dir`.
# shellcheck source=lib/goose-dev-paths.sh
source "$script_dir/lib/goose-dev-paths.sh"
export CARGO_TARGET_DIR="$goose_cargo_target_dir"
# Validated here, before the export, because cargo parses
# CARGO_PROFILE_DEV_OPT_LEVEL while loading config — before it picks a profile.
# An invalid value therefore fails `cargo build --release` too, so an unchecked
# typo would break the release lanes, which never read [profile.dev]. The set
# is cargo's own ("must be `0`, `1`, `2`, `3`, `s` or `z`").
if [[ ! "$goose_dev_opt_level" =~ ^(0|1|2|3|s|z)$ ]]; then
  echo "GOOSE_DEV_OPT_LEVEL must be 0, 1, 2, 3, s, or z, got: $goose_dev_opt_level" >&2
  exit 1
fi
# Optimized frames keep goose's deep OAuth-discovery descent inside the tokio
# worker stack (goose-dev-paths.sh has the full why). Exported as an env var
# so it wins over any [profile.dev] settings in the checkout's Cargo.toml.
# Release builds compile under [profile.release] and ignore it.
export CARGO_PROFILE_DEV_OPT_LEVEL="$goose_dev_opt_level"

# bin_path is computed after the checkout exists, via `cargo metadata`, so it
# matches CARGO_TARGET_DIR exactly (and would also honour any user override).
bin_path=""

resolve_ref_to_commit() {
  local ref="$1"
  git -C "$goose_repo" ls-remote "$remote" "$ref" 2>/dev/null | awk 'NR == 1 { print $1 }'
}

declare -a goose_patch_files=()
if [[ -d "$goose_patch_dir" ]]; then
  while IFS= read -r patch_file; do
    goose_patch_files+=("$patch_file")
  done < <(find "$goose_patch_dir" -maxdepth 1 -type f -name '*.patch' | sort)
fi

goose_patch_fingerprint="$(
  python3 - "$goose_patch_dir" <<'PY'
import glob
import hashlib
import os
import sys

root = sys.argv[1]
paths = sorted(glob.glob(os.path.join(root, "*.patch"))) if os.path.isdir(root) else []
if not paths:
    print("none")
    raise SystemExit

digest = hashlib.sha256()
for path in paths:
    name = os.path.basename(path).encode("utf-8")
    with open(path, "rb") as handle:
        data = handle.read()
    digest.update(name)
    digest.update(b"\0")
    digest.update(str(len(data)).encode("ascii"))
    digest.update(b"\0")
    digest.update(data)
    digest.update(b"\0")
print(digest.hexdigest())
PY
)"

goose_patches_already_applied() {
  ((${#goose_patch_files[@]} > 0)) || return 1
  local patch_file
  for patch_file in "${goose_patch_files[@]}"; do
    git -C "$goose_repo" apply --reverse --check "$patch_file" >/dev/null 2>&1 || return 1
  done
}

apply_goose_patches() {
  ((${#goose_patch_files[@]} > 0)) || return 0
  local patch_file
  for patch_file in "${goose_patch_files[@]}"; do
    log "Applying Goose patch $(basename "$patch_file")."
    git -C "$goose_repo" apply --whitespace=nowarn "$patch_file" >/dev/null 2>&1 || {
      fail_or_skip "Failed to apply Goose patch $patch_file to managed checkout at $goose_repo."
    }
  done
}

# Ask cargo where it will actually write the binary. With CARGO_TARGET_DIR
# exported above, this is deterministic; we still go through `cargo metadata`
# (rather than hard-coding the path) so the script and cargo can't disagree
# if anything else ever overrides the target directory.
resolve_bin_path() {
  local target_dir
  target_dir="$(cd "$goose_repo" && cargo metadata --no-deps --format-version 1 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("target_directory",""))')"
  if [[ -z "$target_dir" ]]; then
    target_dir="${goose_repo}/target"
  fi
  printf '%s/%s/%s\n' "$target_dir" "$build_profile" "$goose_bin"
}

write_stamp() {
  local ref_name="$1"
  local commit_sha="$2"
  mkdir -p "$(dirname "$goose_stamp_file")"
  {
    printf 'STAMP_REPO=%q\n' "$goose_repo"
    printf 'STAMP_LOCK_FILE=%q\n' "$lock_file"
    printf 'STAMP_REF=%q\n' "$ref_name"
    printf 'STAMP_COMMIT=%q\n' "$commit_sha"
    printf 'STAMP_PACKAGE=%q\n' "$goose_package"
    printf 'STAMP_BIN_NAME=%q\n' "$goose_bin"
    printf 'STAMP_PATCH_FINGERPRINT=%q\n' "$goose_patch_fingerprint"
    printf 'STAMP_BUILD_PROFILE=%q\n' "$build_profile"
    printf 'STAMP_OPT_LEVEL=%q\n' "$goose_dev_opt_level"
    printf 'STAMP_BIN=%q\n' "$bin_path"
  } >"$goose_stamp_file"
}

stamp_matches_current_build() {
  [[ -f "$goose_stamp_file" ]] || return 1
  # shellcheck disable=SC1090
  source "$goose_stamp_file"
  [[ "${STAMP_REPO:-}" == "$goose_repo" ]] || return 1
  [[ "${STAMP_REF:-${STAMP_BRANCH:-}}" == "$pinned_ref" ]] || return 1
  [[ "${STAMP_COMMIT:-}" == "$pinned_commit" ]] || return 1
  [[ "${STAMP_PACKAGE:-$goose_package}" == "$goose_package" ]] || return 1
  [[ "${STAMP_BIN_NAME:-$goose_bin}" == "$goose_bin" ]] || return 1
  [[ "${STAMP_PATCH_FINGERPRINT:-none}" == "$goose_patch_fingerprint" ]] || return 1
  [[ "${STAMP_BUILD_PROFILE:-}" == "$build_profile" ]] || return 1
  # A stamp without STAMP_OPT_LEVEL predates the opt-level knob, meaning its
  # binary was built at cargo's dev default (0). Default the comparison to 0 —
  # not to the current value — so those binaries fail the match and rebuild.
  # Only debug builds read [profile.dev], so release stamps skip the check
  # rather than paying a rebuild for a knob their binary never saw.
  if [[ "$build_profile" == "debug" ]]; then
    [[ "${STAMP_OPT_LEVEL:-0}" == "$goose_dev_opt_level" ]] || return 1
  fi
  [[ -x "${STAMP_BIN:-}" ]] || return 1
  # The recorded binary path must match where cargo writes today; otherwise
  # the user's cargo config (e.g. build.target-dir) changed and the stamp is
  # pointing at a fossil binary that no rebuild will refresh.
  [[ "${STAMP_BIN:-}" == "$bin_path" ]] || return 1
  local local_head
  local_head="$(git -C "$goose_repo" rev-parse HEAD)"
  [[ "${STAMP_COMMIT:-}" == "$local_head" ]] || return 1
}

ensure_checkout_exists() {
  if [[ -d "$goose_repo/.git" ]]; then
    return 0
  fi
  if [[ "$action" == "check" ]]; then
    fail_or_skip "Managed goose checkout not found at $goose_repo. Rerun just setup."
  fi
  log "Cloning managed goose checkout into $goose_repo."
  mkdir -p "$(dirname "$goose_repo")"
  git clone "$clone_url" "$goose_repo" >/dev/null 2>&1 || {
    fail_or_skip "Failed to clone managed goose checkout from $clone_url into $goose_repo."
  }
}

# ── Local source mode ────────────────────────────────────────────────────────
# GOOSE_DEV_LOCAL=1, or "local": true in the lockfile, builds Goose out of a
# checkout the developer owns: "localRepo" in the lockfile, or GOOSE_DEV_REPO.
# A relative path resolves against this repo's parent, so a sibling checkout
# (../distill-goose) works on any machine without hardcoding a path. Nothing is
# fetched, reset, or patched there — whatever is checked out is what gets
# built, so editing Goose sources and rebuilding picks the change up. Readiness
# is never reused from the stamp either, because a working tree changes without
# the commit changing; cargo's own incremental build keeps the no-op case cheap.
lock_local="$(read_lock_field local)"
lock_local_repo="$(read_lock_field localRepo)"
local_source="${GOOSE_DEV_LOCAL:-}"
if [[ -z "$local_source" ]]; then
  case "$lock_local" in
    True | true | 1) local_source=1 ;;
    *) local_source=0 ;;
  esac
fi

if [[ "$local_source" == "1" ]]; then
  local_repo="${GOOSE_DEV_REPO:-$lock_local_repo}"
  if [[ -z "$local_repo" ]]; then
    echo "Local Goose source mode is enabled but no checkout path is set. Set GOOSE_DEV_REPO or 'localRepo' in $lock_file." >&2
    exit 1
  fi
  if [[ "$local_repo" != /* ]]; then
    local_repo="$(cd "$(dirname "$repo_root")" && cd "$local_repo" 2>/dev/null && pwd)" ||
      fail_or_skip "Local Goose source checkout not found at $(dirname "$repo_root")/$local_repo."
  fi
  goose_repo="$local_repo"
  [[ -d "$goose_repo/.git" ]] ||
    fail_or_skip "Local Goose source checkout not found at $goose_repo."

  bin_path="$(resolve_bin_path)"

  if [[ "$action" == "check" ]]; then
    [[ -x "$bin_path" ]] ||
      fail_or_skip "Local Goose binary has not been built from $goose_repo yet. Rerun just setup."
    if [[ "$print_bin" == "1" ]]; then
      printf '%s\n' "$bin_path"
    fi
    exit 0
  fi

  head_commit="$(git -C "$goose_repo" rev-parse HEAD)"
  log "Building Goose from local source at $goose_repo (HEAD $head_commit); fetch, reset, and patching are skipped."
  # No --locked here, unlike the managed path: this is a tree the developer
  # edits, so a Cargo.toml change that needs a lockfile refresh is expected
  # rather than a sign that the pinned commit was tampered with.
  cargo_args=(build)
  [[ "$build_profile" == "release" ]] && cargo_args+=(--release)
  cargo_args+=(-p "$goose_package" --bin "$goose_bin")
  (cd "$goose_repo" && cargo "${cargo_args[@]}")
  [[ -x "$bin_path" ]] || {
    echo "Expected Goose binary at $bin_path, but it was not built." >&2
    exit 1
  }
  write_stamp "${pinned_ref:-local}" "$head_commit"
  log "Local Goose binary ready at $bin_path."
  if [[ "$print_bin" == "1" ]]; then
    printf '%s\n' "$bin_path"
  fi
  exit 0
fi

ensure_checkout_exists

bin_path="$(resolve_bin_path)"

if [[ "$allow_dirty" != "1" && -n "$(git -C "$goose_repo" status --porcelain)" ]] &&
  ! goose_patches_already_applied; then
  fail_or_skip "Managed goose checkout at $goose_repo is dirty. Use a dedicated checkout or set GOOSE_DEV_ALLOW_DIRTY=1."
fi

if [[ "$action" == "check" ]]; then
  stamp_matches_current_build || fail_or_skip "Local Goose binary is not ready for $pinned_ref at $pinned_commit. Rerun just setup."
  [[ "$print_bin" == "1" ]] && printf '%s\n' "$STAMP_BIN"
  exit 0
fi

if [[ -z "$pinned_commit" ]]; then
  pinned_commit="$(resolve_ref_to_commit "$pinned_ref")"
  [[ -n "$pinned_commit" ]] || fail_or_skip "Could not resolve Goose ref $remote/$pinned_ref for managed checkout at $goose_repo."
fi

if stamp_matches_current_build; then
  log "Local Goose binary already matches $pinned_ref at $pinned_commit."
  if [[ "$print_bin" == "1" ]]; then
    printf '%s\n' "$STAMP_BIN"
  fi
  exit 0
fi

log "Fetching pinned Goose ref $pinned_ref."
git -C "$goose_repo" fetch "$remote" "$pinned_ref" >/dev/null 2>&1 || {
  log "Direct fetch of $pinned_ref failed; fetching all remote heads and tags."
  git -C "$goose_repo" fetch "$remote" --tags '+refs/heads/*:refs/remotes/'"${remote}"'/*' >/dev/null 2>&1 || {
    fail_or_skip "Failed to fetch Goose ref $pinned_ref from $remote."
  }
}

if ! git -C "$goose_repo" cat-file -e "${pinned_commit}^{commit}" 2>/dev/null; then
  fail_or_skip "Pinned Goose commit $pinned_commit is not available after fetching $pinned_ref."
fi

git -C "$goose_repo" checkout --detach "$pinned_commit" >/dev/null 2>&1
git -C "$goose_repo" reset --hard "$pinned_commit" >/dev/null 2>&1
apply_goose_patches

log "Building Goose from $goose_repo at $pinned_commit."
# --locked keeps the build on the pinned commit's Cargo.lock. Release bundles
# opt into Cargo's optimized profile; development keeps the faster debug build.
cargo_args=(build --locked)
[[ "$build_profile" == "release" ]] && cargo_args+=(--release)
cargo_args+=(-p "$goose_package" --bin "$goose_bin")
(cd "$goose_repo" && cargo "${cargo_args[@]}")
[[ -x "$bin_path" ]] || { echo "Expected Goose binary at $bin_path, but it was not built." >&2; exit 1; }
write_stamp "$pinned_ref" "$(git -C "$goose_repo" rev-parse HEAD)"
log "Local Goose binary ready at $bin_path."
if [[ "$print_bin" == "1" ]]; then
  printf '%s\n' "$bin_path"
fi
