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
# Host evidence has five fields; a script still sending the old four is refused.
gate4=$(printf '%s' "${DISTILL_BENCH_HOST_GATE:-0,0,0,0,0}" | cut -d, -f1-4)
check "four-field host gate refused as an argument" "$(/usr/local/sbin/bench-run login selftest "DISTILL_BENCH_HOST_GATE=$gate4" -- true 2>/dev/null; echo $?)" 64
check "four-field host gate refused in the environment" "$(DISTILL_BENCH_HOST_GATE=$gate4 /usr/local/sbin/bench-run login selftest -- true 2>&1 >/dev/null | grep -c 'fresh Windows headroom evidence')" 1

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

# Snapshot cache: an archive is kept only once it holds its tree, a copy or
# check from it is that snapshot, and no run ever sees it.
deadline=$(( $(date +%s%3N) + 100000 ))
tree=$(git --git-dir=/srv/bench/base/selftest-b/.git rev-parse 'HEAD^{tree}')
fake=$(printf '%040d' 7)
rm -f "/srv/bench/cache/$tree.tar"
check "uncached snapshot is a miss" "$(/usr/local/sbin/bench-copy selftest-c "$deadline" "$tree" </dev/null 2>/dev/null; echo "exit $?")" "not cached $tree
exit 3"
check "a miss leaves no copy" "$(ls /srv/bench/work /srv/bench/base | grep -c selftest-c)" 0
check "an archive without its tree is refused" "$(/usr/local/sbin/bench-copy selftest-c "$deadline" "$fake" - </tmp/selftest.tar 2>&1 >/dev/null | grep -c 'does not hold its published tree')" 1
check "a refused archive leaves nothing" "$(ls -A /srv/bench/work /srv/bench/cache | grep -c "selftest-c\|$fake")" 0
check "an archive holding its tree is cached" "$(/usr/local/sbin/bench-copy selftest-c "$deadline" "$tree" - </tmp/selftest.tar | tr '\n' ' ')" "cached $tree copied selftest-c "
check "snapshot cache is root only and read only" "$(stat -c '%u %a' /srv/bench/cache "/srv/bench/cache/$tree.tar" | tr '\n' ' ')" "0 700 0 400 "
check "cached copy" "$(/usr/local/sbin/bench-copy selftest-d "$deadline" "$tree" </dev/null)" "copied selftest-d"
check "cached copy is the snapshot's tree" "$(git --git-dir=/srv/bench/base/selftest-d/.git rev-parse 'HEAD^{tree}') $(stat -c %U /srv/bench/work/selftest-d)" "$tree candidate"
check "cached copy is one commit" "$(run session selftest-d -- git log --oneline | wc -l)" 1
check "sessions cannot see the snapshot cache" "$(run session selftest-d -- bash -c "ls -A /srv/bench; test -e /srv/bench/cache/$tree.tar && echo seen")" ""
install -m 400 /tmp/selftest.tar "/srv/bench/cache/$fake.tar"
check "a cache entry without its tree is never used" "$(/usr/local/sbin/bench-copy selftest-e "$deadline" "$fake" </dev/null 2>/dev/null; echo "exit $?"; test -e "/srv/bench/cache/$fake.tar" && echo kept)" "not cached $fake
exit 3"
install -m 400 /tmp/selftest.tar "/srv/bench/cache/$fake.tar"
touch -d '30 days ago' "/srv/bench/cache/$fake.tar"
/usr/local/sbin/bench-copy selftest-e "$deadline" "$tree" - </tmp/selftest.tar >/dev/null
check "unused cache entries are evicted" "$(test -e "/srv/bench/cache/$fake.tar" && echo kept)" ""
mkdir -p /tmp/selftest-cached/hidden
cp /tmp/selftest-check/answer.patch /tmp/selftest-cached/
cp /tmp/selftest-check/hidden/check.sh /tmp/selftest-cached/hidden/
tar -cf /tmp/selftest-cached.tar -C /tmp/selftest-cached .
check "check prepared from the cache" "$(/usr/local/sbin/bench-check-prep selftest-d "$tree" </tmp/selftest-cached.tar)" "prepared selftest-d"
check "cached check sees the answer and its files" "$(run check selftest-d -- bash check.sh && echo pass)" pass
check "check cannot see the snapshot cache" "$(run check selftest-d -- bash -c 'ls -A /srv/bench')" ""
check "uncached check is a miss and leaves nothing" "$(/usr/local/sbin/bench-check-prep selftest-f "$fake" </tmp/selftest-cached.tar 2>/dev/null; echo "exit $?"; ls /srv/bench/checks | grep -c selftest-f)" "not cached $fake
exit 3
0"
for item in c d e f; do /usr/local/sbin/bench-clean "selftest-$item"; done
rm -rf /tmp/selftest-cached /tmp/selftest-cached.tar "/srv/bench/cache/$tree.tar"

