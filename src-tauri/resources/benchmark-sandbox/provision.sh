#!/bin/bash
# provision.sh: run as root inside the distill-bench distribution with this
# folder unpacked at /tmp/distill-provision. Installs the sandbox files,
# the two unprivileged users, the attempt folders and the provider tools.
# Safe to run again: it replaces the files and tools and keeps the users'
# sign-ins.
#
#   provision.sh                 everything
#   provision.sh --tools ID...   only those provider tools (and the
#                                launchers and receipts of every tool);
#                                helpers, users and the browser stay as they are
#
# tools/<id>/package.json and package-lock.json come from Distill's
# acp-tools.lock.json; tools/<id>/spec names a package to install by exact
# version when there is no lock (Kimi Code, Grok, OpenCode for Z.ai).
set -euo pipefail
src=/tmp/distill-provision
only=()
if [[ ${1:-} == --tools ]]; then
  shift
  only=("$@")
  ((${#only[@]})) || { echo "provision.sh: --tools needs at least one tool" >&2; exit 64; }
fi
selected() { ((${#only[@]} == 0)) || [[ " ${only[*]} " == *" $1 "* ]]; }
export DEBIAN_FRONTEND=noninteractive
tools=/opt/distill-tools
if ((${#only[@]} == 0)); then
  if ! command -v iptables >/dev/null || ! command -v git >/dev/null; then
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends git iptables ca-certificates curl xz-utils python3 e2fsprogs util-linux >/dev/null
  fi
  for script in bench-auth bench-budget bench-net bench-network bench-run bench-run-inner bench-enter bench-copy bench-patch bench-artifact bench-check-prep \
    bench-kill bench-clean bench-status bench-login bench-judge bench-unpack bench-browser; do
    install -o root -g root -m 755 "$src/$script" "/usr/local/sbin/$script"
  done
  install -o root -g root -m 644 "$src/wsl.conf" /etc/wsl.conf
  if [[ -L /etc/resolv.conf || ! -s /etc/resolv.conf ]]; then
    rm -f /etc/resolv.conf
    printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' >/etc/resolv.conf
  fi
  for user in candidate checker; do
    id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$user"
    if id -nG "$user" | grep -qw sudo; then gpasswd -d "$user" sudo; fi
    chmod 700 "/home/$user"
  done
  install -d -o candidate -g candidate -m 700 /home/candidate/accounts
  install -d -o root -g root -m 700 /srv/bench /srv/bench/work /srv/bench/base \
    /srv/bench/checks /srv/bench/staging /srv/bench/probes /srv/bench/pairs /srv/bench/submissions /srv/bench/artifacts
  install -d -o root -g root -m 755 /workspace
  install -d -o root -g root -m 755 /submission
  /usr/local/sbin/bench-budget mount-scratch
  /usr/local/sbin/bench-net
fi

# Ripgrep for OpenCode's grep and glob tools: the release OpenCode itself
# downloads when none is on its PATH, pinned by digest. It lives in the Z.ai
# tool folder, on the PATH of Z.ai sessions alone, so no other provider's
# tool environment changes.
rg_url=https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz
rg_sha256=1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599

# Provider tools, readable by everyone, writable by root only.
install -d -o root -g root -m 755 "$tools" "$tools/bin"
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
for dir in "$src"/tools/*/; do
  id=$(basename "$dir")
  selected "$id" || continue
  target=$tools/$id
  rm -rf "$target.new"
  install -d -m 755 "$target.new"
  if [[ -f $dir/package-lock.json ]]; then
    cp "$dir/package.json" "$dir/package-lock.json" "$target.new/"
    (cd "$target.new" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  else
    (cd "$target.new" && echo '{"private":true}' >package.json &&
      npm install --omit=dev --no-audit --no-fund --loglevel=error --save-exact "$(cat "$dir/spec")")
  fi
  if [[ $id == zai ]]; then
    archive=$(mktemp)
    curl -fsSL --proto '=https' --retry 3 -o "$archive" "$rg_url"
    echo "$rg_sha256  $archive" | sha256sum -c --quiet
    install -d -m 755 "$target.new/bin"
    tar -xzf "$archive" -C "$target.new/bin" --strip-components=1 --no-same-owner \
      ripgrep-15.1.0-x86_64-unknown-linux-musl/rg
    rm -f "$archive"
    chmod 755 "$target.new/bin/rg"
  fi
  rm -rf "$target"
  mv "$target.new" "$target"
  chmod -R a+rX,go-w "$target"
done

# Launchers on the sandbox PATH. Each is replaced whole, so a session that
# starts one meanwhile runs the old or the new file, never half of one.
launcher() {
  printf '#!/bin/sh\nexec %s "$@"\n' "$2" >"$tools/bin/.$1.new"
  chmod 755 "$tools/bin/.$1.new"
  mv -f "$tools/bin/.$1.new" "$tools/bin/$1"
}
nm=$tools/claude-acp/node_modules
[[ -d $nm ]] && launcher claude-agent-acp \
  "/usr/local/bin/node $nm/@agentclientprotocol/claude-agent-acp/dist/index.js"
[[ -d $nm ]] && launcher claude "$nm/@anthropic-ai/claude-agent-sdk-linux-x64/claude"
nm=$tools/codex-acp/node_modules
[[ -d $nm ]] && launcher codex-acp "/usr/local/bin/node $nm/@agentclientprotocol/codex-acp/dist/index.js"
[[ -d $nm ]] && launcher codex "$nm/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"
nm=$tools/kimi/node_modules
[[ -d $nm ]] && launcher kimi "/usr/local/bin/node $nm/@moonshot-ai/kimi-code/dist/main.mjs"
nm=$tools/grok/node_modules
# The package's postinstall unpacks the native binary next to its shim.
[[ -x $nm/@xai-official/grok/bin/grok-native ]] && launcher grok "$nm/@xai-official/grok/bin/grok-native"
nm=$tools/zai/node_modules
# The x64 glibc build Distill runs on Windows as opencode-windows-x64.
[[ -x $nm/opencode-linux-x64/bin/opencode ]] && launcher opencode "$nm/opencode-linux-x64/bin/opencode"

# What bench-status reports: each tool's version and the digests of the
# files its runtime identity rests on. Only provisioned tools carry a
# package.json; other folders under $tools (toolchains that task preparation
# installs later) are not part of the identity and are skipped.
for dir in "$tools"/*/; do
  id=$(basename "$dir")
  [[ $id == bin ]] && continue
  [[ -f $dir/package.json ]] || continue
  {
    version=$(node -e 'const l=require(process.argv[1]);const d=l.dependencies||{};console.log(Object.entries(d).map(([k,v])=>k+"@"+v).join(","))' "$dir/package.json")
    echo "$id version $version"
    for name in $(ls "$tools/bin"); do
      target=$(sed -n 's/^exec \(.*\) "\$@"$/\1/p' "$tools/bin/$name" | awk '{print $NF}')
      case $target in "$dir"*) echo "$id file $name $(sha256sum "$target" | cut -d' ' -f1)" ;; esac
    done
  } >"$dir/manifest.new"
  mv -f "$dir/manifest.new" "$dir/manifest"
done
if ((${#only[@]})); then
  rm -rf "$src"
  echo "Installed ${only[*]}; run the Linux text policy probe for each before measuring"
  exit 0
fi
bash "$src/browser-provision" "$src"
rm -rf "$src"
echo "Installed; browser readiness requires a host provision-receipt with fresh resource admission"
