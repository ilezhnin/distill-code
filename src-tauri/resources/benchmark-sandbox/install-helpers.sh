#!/bin/bash
# Reviewed, network-free update. Never terminates another WSL distribution.
set -euo pipefail
src=${1:?trusted helper staging directory required}
[[ $EUID == 0 && $src =~ ^/tmp/distill-helper-update\.[A-Za-z0-9_-]+$ ]] || exit 64
[[ -d $src && ! -L $src && $(stat -c %u "$src") == 0 ]] || exit 77
for group in /sys/fs/cgroup/distill-bench/*/; do
  [[ -d $group ]] || continue
  [[ $(basename "$group") == control ]] && continue
  [[ -z $(cat "$group/cgroup.procs") ]] || {
    echo 'resource_busy: benchmark jobs must drain before updating sandbox helpers' >&2; exit 75;
  }
done
# Validate every source before publishing any helper. Old code is backed up
# for recovery; selected credentials and refresh evidence are not copied out.
for script in bench-auth bench-budget bench-net bench-network bench-run bench-run-inner bench-enter bench-copy bench-digest \
  bench-patch bench-artifact bench-check-prep bench-kill bench-clean bench-status bench-login bench-judge \
  bench-unpack bench-browser; do
  [[ -f $src/$script && ! -L $src/$script ]] || exit 66
  if [[ $(head -n 1 "$src/$script") == '#!/usr/bin/python3' ]]; then
    python3 -c 'import ast,sys;ast.parse(open(sys.argv[1]).read())' "$src/$script"
  else
    bash -n "$src/$script"
  fi
done
backup=/var/lib/distill-bench/helper-backups/$(date +%s%N)
install -d -m 700 "$backup"
for file in /usr/local/sbin/bench-*; do [[ ! -f $file ]] || cp -p "$file" "$backup/"; done
for script in bench-auth bench-budget bench-net bench-network bench-run bench-run-inner bench-enter bench-copy bench-digest \
  bench-patch bench-artifact bench-check-prep bench-kill bench-clean bench-status bench-login bench-judge \
  bench-unpack bench-browser; do
  install -o root -g root -m 755 "$src/$script" "/usr/local/sbin/$script.new"
  mv -f "/usr/local/sbin/$script.new" "/usr/local/sbin/$script"
done
install -d -m 755 /usr/local/lib/distill /opt/distill-browser
install -d -m 755 /workspace /submission
[[ -d /var/tmp ]] || install -d -m 1777 /var/tmp
install -o root -g root -m 644 "$src/benchmark-browser-worker.mjs" /usr/local/lib/distill/benchmark-browser-worker.mjs
install -o root -g root -m 644 "$src/browser-runtime.json" /opt/distill-browser/runtime.json
/usr/local/sbin/bench-budget mount-scratch
# New helpers may set new limits: bench-net runs its whole setup again.
rm -f /run/distill-bench-net.ready
/usr/local/sbin/bench-net
/usr/local/sbin/bench-budget status
echo "Retained helper backup at $backup" >&2
