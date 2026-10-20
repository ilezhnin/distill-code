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
import base64
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
scope = dict(Path=Path, os=TestOS(), stat=stat, json=json, re=re, base64=base64,
             hashlib=hashlib, tomllib=tomllib, LIMIT=1024 * 1024, CONFLICT_EVIDENCE=20,
             CANDIDATE=types.SimpleNamespace(pw_uid=0, pw_gid=0))
# The helper's literal constants (provider tables), as the helper defines them.
for node in ast.parse(source).body:
    if (isinstance(node, ast.Assign) and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name) and node.targets[0].id.isupper()):
        try:
            scope.setdefault(node.targets[0].id, ast.literal_eval(node.value))
        except ValueError:
            pass
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
        scope["CONFLICTS"] = root / "conflicts"
        scope["CONFLICT_EVIDENCE"] = 20
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
        # An attempt on an account's own sandbox grant, as prepare leaves
        # one for Kimi: a copy and the digest of the original it may save
        # back. The save rules are the same for every document.
        scope["directory"] = scope["ROOT"] / attempt
        (scope["directory"] / "home").mkdir(parents=True)
        receipt = {"account": str(account),
                   "originals": {target.name: scope["digest"](target.read_bytes())}}
        (scope["directory"] / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
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

    def conflict(self, provider, attempt):
        path = scope["CONFLICTS"] / "invented-account" / provider / attempt / "conflict.json"
        return json.loads(path.read_text())

    def test_equal_expiry_conflicts_preserve_stored_and_candidate_grants(self):
        # The save settles: the stored grant stays, the other one is kept in a
        # conflict record for the operator, and the attempt can be removed.
        for provider, document in (("claude", claude), ("grok", grok)):
            account, target = self.account(provider, document(100, "original"))
            self.prepare(account, target, provider + "a", document(200, "first"))
            self.prepare(account, target, provider + "b", document(200, "second"))
            self.save(provider + "a")
            self.save(provider + "b")
            self.assertEqual(json.loads(target.read_text()), document(200, "first"))
            record = self.conflict(provider, provider + "b")
            self.assertEqual(record["attempt"], provider + "b")
            self.assertEqual(record["files"], [{"name": target.name, "kept": True,
                "reason": "concurrent credential refresh; inspect sandbox account before retrying"}])
            evidence = (scope["CONFLICTS"] / "invented-account" / provider / (provider + "b")
                        / "evidence" / target.name)
            self.assertEqual(json.loads(evidence.read_text()), document(200, "second"))
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(evidence.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(scope["CONFLICTS"].stat().st_mode), 0o700)
            self.assertFalse((scope["CONFLICTS"] / "invented-account" / provider / (provider + "a")).exists())

    def test_malformed_refreshed_credentials_do_not_overwrite_account(self):
        for provider, document in (("claude", claude), ("grok", grok)):
            original = document(100, "original")
            account, target = self.account(provider, original)
            self.prepare(account, target, provider, {"unreadable": "invented-secret"})
            self.save(provider)
            self.assertEqual(json.loads(target.read_text()), original)
            record = self.conflict(provider, provider)
            self.assertEqual([entry["kept"] for entry in record["files"]], [False])
            self.assertIn("unreadable refreshed credential", record["files"][0]["reason"])
            records = scope["CONFLICTS"] / "invented-account" / provider
            self.assertNotIn("invented-secret", "".join(
                path.read_text() for path in records.rglob("*") if path.is_file()))

    def test_an_unparsable_or_removed_copy_never_stops_the_save(self):
        account, target = self.account("codex", {"token": "original"})
        self.prepare(account, target, "unparsable", {"token": "x"})
        (scope["ROOT"] / "unparsable" / "home" / "auth.json").write_text("invented {", encoding="utf-8")
        self.save("unparsable")
        record = self.conflict("codex", "unparsable")
        self.assertEqual(record["files"], [{"name": "auth.json", "reason": "JSONDecodeError", "kept": False}])
        # A copy the attempt deleted is nothing to import, and no conflict.
        self.prepare(account, target, "removed", {"token": "x"})
        (scope["ROOT"] / "removed" / "home" / "auth.json").unlink()
        self.save("removed")
        self.assertFalse((scope["CONFLICTS"] / "invented-account" / "codex" / "removed").exists())
        self.assertEqual(json.loads(target.read_text()), {"token": "original"})

    def test_a_linked_copy_is_recorded_without_reading_its_target(self):
        account, target = self.account("codex", {"token": "original"})
        self.prepare(account, target, "linked", {"token": "x"})
        copy = scope["ROOT"] / "linked" / "home" / "auth.json"
        outside = scope["ROOT"] / "outside.json"
        outside.write_text('{"token": "invented-outside"}', encoding="utf-8")
        copy.unlink()
        try:
            copy.symlink_to(outside)
        except OSError:
            self.skipTest("symbolic links need privileges on this host")
        self.save("linked")
        record = self.conflict("codex", "linked")
        self.assertEqual(record["files"][0]["kept"], False)
        self.assertEqual(json.loads(target.read_text()), {"token": "original"})
        # A link that points nowhere is recorded the same way.
        outside.unlink()
        self.save("linked")
        self.assertEqual(self.conflict("codex", "linked")["files"][0]["reason"],
                         "unsafe refreshed credential path")

    def test_a_temporary_file_a_killed_save_left_never_blocks_the_account(self):
        account, target = self.account("codex", {"token": "original"})
        stale = target.with_name("auth.json.bench-refresh")
        stale.write_text("", encoding="utf-8")
        self.prepare(account, target, "after-kill", {"token": "refreshed"})
        self.save("after-kill")
        self.assertEqual(json.loads(target.read_text()), {"token": "refreshed"})
        self.assertFalse(stale.exists())
        self.assertFalse((scope["CONFLICTS"] / "invented-account" / "codex").exists())
        # Nor is one a credential of a Kimi account.
        kimi = scope["ACCOUNTS"] / "invented-account" / "kimi"
        (kimi / "credentials").mkdir(parents=True)
        (kimi / "config.toml").write_text('default_provider = "invented"\n', encoding="utf-8")
        (kimi / "credentials" / "kimi-code.json").write_text(
            '{"access_token": "invented", "expires_at": 100}', encoding="utf-8")
        (kimi / "credentials" / "kimi-code.json.bench-refresh").write_text("", encoding="utf-8")
        scope["directory"] = scope["ROOT"] / "kimi"
        scope["prepare"](str(kimi))
        receipt = json.loads((scope["directory"] / "receipt.json").read_text())
        self.assertEqual(list(receipt["originals"]), [str(Path("credentials") / "kimi-code.json")])

    def test_an_attempt_another_cleanup_removed_has_nothing_to_save(self):
        account, target = self.account("codex", {"token": "original"})
        self.prepare(account, target, "removed", {"token": "refreshed"})
        (scope["ROOT"] / "removed" / "receipt.json").unlink()
        # As when the other cleanup removes it between the check and the read.
        scope["directory"] = scope["ROOT"] / "removed"
        scope["settle"](scope["directory"] / "receipt.json")
        self.save("removed")
        self.assertEqual(json.loads(target.read_text()), {"token": "original"})
        self.assertFalse((scope["CONFLICTS"] / "invented-account" / "codex").exists())

    def test_saving_an_attempt_again_replaces_its_record(self):
        account, target = self.account("codex", {"token": "original"})
        self.prepare(account, target, "a", {"token": "a"})
        self.prepare(account, target, "b", {"token": "b"})
        self.save("a")
        self.save("b")
        records = scope["CONFLICTS"] / "invented-account" / "codex" / "b"
        self.assertTrue((records / "evidence" / "auth.json").exists())
        (scope["ROOT"] / "b" / "home" / "auth.json").write_text("invented {", encoding="utf-8")
        self.save("b")
        self.assertEqual(self.conflict("codex", "b")["files"],
                         [{"name": "auth.json", "reason": "JSONDecodeError", "kept": False}])
        self.assertFalse((records / "evidence").exists())
        self.assertEqual(json.loads(target.read_text()), {"token": "a"})

    def test_conflict_evidence_is_bounded_per_account(self):
        scope["CONFLICT_EVIDENCE"] = 1
        account, target = self.account("codex", {"token": "original"})
        for attempt in ("a", "b", "c"):
            self.prepare(account, target, attempt, {"token": attempt})
        self.save("a")
        self.save("b")
        self.save("c")
        self.assertEqual(json.loads(target.read_text()), {"token": "a"})
        self.assertEqual(self.conflict("codex", "b")["files"][0]["kept"], True)
        self.assertEqual(self.conflict("codex", "c")["files"][0]["kept"], False)
        records = scope["CONFLICTS"] / "invented-account" / "codex"
        self.assertFalse((records / "c" / "evidence").exists())

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
            "account-identity claude invented-account - -",
            "account grok invented-gone no",
            "account-health grok invented-gone unknown invalid -",
            "account zai invented-account yes",
            "account-health zai invented-account unbounded unknown -",
        ])

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

    def test_status_never_prints_tokens_or_invalid_document_excerpts(self):
        expiry = int(time.time()) + 3600
        account, target = self.account("claude", claude(expiry, "synthetic-private-token"))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            scope["account_status"](str(account))
        self.assertEqual(output.getvalue().splitlines(), [
            "account claude invented-account yes",
            f"account-health claude invented-account oauth current {expiry * 1000}",
            "account-identity claude invented-account - -",
        ])
        target.write_text("synthetic-private-token-invalid-json", encoding="utf-8")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            scope["account_status"](str(account))
        self.assertEqual(output.getvalue().splitlines(), [
            "account claude invented-account no",
            "account-health claude invented-account unknown invalid -",
            "account-identity claude invented-account - -",
        ])

    def test_status_names_the_sign_ins_ids_and_nothing_else_of_it(self):
        expiry = int(time.time()) + 3600
        account, _ = self.account("claude", claude(expiry, "synthetic-private-token"))
        (account / ".claude.json").write_text(json.dumps({"oauthAccount": {
            "accountUuid": "0A1B2C3D-0000-4000-8000-00000000000A",
            "organizationUuid": "00000000-0000-4000-8000-00000000000b",
            "emailAddress": "synthetic-private@example.invalid",
            "displayName": "synthetic-private-name",
        }}), encoding="utf-8")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            scope["account_status"](str(account))
        self.assertEqual(output.getvalue().splitlines()[-1],
                         "account-identity claude invented-account "
                         "0a1b2c3d-0000-4000-8000-00000000000a 00000000-0000-4000-8000-00000000000b")
        self.assertNotIn("synthetic-private", output.getvalue())
        # Ids that are not UUIDs are not passed on.
        (account / ".claude.json").write_text(json.dumps({"oauthAccount": {
            "accountUuid": "synthetic-private id", "organizationUuid": 7}}), encoding="utf-8")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            scope["account_status"](str(account))
        self.assertEqual(output.getvalue().splitlines()[-1], "account-identity claude invented-account - -")


