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

/usr/local/sbin/bench-clean selftest-a
/usr/local/sbin/bench-clean selftest-b
rm -rf /tmp/selftest-file /tmp/selftest.tar /tmp/selftest-check /tmp/selftest-check.tar
check "clean leaves nothing" "$(ls /srv/bench/work /srv/bench/base /srv/bench/checks | grep -c selftest)" 0
exit $failed
