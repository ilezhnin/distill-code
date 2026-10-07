#!/bin/bash
# selftest.sh: run as root inside distill-bench. Checks from inside what a
# run can and cannot reach; prints one PASS or FAIL line per property and
# exits non-zero on any FAIL.
set -u
failed=0
check() {
  if [[ $2 == "$3" ]]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; failed=1; fi
}
run() { /usr/local/sbin/bench-run "$@" 2>/dev/null; }
gateway=$(ip route | awk '/default/ {print $3}')

check "boot initialized network" "$(ip netns exec bench ip -4 route show default 2>/dev/null | grep -c 'via 10.231.0.1')" 1
check "boot enabled resource controllers" "$(grep -w memory /sys/fs/cgroup/distill-bench/cgroup.subtree_control | grep -w pids >/dev/null && echo ready)" ready
check "runs as the candidate" "$(run login selftest -- id -un)" candidate
check "no Windows drive" "$(run login selftest -- ls -A /mnt)" ""
check "no WSL GUI socket" "$(run login selftest -- bash -c '[ -e /mnt/wslg ] && echo seen')" ""
check "no Windows program" "$(run login selftest -- bash -c 'command -v cmd.exe powershell.exe wsl.exe')" ""
check "other attempts hidden" "$(run login selftest -- bash -c 'ls /srv/bench >/dev/null 2>&1 && echo seen')" ""
check "private process namespace" "$(run login selftest -- bash -c 'test $$ = 1 && echo own')" own
check "no root files" "$(run login selftest -- bash -c 'cat /etc/shadow >/dev/null 2>&1 && echo read')" ""
check "no privilege gain" "$(run login selftest -- bash -c 'sudo -n true >/dev/null 2>&1 && echo root')" ""
check "clean environment" "$(run login selftest -- env | cut -d= -f1 | sort | tr '\n' ' ')" \
  "HOME LANG LOGNAME PATH USER "
check "public internet" "$(run login selftest -- curl -s -o /dev/null -w '%{http_code}' -m 15 https://api.anthropic.com/ | grep -c '^[1-5][0-9][0-9]$')" 1
check "public DNS" "$(run login selftest -- bash -c 'getent hosts api.openai.com >/dev/null && echo ok')" ok
check "no Windows host" "$(run login selftest -- curl -s -m 5 "http://$gateway:445/" >/dev/null; echo $?)" 7
check "no WSL DNS tunnel" "$(run login selftest -- bash -c 'timeout 5 bash -c "exec 3<>/dev/tcp/10.255.255.254/53" 2>/dev/null && echo open')" ""
check "no local network" "$(run login selftest -- bash -c 'timeout 5 bash -c "exec 3<>/dev/tcp/192.168.1.1/80" 2>/dev/null && echo open')" ""
check "no VM services" "$(run login selftest -- bash -c 'timeout 5 bash -c "exec 3<>/dev/tcp/10.231.0.1/22" 2>/dev/null && echo open')" ""

printf 'one\n' >/tmp/selftest-file
tar -cf /tmp/selftest.tar -C /tmp selftest-file
/usr/local/sbin/bench-copy selftest-a </tmp/selftest.tar >/dev/null
/usr/local/sbin/bench-copy selftest-b </tmp/selftest.tar >/dev/null
check "copy is one commit" "$(run session selftest-a -- git log --oneline | wc -l)" 1
run session selftest-a -- bash -c 'echo two >>selftest-file; echo new >added; rm -rf .git' >/dev/null
check "answer read past a removed .git" "$(/usr/local/sbin/bench-patch selftest-a | grep -c '^diff --git')" 2
check "untouched copy has no answer" "$(/usr/local/sbin/bench-patch selftest-b | wc -c)" 0
check "own /tmp" "$(run session selftest-b -- ls -A /tmp)" ""
check "private candidate home" "$(run session selftest-b -- ls -A /home/candidate)" ""
check "session public internet" "$(run session selftest-b -- curl -s -o /dev/null -w '%{http_code}' -m 15 https://api.anthropic.com/ | grep -c '^[1-5][0-9][0-9]$')" 1
( run session selftest-a -- python3 -m http.server 41981 --bind 127.0.0.1 >/dev/null & ) 2>/dev/null
sleep 1
check "own local server" "$(run session selftest-a -- curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:41981/)" 200
check "other attempt cannot reach local server" "$(run session selftest-b -- curl -s -m 3 http://127.0.0.1:41981/ >/dev/null; echo $?)" 7
/usr/local/sbin/bench-kill session selftest-a
( run session selftest-a -- bash -c 'setsid sleep 600 & sleep 600' >/dev/null & ) 2>/dev/null
sleep 2
/usr/local/sbin/bench-kill session selftest-a
sleep 1
check "kill ends detached processes" "$(pgrep -u candidate -c sleep)" 0

mkdir -p /tmp/selftest-check/snapshot /tmp/selftest-check/hidden
cp /tmp/selftest-file /tmp/selftest-check/snapshot/
/usr/local/sbin/bench-patch selftest-a >/tmp/selftest-check/answer.patch
printf 'grep -q two selftest-file && test -f added\n' >/tmp/selftest-check/hidden/check.sh
tar -cf /tmp/selftest-check.tar -C /tmp/selftest-check .
/usr/local/sbin/bench-check-prep selftest-a </tmp/selftest-check.tar >/dev/null
check "check runs as the checker" "$(run check selftest-a -- id -un)" checker
check "check sees the answer and its files" "$(run check selftest-a -- bash check.sh && echo pass)" pass
check "check has no network" "$(run check selftest-a -- curl -s -m 5 https://api.anthropic.com/ >/dev/null; echo $?)" 6

