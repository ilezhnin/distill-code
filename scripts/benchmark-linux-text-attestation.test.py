"""Toy-only hash-cache regressions; no WSL, credentials or provider process."""
import hashlib
import importlib.util
import json
import os
import stat
import sys
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'src-tauri/resources/benchmark-linux-text-attestation.py'
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('text_attestation', SOURCE)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class MetadataCacheTests(unittest.TestCase):
    def test_untrusted_owner_mode_and_file_kind_are_rejected(self):
        policy.protected_info(SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o644))
        for owner, mode in [(1000, stat.S_IFREG | 0o644), (0, stat.S_IFREG | 0o666),
                            (0, stat.S_IFLNK | 0o777), (0, stat.S_IFIFO | 0o600)]:
            with self.assertRaises(ValueError):
                policy.protected_info(SimpleNamespace(st_uid=owner, st_mode=mode))

    def test_every_identity_field_invalidates_a_cached_hash(self):
        identity = ['/opt/distill-tools/toy', 1, 2, 3, 4, 5, 0, 0, 0o100644, 1]
        entries = {identity[0]: {'identity': identity, 'sha256': 'a' * 64}}
        self.assertEqual(policy.cached_digest(entries, identity[0], identity), 'a' * 64)
        for index in range(len(identity)):
            changed = identity.copy()
            changed[index] = '/opt/distill-tools/other' if index == 0 else changed[index] + 1
            self.assertIsNone(policy.cached_digest(entries, identity[0], changed), index)
        entries[identity[0]]['sha256'] = 'unverified'
        self.assertIsNone(policy.cached_digest(entries, identity[0], identity))

    def test_cache_is_scoped_to_receipt_policy_and_sandbox_identity(self):
        context = {'provider': 'codex', 'sandboxRevision': 'a' * 64,
                   'policyFingerprint': 'b' * 64, 'receiptSha256': 'c' * 64,
                   'receipt': ['/opt/distill-tools/text-policy-proofs/codex.json', 1, 2, 3]}
        entries = {'/opt/distill-tools/toy': {'identity': [], 'sha256': 'd' * 64}}
        with tempfile.TemporaryDirectory(prefix='distill-cache-context-toy-', dir=SOURCE.parents[3]) as directory:
            cache = Path(directory)
            payload = json.dumps({'context': context, 'entries': entries})
            (cache / 'codex.json').write_text(payload)
            info = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_nlink=1, st_size=len(payload))
            with patch.object(policy, 'CACHE', cache), patch.object(policy, 'protected'), patch.object(policy.os, 'geteuid', return_value=0, create=True), patch.object(policy.os, 'O_NOFOLLOW', getattr(os, 'O_NOFOLLOW', 0), create=True), patch.object(policy.os, 'O_NONBLOCK', getattr(os, 'O_NONBLOCK', 0), create=True), patch.object(policy.os, 'fstat', return_value=info):
                self.assertEqual(policy.HashCache('codex', context).entries, entries)
                for key in context:
                    self.assertEqual(policy.HashCache('codex', {**context, key: 'changed'}).entries, {}, key)
                info.st_uid = 1000
                with self.assertRaises(ValueError):
                    policy.HashCache('codex', context)

    def test_cold_reads_warm_skips_and_changed_file_rehashes(self):
        with tempfile.TemporaryDirectory(prefix='distill-attestation-toy-', dir=SOURCE.parents[3]) as directory:
            root = Path(directory).resolve()
            executable = root / 'invented-executable'
            executable.write_bytes(b'invented synthetic binary\n')
            cache = SimpleNamespace(entries={})
            # Ownership enforcement is Linux-only. This test substitutes only
            # that boundary for its own disposable Windows fixture; production
            # code still requires root-owned paths and NOFOLLOW open on Linux.
            # Windows fstat/lstat expose different timestamp details. Supply
            # one fixture stat for this cache-I/O test; tuple invalidation is
            # tested independently above and Linux uses real fstat/lstat.
            with patch.object(policy, 'ROOT', root), patch.object(policy, 'protected', side_effect=lambda value, directory=False: Path(value)), patch.object(policy, 'protected_info'), patch.object(policy.os, 'O_NOFOLLOW', getattr(os, 'O_NOFOLLOW', 0), create=True), patch.object(policy.os, 'O_NONBLOCK', getattr(os, 'O_NONBLOCK', 0), create=True), patch.object(policy.os, 'fstat', side_effect=lambda fd: executable.stat()), patch.object(policy.hashlib, 'sha256', wraps=hashlib.sha256) as hasher:
                cold = policy.artifact(executable, cache)
                self.assertEqual(hasher.call_count, 1)
                self.assertEqual(policy.artifact(executable, cache), cold)
                self.assertEqual(hasher.call_count, 1, 'warm metadata hit must not hash file bytes')
                executable.write_bytes(b'a different invented synthetic binary\n')
                self.assertNotEqual(policy.artifact(executable, cache), cold)
                self.assertEqual(hasher.call_count, 2)
                policy.artifact(executable)  # Strict qualification ignores cache.
                self.assertEqual(hasher.call_count, 3)

    def test_receipt_changes_fail_before_cache_can_authorize(self):
        artifacts = {'entrypoint': {'path': '/opt/distill-tools/toy', 'sha256': 'a' * 64}}
        receipt = {'schemaVersion': 1, 'recipe': 'linux-native-text-v1', 'provider': 'codex',
                   'sandboxRevision': 'b' * 64, 'policyFingerprint': 'c' * 64,
                   'status': 'passed', 'runtimeArtifacts': artifacts}
        with patch.object(policy, 'collect', return_value=artifacts) as collect:
            self.assertEqual(policy.validate_receipt(receipt, 'codex', 'b' * 64, 'c' * 64), artifacts)
            for key, changed in [('provider', 'kimi'), ('sandboxRevision', 'd' * 64),
                                 ('policyFingerprint', 'e' * 64), ('status', 'unverified')]:
                collect.reset_mock()
                with self.assertRaises(ValueError):
                    policy.validate_receipt({**receipt, key: changed}, 'codex', 'b' * 64, 'c' * 64)
                collect.assert_not_called()
            with self.assertRaises(ValueError):
                policy.validate_receipt({**receipt, 'runtimeArtifacts': {}}, 'codex', 'b' * 64, 'c' * 64)


if __name__ == '__main__':
    unittest.main()