# Synthetic sign-in data only: no real credential is read or changed.
# This block also runs on the host with Python alone: it loads only helper
# function definitions, substitutes ownership operations, and uses temporary
# invented accounts. It never executes the helper's Linux command entrypoint.
python3 - /usr/local/sbin/bench-auth <<'BENCH_AUTH_UNIT_TESTS'
import ast
import contextlib
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
import tomllib
import types
import unittest


class TestOS:
    def __getattr__(self, name):
        return getattr(os, name)

    def chown(self, *args):
        pass


source = Path(sys.argv[1]).read_text(encoding="utf-8")
functions = [node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)]
scope = dict(Path=Path, os=TestOS(), stat=stat, json=json, re=re,
             hashlib=hashlib, tomllib=tomllib, LIMIT=1024 * 1024,
             CANDIDATE=types.SimpleNamespace(pw_uid=0, pw_gid=0))
exec(compile(ast.Module(body=functions, type_ignores=[]), "bench-auth-functions", "exec"), scope)


def claude(expiry, marker):
    return {"claudeAiOauth": {"accessToken": marker, "refreshToken": marker,
                             "expiresAt": expiry * 1000}}


def grok(expiry, marker, issuer="https://auth.x.ai::invented-client"):
    stamp = datetime.fromtimestamp(expiry, timezone.utc).isoformat().replace("+00:00", "Z")
    return {issuer: {"key": marker, "refresh_token": marker,
                     "auth_mode": "oidc", "expires_at": stamp}}


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name).resolve()
        scope["ROOT"] = root / "attempts"
        scope["ACCOUNTS"] = root / "accounts"
        scope["ROOT"].mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def account(self, provider, document):
        account = scope["ACCOUNTS"] / "invented-account" / provider
        account.mkdir(parents=True)
        filename = ".credentials.json" if provider == "claude" else "auth.json"
        target = account / filename
        target.write_text(json.dumps(document), encoding="utf-8")
        return account, target

    def prepare(self, account, target, attempt, document):
        scope["directory"] = scope["ROOT"] / attempt
        scope["prepare"](str(account))
        path = scope["directory"] / "home" / target.name
        path.write_text(json.dumps(document), encoding="utf-8")

    def save(self, attempt):
        scope["directory"] = scope["ROOT"] / attempt
        scope["save"]()

    def test_claude_and_grok_keep_newer_grants_in_both_completion_orders(self):
        for provider, document in (("claude", claude), ("grok", grok)):
            account, target = self.account(provider, document(100, "original"))
            for first, second in (("newer", "older"), ("older", "newer")):
                with self.subTest(provider=provider, first=first):
                    suffix = provider + first
                    target.write_text(json.dumps(document(100, "original")), encoding="utf-8")
                    self.prepare(account, target, "older" + suffix, document(200, "older"))
                    self.prepare(account, target, "newer" + suffix, document(300, "newer"))
                    self.save(first + suffix)
                    self.save(second + suffix)
                    self.assertEqual(json.loads(target.read_text()), document(300, "newer"))

    def test_a_renewal_session_saves_the_renewed_grok_grant_and_nothing_else(self):
        # The host's renewal session starts on the account's expired grant;
        # the Grok CLI writes the renewed one into the private copy.
        now = int(time.time())
        account, target = self.account("grok", grok(now - 600, "expired"))
        self.prepare(account, target, "renewal", grok(now + 21600, "renewed"))
        (scope["ROOT"] / "renewal" / "home" / "session.log").write_text("invented", encoding="utf-8")
        self.save("renewal")
        self.assertEqual(json.loads(target.read_text()), grok(now + 21600, "renewed"))
        self.assertFalse((account / "session.log").exists())
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            scope["account_status"](str(account))
        self.assertEqual(output.getvalue().splitlines(), [
            "account grok invented-account yes",
            f"account-health grok invented-account oauth current {(now + 21600) * 1000}",
        ])
        # A session whose CLI did not renew leaves the account as it was.
        self.prepare(account, target, "unrenewed", grok(now + 21600, "renewed"))
        self.save("unrenewed")
        self.assertEqual(json.loads(target.read_text()), grok(now + 21600, "renewed"))

    def test_equal_expiry_conflicts_preserve_stored_and_candidate_grants(self):
        for provider, document in (("claude", claude), ("grok", grok)):
            account, target = self.account(provider, document(100, "original"))
            self.prepare(account, target, provider + "a", document(200, "first"))
            self.prepare(account, target, provider + "b", document(200, "second"))
            self.save(provider + "a")
            with self.assertRaisesRegex(ValueError, "concurrent credential refresh"):
                self.save(provider + "b")
            self.assertEqual(json.loads(target.read_text()), document(200, "first"))
            retained = scope["ROOT"] / (provider + "b") / "home" / target.name
            self.assertEqual(json.loads(retained.read_text()), document(200, "second"))

    def test_malformed_refreshed_credentials_do_not_overwrite_account(self):
        for provider, document in (("claude", claude), ("grok", grok)):
            original = document(100, "original")
            account, target = self.account(provider, original)
            self.prepare(account, target, provider, {"unreadable": "invented-secret"})
            with self.assertRaisesRegex(ValueError, "unreadable refreshed credential"):
                self.save(provider)
            self.assertEqual(json.loads(target.read_text()), original)

    def test_grok_issuer_maximum_cannot_mask_a_regressing_grant(self):
        previous = grok(300, "newer-a", "a") | grok(100, "older-b", "b")
        updated = grok(200, "older-a", "a") | grok(400, "newer-b", "b")
        with self.assertRaisesRegex(ValueError, "concurrent credential refresh"):
            scope["prefer_refreshed_grant"]("grok", previous, updated)

    def test_grok_unchanged_issuer_does_not_hide_one_ordered_refresh(self):
        previous = grok(500, "same-a", "a") | grok(100, "old-b", "b")
        updated = grok(500, "same-a", "a") | grok(200, "new-b", "b")
        self.assertTrue(scope["prefer_refreshed_grant"]("grok", previous, updated))
        self.assertFalse(scope["prefer_refreshed_grant"]("grok", updated, previous))

    def test_changed_issuer_set_and_unreadable_expiry_fail_closed(self):
        previous = grok(100, "old", "a")
        for updated in (grok(200, "new", "b"),
                        {"a": {"key": "new", "expires_at": "invalid-invented-secret"}}):
            with self.subTest(updated=bool(updated)):
                with self.assertRaisesRegex(ValueError, "concurrent credential refresh"):
                    scope["prefer_refreshed_grant"]("grok", previous, updated)

    def test_unknown_or_equal_claude_expiry_is_not_a_refresh_order(self):
        for expiry in ("invalid-invented-secret", True, None):
            updated = claude(200, "new")
            updated["claudeAiOauth"]["expiresAt"] = expiry
            with self.assertRaisesRegex(ValueError, "concurrent credential refresh"):
                scope["prefer_refreshed_grant"]("claude", claude(100, "old"), updated)

    def test_local_health_distinguishes_current_expired_and_unknown(self):
        for provider, document in (("claude", claude), ("grok", grok)):
            self.assertEqual(scope["local_credential_health"](provider, document(200, "key"), 150000),
                             ("oauth", "current", 200000))
            self.assertEqual(scope["local_credential_health"](provider, document(100, "key"), 150000),
                             ("oauth", "expired", 100000))
        value = claude(200, "key")
        del value["claudeAiOauth"]["expiresAt"]
        self.assertEqual(scope["local_credential_health"]("claude", value, 150000),
                         ("oauth", "unknown", None))

    def test_grok_preferred_expired_issuer_is_not_masked_by_other_current_issuer(self):
        value = grok(100, "expired") | grok(900, "unrelated", "https://other.example.invalid")
        self.assertEqual(scope["local_credential_health"]("grok", value, 150000),
                         ("oauth", "expired", 100000))

    def test_grok_selected_unknown_expiry_cannot_borrow_later_preferred_window(self):
        for expiry in (None, "invalid-invented-expiry"):
            grant = {"key": "synthetic-unknown-key", "auth_mode": "oidc"}
            if expiry is not None:
                grant["expires_at"] = expiry
            # Deliberately insert the current grant first: host selection uses
            # issuer ordering rather than the document's insertion order.
            value = grok(900, "current", "https://auth.x.ai::b")
            value["https://auth.x.ai::a"] = grant
            for earlier_expired in (False, True):
                if earlier_expired:
                    value |= grok(100, "expired", "https://auth.x.ai")
                self.assertEqual(scope["local_credential_health"]("grok", value, 150000),
                                 ("oauth", "unknown", None))

    def test_grok_unbounded_keys_remain_unknown_without_fabricated_expiry(self):
        value = {"invented-api": {"key": "synthetic-api-key"}}
        self.assertEqual(scope["local_credential_health"]("grok", value, 150000),
                         ("unbounded", "unknown", None))
        value["invented-api"]["auth_mode"] = "oidc"
        self.assertEqual(scope["local_credential_health"]("grok", value, 150000),
                         ("oauth", "unknown", None))

    def zai_account(self, key):
        account = scope["ACCOUNTS"] / "invented-account" / "zai"
        account.mkdir(parents=True, exist_ok=True)
        (account / "api-key").write_bytes(key)
        return account

    def test_one_status_pass_reads_every_account_in_order(self):
        # bench-status reads all OAuth and key accounts in one call; one it
        # cannot read is reported as before, without hiding the others.
        now = int(time.time())
        account, _ = self.account("claude", claude(now + 7200, "current"))
        zai = self.zai_account(b"invented-zai-key\n")
        missing = scope["ACCOUNTS"] / "invented-gone" / "grok"
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            scope["account_statuses"]([str(account), str(missing), str(zai)])
        self.assertEqual(output.getvalue().splitlines(), [
            "account claude invented-account yes",
            f"account-health claude invented-account oauth current {(now + 7200) * 1000}",
            "account grok invented-gone no",
            "account-health grok invented-gone unknown invalid -",
            "account zai invented-account yes",
            "account-health zai invented-account unbounded unknown -",
        ])

    def test_zai_key_is_copied_privately_and_never_saved_back(self):
        account = self.zai_account(b"invented-zai-key\n")
        scope["directory"] = scope["ROOT"] / "zai"
        scope["prepare"](str(account))
        copy = scope["directory"] / "home" / "api-key"
        self.assertEqual(copy.read_bytes(), b"invented-zai-key\n")
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(copy.stat().st_mode), 0o600)
        copy.write_bytes(b"changed-by-the-attempt\n")
        (scope["directory"] / "home" / "auth.json").write_text("{}", encoding="utf-8")
        scope["save"]()
        self.assertEqual((account / "api-key").read_bytes(), b"invented-zai-key\n")
        self.assertFalse((account / "auth.json").exists())

    def test_zai_status_is_unbounded_and_never_prints_the_key(self):
        account = self.zai_account(b"synthetic-private-zai-key\n")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            scope["account_status"](str(account))
        self.assertEqual(output.getvalue().splitlines(), [
            "account zai invented-account yes",
            "account-health zai invented-account unbounded unknown -",
        ])
        invalid_keys = (b"", b"\n", b"synthetic private\n", b"synthetic\nprivate\n", b"x" * 4097)
        for index, invalid in enumerate(invalid_keys):
            with self.subTest(invalid=index):
                (account / "api-key").write_bytes(invalid)
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    scope["account_status"](str(account))
                self.assertEqual(output.getvalue().splitlines(), [
                    "account zai invented-account no",
                    "account-health zai invented-account unknown invalid -",
                ])
                self.assertNotIn("synthetic", output.getvalue())
                scope["directory"] = scope["ROOT"] / f"invalid-{index}"
                with self.assertRaisesRegex(ValueError, "invalid API key file"):
                    scope["prepare"](str(account))

    def test_status_never_prints_tokens_or_invalid_document_excerpts(self):
        expiry = int(time.time()) + 3600
        account, target = self.account("claude", claude(expiry, "synthetic-private-token"))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            scope["account_status"](str(account))
        self.assertEqual(output.getvalue().splitlines(), [
            "account claude invented-account yes",
            f"account-health claude invented-account oauth current {expiry * 1000}",
        ])
        target.write_text("synthetic-private-token-invalid-json", encoding="utf-8")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            scope["account_status"](str(account))
        self.assertEqual(output.getvalue().splitlines(), [
            "account claude invented-account no",
            "account-health claude invented-account unknown invalid -",
        ])