# Synthetic sign-in data only: no real credential is read or changed.
auth_account=$(mktemp -d /home/candidate/accounts/selftest-auth-XXXXXXXX)
auth_home=$auth_account/codex
install -d -m 700 -o candidate -g candidate "$auth_home"
printf '{"token":"original"}\n' >"$auth_home/auth.json"
printf 'previous answer\n' >"$auth_home/history.txt"
chown candidate:candidate "$auth_home/auth.json" "$auth_home/history.txt"
check "account history is not mounted" "$(run session selftest-a "DISTILL_BENCH_ACCOUNT_HOME=$auth_home" -- bash -c '
  test ! -e /tmp/provider/history.txt || exit 1
  printf marker >/tmp/provider/previous-attempt
  printf "{\"token\":\"refreshed\"}\n" >/tmp/provider/auth.json
  echo private
')" private
/usr/local/sbin/bench-kill session selftest-a
/usr/local/sbin/bench-clean selftest-a
check "OAuth refresh survives a stopped attempt" "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["token"])' "$auth_home/auth.json")" refreshed
check "arbitrary provider files are not persisted" "$(test -e "$auth_home/previous-attempt" && echo leaked)" ""
check "next attempt cannot read previous state" "$(run session selftest-b "DISTILL_BENCH_ACCOUNT_HOME=$auth_home" -- bash -c '
  test ! -e /tmp/provider/history.txt && test ! -e /tmp/provider/previous-attempt && echo private
')" private
/usr/local/sbin/bench-kill session selftest-b

# A stale or linked credential must never overwrite the selected account.
/usr/local/sbin/bench-auth prepare selftest-auth-a "$auth_home"
/usr/local/sbin/bench-auth prepare selftest-auth-b "$auth_home"
printf '{"token":"first"}\n' >/srv/bench/auth/selftest-auth-a/home/auth.json
printf '{"token":"second"}\n' >/srv/bench/auth/selftest-auth-b/home/auth.json
/usr/local/sbin/bench-auth save selftest-auth-a
check "concurrent refresh refuses a stale overwrite" "$(/usr/local/sbin/bench-auth save selftest-auth-b >/dev/null 2>&1; echo $?)" 70
rm /srv/bench/auth/selftest-auth-b/home/auth.json
ln -s "$auth_home/auth.json" /srv/bench/auth/selftest-auth-b/home/auth.json
check "credential links are refused" "$(/usr/local/sbin/bench-auth save selftest-auth-b >/dev/null 2>&1; echo $?)" 70
check "refused refresh preserves the newer credential" "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["token"])' "$auth_home/auth.json")" first
rm -rf /srv/bench/auth/selftest-auth-a /srv/bench/auth/selftest-auth-b

kimi_home=$auth_account/kimi
install -d -m 700 -o candidate -g candidate "$kimi_home/credentials"
printf 'default_provider = "test"\n' >"$kimi_home/config.toml"
printf '{"access_token":"original","refresh_token":"original","expires_at":100}\n' >"$kimi_home/credentials/kimi-code.json"
for item in a b; do /usr/local/sbin/bench-auth prepare "selftest-kimi-$item" "$kimi_home"; done
printf '{"access_token":"older","refresh_token":"older","expires_at":200}\n' >/srv/bench/auth/selftest-kimi-a/home/credentials/kimi-code.json
printf '{"access_token":"newer","refresh_token":"newer","expires_at":300}\n' >/srv/bench/auth/selftest-kimi-b/home/credentials/kimi-code.json
/usr/local/sbin/bench-auth save selftest-kimi-b
check "older Kimi refresh settles without an overwrite" "$(/usr/local/sbin/bench-auth save selftest-kimi-a; echo $?)" 0
check "newest Kimi refresh is retained" "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["expires_at"])' "$kimi_home/credentials/kimi-code.json")" 300
for item in a b; do /usr/local/sbin/bench-clean "selftest-kimi-$item"; done
for item in a b; do /usr/local/sbin/bench-auth prepare "selftest-kimi-$item" "$kimi_home"; done
printf '{"access_token":"newer","refresh_token":"newer","expires_at":500}\n' >/srv/bench/auth/selftest-kimi-a/home/credentials/kimi-code.json
printf '{"access_token":"older","refresh_token":"older","expires_at":400}\n' >/srv/bench/auth/selftest-kimi-b/home/credentials/kimi-code.json
/usr/local/sbin/bench-auth save selftest-kimi-b
/usr/local/sbin/bench-auth save selftest-kimi-a
check "newer Kimi refresh replaces an older completed grant" "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["expires_at"])' "$kimi_home/credentials/kimi-code.json")" 500
for item in a b; do /usr/local/sbin/bench-clean "selftest-kimi-$item"; done
/usr/local/sbin/bench-clean selftest-a
/usr/local/sbin/bench-clean selftest-b
rm -rf "$auth_account"
rm -rf /tmp/selftest-file /tmp/selftest.tar /tmp/selftest-check /tmp/selftest-check.tar
check "clean leaves nothing" "$(ls /srv/bench/work /srv/bench/base /srv/bench/checks /srv/bench/auth | grep -c selftest)" 0
exit $failed