def lease_input(files):
    """What the host pipes to `bench-auth stage`: each file base64-encoded."""
    encoded = {name: base64.b64encode(document if isinstance(document, bytes)
                                      else json.dumps(document).encode()).decode()
               for name, document in files.items()}
    return types.SimpleNamespace(buffer=io.BytesIO(json.dumps({"files": encoded}).encode()))


class LeaseTests(unittest.TestCase):
    """Leases of the app's sign-in: staged from standard input, never with a
    refresh token, never saved back."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name).resolve()
        scope["ROOT"] = root / "attempts"
        scope["ACCOUNTS"] = root / "accounts"
        scope["CONFLICTS"] = root / "conflicts"
        scope["ROOT"].mkdir()
        # Staged files are the candidate's: here, whoever runs the tests.
        self.candidate = scope["CANDIDATE"]
        scope["CANDIDATE"] = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())

    def tearDown(self):
        scope["CANDIDATE"] = self.candidate
        self.temporary.cleanup()

    def stage(self, attempt, provider, files):
        scope["directory"] = scope["ROOT"] / attempt
        scope["sys"] = types.SimpleNamespace(stdin=lease_input(files))
        scope["stage"](provider)

    def grant(self):
        return {"claudeAiOauth": {"accessToken": "invented-access",
                                  "expiresAt": (int(time.time()) + 3600) * 1000,
                                  "scopes": ["user:inference"]}}

    def test_a_lease_is_staged_privately_and_never_saved_back(self):
        self.stage("leased", "claude", {".credentials.json": self.grant(),
                                        ".claude.json": {"oauthAccount": {"accountUuid": "invented"}}})
        directory = scope["ROOT"] / "leased"
        home = directory / "home"
        self.assertEqual(json.loads((home / ".credentials.json").read_text()), self.grant())
        for path, mode in ((directory, 0o700), (home, 0o700),
                           (home / ".credentials.json", 0o600), (home / ".claude.json", 0o600)):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), mode, path)
        self.assertEqual(json.loads((directory / "receipt.json").read_text()),
                         {"leased": "claude", "originals": {}})
        # The account folder only selects the provider: it need not exist.
        scope["prepare"](str(scope["ACCOUNTS"] / "invented-account" / "claude"))
        # Whatever the session leaves is never imported anywhere.
        (home / ".credentials.json").write_text(json.dumps({"claudeAiOauth": {
            "accessToken": "changed", "refreshToken": "minted", "expiresAt": 1}}))
        scope["save"]()
        self.assertFalse(scope["ACCOUNTS"].exists())
        self.assertFalse(scope["CONFLICTS"].exists())
        # An attempt is staged once.
        with self.assertRaises(FileExistsError):
            self.stage("leased", "claude", {".credentials.json": self.grant()})

    def test_a_refresh_token_is_refused_in_every_lease(self):
        cases = [
            ("claude", {".credentials.json": {"claudeAiOauth": {
                "accessToken": "a", "refreshToken": "invented-refresh"}}}),
            ("claude", {".credentials.json": self.grant(),
                        ".claude.json": {"oauthAccount": {"refresh_token": "invented-refresh"}}}),
            ("codex", {"auth.json": {"tokens": {"access_token": "a",
                                                "refresh_token": "invented-refresh"}}}),
            ("grok", {"auth.json": {"https://auth.x.ai": {
                "key": "a", "Refresh-Token": "invented-refresh"}}}),
        ]
        for index, (provider, files) in enumerate(cases):
            with self.subTest(provider=provider, index=index):
                with self.assertRaises(ValueError) as refused:
                    self.stage(f"refused{index}", provider, files)
                self.assertNotIn("invented-refresh", str(refused.exception))
                self.assertFalse((scope["ROOT"] / f"refused{index}").exists())

    def test_a_lease_holds_its_providers_shape_alone(self):
        cases = [
            ("claude", {"auth.json": self.grant()}),
            ("claude", {".claude.json": {}}),
            ("claude", {".credentials.json": {"claudeAiOauth": {"accessToken": "a", "other": 1}}}),
            ("claude", {".credentials.json": {"claudeAiOauth": {"accessToken": ""}}}),
            ("codex", {"auth.json": {"OPENAI_API_KEY": "invented", "tokens": {"access_token": "a"}}}),
            ("codex", {"auth.json": {"tokens": {"access_token": "a", "extra": "b"}}}),
            ("grok", {"auth.json": {"https://auth.x.ai": {"key": "a", "nested": {}}}}),
            ("grok", {"auth.json": {}}),
            ("kimi", {"credentials": {}}),
            ("claude", {".credentials.json": b"not json"}),
        ]
        for index, (provider, files) in enumerate(cases):
            with self.subTest(provider=provider, index=index):
                with self.assertRaises(ValueError):
                    self.stage(f"shape{index}", provider, files)
                self.assertFalse((scope["ROOT"] / f"shape{index}").exists())
        scope["directory"] = scope["ROOT"] / "encoding"
        scope["sys"] = types.SimpleNamespace(stdin=types.SimpleNamespace(buffer=io.BytesIO(
            json.dumps({"files": {"auth.json": "not base64!"}}).encode())))
        with self.assertRaises(ValueError):
            scope["stage"]("codex")
        # Valid leases of every provider pass.
        self.stage("codex", "codex", {"auth.json": {"OPENAI_API_KEY": None, "tokens": {
            "id_token": "i", "access_token": "a", "refresh_token": ""}, "last_refresh": "x"}})
        self.stage("grok", "grok", {"auth.json": {"https://auth.x.ai": {
            "key": "a", "auth_mode": "oidc", "expires_at": "2030-01-01T00:00:00Z"}}})

    def test_a_leased_session_needs_its_staged_lease(self):
        scope["directory"] = scope["ROOT"] / "unstaged"
        with self.assertRaises(ValueError):
            scope["prepare"](str(scope["ACCOUNTS"] / "invented-account" / "codex"))
        self.stage("other", "grok", {"auth.json": {"https://auth.x.ai": {"key": "a"}}})
        # A lease staged for another provider does not serve.
        with self.assertRaises(ValueError):
            scope["prepare"](str(scope["ACCOUNTS"] / "invented-account" / "codex"))
        with self.assertRaises(ValueError):
            scope["prepare"](str(scope["ACCOUNTS"] / "invented account" / "grok"))
        scope["prepare"](str(scope["ACCOUNTS"] / "invented-account" / "grok"))

    def test_a_zai_key_lease_is_staged_privately_and_never_saved_back(self):
        self.stage("zai", "zai", {"api-key": b"invented-zai-key\n"})
        copy = scope["ROOT"] / "zai" / "home" / "api-key"
        self.assertEqual(copy.read_bytes(), b"invented-zai-key\n")
        self.assertEqual(stat.S_IMODE(copy.stat().st_mode), 0o600)
        scope["prepare"](str(scope["ACCOUNTS"] / "invented-account" / "zai"))
        copy.write_bytes(b"changed-by-the-attempt\n")
        scope["save"]()
        self.assertFalse(scope["ACCOUNTS"].exists())
        invalid_keys = (b"", b"\n", b"synthetic private\n", b"synthetic\nprivate\n", b"x" * 4097)
        for index, invalid in enumerate(invalid_keys):
            with self.subTest(invalid=index):
                with self.assertRaises(ValueError) as refused:
                    self.stage(f"invalid-{index}", "zai", {"api-key": invalid})
                self.assertNotIn("synthetic", str(refused.exception))
                self.assertFalse((scope["ROOT"] / f"invalid-{index}").exists())

    def test_staged_files_never_follow_a_link(self):
        outside = Path(self.temporary.name) / "outside"
        outside.write_text("kept")
        link = Path(self.temporary.name) / "link"
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("symbolic links need privileges on this host")
        with self.assertRaises(OSError):
            scope["write_exclusive"](link, b"invented")
        self.assertEqual(outside.read_text(), "kept")


unittest.main(argv=["bench-auth-selftest"])
BENCH_AUTH_UNIT_TESTS
[[ $? == 0 ]] || failed=1
auth_account=$(mktemp -d /home/candidate/accounts/selftest-auth-XXXXXXXX)
auth_id=$(basename "$auth_account")
# Claude, Codex and Grok sessions run on a lease the host stages from the
# Distill app's own sign-in: read from standard input alone, never with a
# refresh token, never saved back. The account folder only selects the
# provider; it holds no grant and need not exist.
lease() { python3 -c 'import base64, json, sys
files = json.loads(sys.argv[1])
print(json.dumps({"files": {name: base64.b64encode(json.dumps(document).encode()).decode()
                            for name, document in files.items()}}))' "$1"; }
codex_lease=$(lease '{"auth.json":{"OPENAI_API_KEY":null,"tokens":{"id_token":"invented-id","access_token":"invented-access","refresh_token":""},"last_refresh":"2026-01-01T00:00:00Z"}}')
/usr/local/sbin/bench-copy selftest-lease </tmp/selftest.tar >/dev/null
check "a lease is read from standard input alone" "$(printf '%s' "$codex_lease" | /usr/local/sbin/bench-auth stage selftest-lease codex extra >/dev/null 2>&1; echo $?)" 70
check "a lease with a refresh token is refused" "$(lease '{"auth.json":{"tokens":{"id_token":"i","access_token":"a","refresh_token":"invented-refresh"}}}' | /usr/local/sbin/bench-auth stage selftest-lease codex >/dev/null 2>&1; echo $?)$(test -e /srv/bench/auth/selftest-lease && echo left)" 70
check "a leased session needs its staged lease" "$(run session selftest-lease "DISTILL_BENCH_ACCOUNT_HOME=$auth_account/codex" -- true && echo ran)" ""
printf '%s' "$codex_lease" | /usr/local/sbin/bench-auth stage selftest-lease codex
check "a lease is staged once" "$(printf '%s' "$codex_lease" | /usr/local/sbin/bench-auth stage selftest-lease codex >/dev/null 2>&1; echo $?)" 70
check "a staged lease is the candidate's alone" "$(stat -c '%U %a' /srv/bench/auth/selftest-lease /srv/bench/auth/selftest-lease/home /srv/bench/auth/selftest-lease/home/auth.json | tr '\n' ' ')" "root 700 candidate 700 candidate 600 "
check "a session runs on its staged lease" "$(run session selftest-lease "DISTILL_BENCH_ACCOUNT_HOME=$auth_account/codex" -- bash -c '
  grep -o invented-access /tmp/provider/auth.json
  printf "{\"tokens\":{\"refresh_token\":\"minted\"}}" >/tmp/provider/auth.json')" invented-access
/usr/local/sbin/bench-kill session selftest-lease
check "a lease is never saved back" "$(/usr/local/sbin/bench-clean selftest-lease >/dev/null 2>&1; echo $?; ls -A "$auth_account")" 0

# Kimi keeps its own sandbox sign-in: a session gets a private copy of its
# credentials, and only a refreshed credential file is saved back.
kimi_home=$auth_account/kimi
kimi_file=credentials/kimi-code.json
install -d -m 700 -o candidate -g candidate "$kimi_home" "$kimi_home/credentials"
printf 'default_provider = "test"\n' >"$kimi_home/config.toml"
printf '{"access_token":"original","refresh_token":"original","expires_at":100}\n' >"$kimi_home/$kimi_file"
printf 'previous answer\n' >"$kimi_home/history.txt"
chown candidate:candidate "$kimi_home/config.toml" "$kimi_home/$kimi_file" "$kimi_home/history.txt"
kimi_token() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["access_token"])' "$1"; }
check "account history is not mounted" "$(run session selftest-a "DISTILL_BENCH_ACCOUNT_HOME=$kimi_home" -- bash -c '
  test ! -e /tmp/provider/history.txt || exit 1
  printf marker >/tmp/provider/previous-attempt
  printf "{\"access_token\":\"refreshed\",\"refresh_token\":\"refreshed\",\"expires_at\":200}\n" >/tmp/provider/credentials/kimi-code.json
  echo private
')" private
/usr/local/sbin/bench-kill session selftest-a
/usr/local/sbin/bench-clean selftest-a
check "OAuth refresh survives a stopped attempt" "$(kimi_token "$kimi_home/$kimi_file")" refreshed
check "arbitrary provider files are not persisted" "$(test -e "$kimi_home/previous-attempt" && echo leaked)" ""
check "next attempt cannot read previous state" "$(run session selftest-b "DISTILL_BENCH_ACCOUNT_HOME=$kimi_home" -- bash -c '
  test ! -e /tmp/provider/history.txt && test ! -e /tmp/provider/previous-attempt && echo private
')" private
/usr/local/sbin/bench-kill session selftest-b

# A stale or linked credential must never overwrite the selected account. The
# save keeps it in a conflict record for the operator and the attempt is
# still removed.
conflicts=/var/lib/distill-bench/auth-conflicts/$auth_id
/usr/local/sbin/bench-auth prepare selftest-auth-a "$kimi_home"
/usr/local/sbin/bench-auth prepare selftest-auth-b "$kimi_home"
printf '{"access_token":"first","expires_at":300}\n' >"/srv/bench/auth/selftest-auth-a/home/$kimi_file"
printf '{"access_token":"second","expires_at":300}\n' >"/srv/bench/auth/selftest-auth-b/home/$kimi_file"
/usr/local/sbin/bench-auth save selftest-auth-a
check "concurrent refresh settles without an overwrite" "$(/usr/local/sbin/bench-auth save selftest-auth-b >/dev/null 2>&1; echo $?)" 0
check "the other refresh is kept for the operator" "$(kimi_token "$conflicts/kimi/selftest-auth-b/evidence/$kimi_file")" second
check "conflict records are root's alone" "$(stat -c '%u %a' /var/lib/distill-bench/auth-conflicts "$conflicts/kimi/selftest-auth-b/conflict.json" | tr '\n' ' ')" "0 700 0 600 "
check "status reports the conflicted account" "$(/usr/local/sbin/bench-status 2>/dev/null | grep -c "^account-conflict kimi $auth_id 1$")" 1
rm "/srv/bench/auth/selftest-auth-b/home/$kimi_file"
ln -s "$kimi_home/$kimi_file" "/srv/bench/auth/selftest-auth-b/home/$kimi_file"
check "credential links are recorded, never followed" "$(/usr/local/sbin/bench-auth save selftest-auth-b >/dev/null 2>&1; echo $?) $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["files"][0]["reason"])' "$conflicts/kimi/selftest-auth-b/conflict.json")" "0 unsafe refreshed credential path"
check "refused refresh preserves the newer credential" "$(kimi_token "$kimi_home/$kimi_file")" first
check "a conflicted attempt is still removed" "$(/usr/local/sbin/bench-clean selftest-auth-b >/dev/null 2>&1; echo $?)$(test -e /srv/bench/auth/selftest-auth-b && echo kept)" 0
# A save that fails outright keeps the attempt's copy aside and says so.
/usr/local/sbin/bench-auth prepare selftest-auth-c "$kimi_home"
printf 'invented {' >/srv/bench/auth/selftest-auth-c/receipt.json
check "a failed save keeps the attempt's copy aside" "$(/usr/local/sbin/bench-clean selftest-auth-c >/dev/null 2>&1; echo $?) $(test -d /srv/bench/auth-unsaved/selftest-auth-c && echo kept)$(test -e /srv/bench/auth/selftest-auth-c && echo left)" "70 kept"
check "status counts copies kept aside" "$(/usr/local/sbin/bench-status 2>/dev/null | grep -c '^auth-unsaved [1-9][0-9]*$')" 1
rm -rf /srv/bench/auth/selftest-auth-a /srv/bench/auth/selftest-auth-b /srv/bench/auth-unsaved/selftest-auth-c* "$conflicts"

printf '{"access_token":"original","refresh_token":"original","expires_at":100}\n' >"$kimi_home/$kimi_file"
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

# A sign-in or account service sees the one account home it names, writable,
# over an empty /home and a read-only root; every other account stays hidden.
login_other=$(mktemp -d /home/candidate/accounts/selftest-other-XXXXXXXX)
login() { run login selftest-login "DISTILL_BENCH_LOGIN_HOME=$kimi_home" "KIMI_CODE_HOME=$kimi_home" -- "$@"; }
check "a sign-in sees its account home alone" "$(login bash -c 'ls -A /home/candidate/accounts /home/candidate/accounts/*' | tr '\n' ' ')" \
  "/home/candidate/accounts: $auth_id  /home/candidate/accounts/$auth_id: kimi "
check "a sign-in writes its account home" "$(login bash -c 'printf signed >"$KIMI_CODE_HOME/selftest-login"'; cat "$kimi_home/selftest-login" 2>/dev/null)" signed
check "a sign-in runs on a read-only root" "$(login awk '$5 == "/" {split($6, o, ","); print o[1]}' /proc/self/mountinfo)" ro
check "a sign-in home is temporary" "$(login bash -c 'touch ~/.selftest-login && echo ok'; test -e /home/candidate/.selftest-login && echo kept)" ok
check "a login home must be an account home" "$(run login selftest-login DISTILL_BENCH_LOGIN_HOME=/home/candidate -- true && echo ran)" ""
check "a session cannot name a login home" "$(run session selftest-a "DISTILL_BENCH_LOGIN_HOME=$kimi_home" -- true && echo ran)" ""
rm -f "$kimi_home/selftest-login"
rm -rf "$login_other"

# Z.ai: an invented key, staged as the host stages the account's saved key.
zai_home=$auth_account/zai
zai_lease() { python3 -c 'import base64, json, sys
print(json.dumps({"files": {"api-key": base64.b64encode(sys.argv[1].encode()).decode()}}))' "$1"; }
check "a line break inside a key is refused" "$(zai_lease $'invented\nkey\n' | /usr/local/sbin/bench-auth stage selftest-z zai >/dev/null 2>&1; echo $?)$(test -e /srv/bench/auth/selftest-z && echo left)" 70
/usr/local/sbin/bench-copy selftest-z </tmp/selftest.tar >/dev/null
zai_lease $'invented-zai-key\n' | /usr/local/sbin/bench-auth stage selftest-z zai
check "Z.ai key staged privately" "$(stat -c '%a %U' /srv/bench/auth/selftest-z/home/api-key)" "600 candidate"
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
check "Z.ai attempt writes no account key" "$(test -e "$zai_home" && echo written)" ""
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