unittest.main(argv=["bench-auth-selftest"])
BENCH_AUTH_UNIT_TESTS
[[ $? == 0 ]] || failed=1
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

# Z.ai: an invented key, piped in as the host pipes the real one.
zai_home=$auth_account/zai
check "Z.ai key is never read from a terminal" "$(script -qec "/usr/local/sbin/bench-login zai $(basename "$auth_account")" /dev/null </dev/null >/dev/null 2>&1; echo $?)" 64
printf 'invented-zai-key\n' | /usr/local/sbin/bench-login zai "$(basename "$auth_account")" >/dev/null
check "Z.ai key stored privately" "$(stat -c '%a %U' "$zai_home/api-key")" "600 root"
check "Z.ai account is signed in" "$(/usr/local/sbin/bench-auth status "$zai_home")" \
  "account zai $(basename "$auth_account") yes
account-health zai $(basename "$auth_account") unbounded unknown -"
check "a line break inside a key is refused" "$(printf 'invented\nkey\n' | /usr/local/sbin/bench-login zai "$(basename "$auth_account")" >/dev/null 2>&1; echo $?)" 65
/usr/local/sbin/bench-copy selftest-z </tmp/selftest.tar >/dev/null
zai() { run session selftest-z "DISTILL_BENCH_ACCOUNT_HOME=$zai_home" -- "$@"; }
check "Z.ai session gets a private key copy" "$(zai bash -c 'cat /tmp/provider/api-key; printf changed >/tmp/provider/api-key')" invented-zai-key
check "Z.ai session names only the API" "$(zai bash -c 'getent hosts api.z.ai >/dev/null && echo api; getent hosts api.anthropic.com >/dev/null && echo other')" api
check "Z.ai session reaches the Z.ai API" "$(zai curl -s -o /dev/null -w '%{http_code}' -m 15 https://api.z.ai/ | grep -c '^[1-5][0-9][0-9]$')" 1
check "Z.ai session reaches no other host" "$(zai curl -s -m 5 https://1.1.1.1/ >/dev/null; echo $?)" 7
check "Z.ai session has no resolver" "$(zai bash -c 'timeout 5 bash -c "exec 3<>/dev/tcp/8.8.8.8/53" 2>/dev/null && echo open')" ""
zai_address=$(getent ahostsv4 api.z.ai | awk 'NR == 1 {print $1}')
check "Z.ai session has no other port" "$(zai bash -c "timeout 5 bash -c 'exec 3<>/dev/tcp/$zai_address/80' 2>/dev/null && echo open")" ""
/usr/local/sbin/bench-kill session selftest-z
/usr/local/sbin/bench-clean selftest-z
check "Z.ai attempt never writes the account key" "$(cat "$zai_home/api-key")" invented-zai-key
check "Z.ai clean removes its firewall" "$(iptables -S | grep -c "DZ-$(printf '%s' selftest-z | sha256sum | cut -c1-12)")" 0
check "public session after Z.ai still public" "$(run session selftest-b -- curl -s -o /dev/null -w '%{http_code}' -m 15 https://api.anthropic.com/ | grep -c '^[1-5][0-9][0-9]$')" 1
/usr/local/sbin/bench-kill session selftest-b
/usr/local/sbin/bench-clean selftest-a
/usr/local/sbin/bench-clean selftest-b
rm -rf "$auth_account"
rm -rf /tmp/selftest-file /tmp/selftest.tar /tmp/selftest-check /tmp/selftest-check.tar
# Readiness digests: a pass from the record reports exactly what a cold pass
# reads, the record is root's alone, and a changed file is read again.
identity_lines() { /usr/local/sbin/bench-status 2>/dev/null | grep -E '^(file|binary|tool) '; }
rm -f /run/distill-bench-digests/status.json
cold=$(identity_lines)
warm=$(identity_lines)
check "status names the pinned node digest" "$(grep -cE '^binary /usr/local/bin/node [0-9a-f]{64}$' <<<"$cold")" 1
check "recorded status digests equal a cold pass" "$([[ -n $cold && $warm == "$cold" ]] && echo same)" same
check "digest record is root only" "$(stat -c '%u %a' /run/distill-bench-digests /run/distill-bench-digests/status.json | tr '\n' ' ')" "0 700 0 600 "
digest_probe=$(mktemp /root/selftest-digest.XXXXXX)
printf one >"$digest_probe"
first=$(/usr/local/sbin/bench-digest status "$digest_probe" | cut -d' ' -f1)
printf two >"$digest_probe"
second=$(/usr/local/sbin/bench-digest status "$digest_probe" | cut -d' ' -f1)
check "a changed file is read again" "$([[ $first != "$second" && $second == "$(sha256sum "$digest_probe" | cut -d' ' -f1)" ]] && echo read)" read
rm -f "$digest_probe"
/usr/local/sbin/bench-status >/dev/null 2>&1
check "clean leaves nothing" "$(ls /srv/bench/work /srv/bench/base /srv/bench/checks /srv/bench/auth | grep -c selftest)" 0
exit $failed
