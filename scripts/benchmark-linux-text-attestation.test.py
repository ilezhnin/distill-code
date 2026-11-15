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
        with tempfile.TemporaryDirectory(prefix='distill-cache-context-toy-') as directory:
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
        with tempfile.TemporaryDirectory(prefix='distill-attestation-toy-') as directory:
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

    def test_zai_receipt_binds_opencode_and_its_ripgrep(self):
        root = Path('/opt/distill-tools')
        launchers = {'opencode': str(root / 'zai/node_modules/opencode-linux-x64/bin/opencode')}
        hashed = lambda path, cache=None: {'path': str(path), 'sha256': 'f' * 64}
        with patch.object(policy, 'launcher_target', side_effect=launchers.__getitem__), \
                patch.object(policy, 'artifact', side_effect=hashed):
            artifacts = policy.collect('zai')
        self.assertEqual(sorted(artifacts), ['entrypoint', 'ripgrep'])
        self.assertEqual(artifacts['entrypoint']['path'], launchers['opencode'])
        self.assertEqual(Path(artifacts['ripgrep']['path']), root / 'zai' / 'bin' / 'rg')


class ReceiptPathTests(unittest.TestCase):
    def test_receipt_ownership_mode_and_size_are_enforced(self):
        good = SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0, st_nlink=1, st_size=512)
        # No raise for a well-formed receipt.
        policy.protected_info(good)
        for info in [
            SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=1000, st_nlink=1, st_size=512),
            SimpleNamespace(st_mode=stat.S_IFREG | 0o666, st_uid=0, st_nlink=1, st_size=512),
            SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=0, st_nlink=1, st_size=512),
        ]:
            with self.assertRaises(ValueError, msg=repr(info)):
                policy.protected_info(info)

    def test_receipt_change_while_verifying_is_detected(self):
        root = Path(tempfile.mkdtemp(prefix='distill-attest-verify-'))
        executable = root / 'toy-binary'
        executable.write_bytes(b'stable binary\n')
        call_count = [0]
        original_identity = policy.identity

        def shifting_identity(path, info):
            result = original_identity(path, info)
            call_count[0] += 1
            if call_count[0] >= 3:
                result = list(result)
                result[3] += 1  # Alter st_size field.
            return result

        with patch.object(policy, 'ROOT', root), \
                patch.object(policy, 'protected', side_effect=lambda value, directory=False: Path(value)), \
                patch.object(policy, 'protected_info'), \
                patch.object(policy.os, 'O_NOFOLLOW', getattr(os, 'O_NOFOLLOW', 0), create=True), \
                patch.object(policy.os, 'O_NONBLOCK', getattr(os, 'O_NONBLOCK', 0), create=True), \
                patch.object(policy.os, 'fstat', side_effect=lambda fd: executable.stat()), \
                patch.object(policy, 'identity', side_effect=shifting_identity):
            with self.assertRaises(ValueError):
                policy.artifact(executable)
        import shutil
        shutil.rmtree(root, ignore_errors=True)

    def test_launcher_target_requires_path_under_root(self):
        root = Path(tempfile.mkdtemp(prefix='distill-attest-launcher-'))
        launcher = root / 'bin' / 'test-launcher'
        launcher.parent.mkdir(parents=True, exist_ok=True)
        launcher.write_text('exec /etc/evil/binary\n')
        with patch.object(policy, 'ROOT', root), \
                patch.object(policy, 'protected', side_effect=lambda value, directory=False: Path(value)):
            with self.assertRaises(ValueError):
                policy.launcher_target('test-launcher')
        import shutil
        shutil.rmtree(root, ignore_errors=True)

    def test_artifact_refuses_paths_outside_the_tool_root(self):
        outside = Path(tempfile.mkdtemp(prefix='distill-attest-outside-')) / 'binary'
        outside.write_bytes(b'outside\n')
        with patch.object(policy, 'protected', side_effect=lambda value, directory=False: Path(value)), \
                patch.object(policy, 'protected_info'):
            with self.assertRaises(ValueError):
                policy.artifact(outside)
        import shutil
        shutil.rmtree(outside.parent, ignore_errors=True)

    def test_codex_requires_exactly_one_elf_native(self):
        root = Path(tempfile.mkdtemp(prefix='distill-attest-codex-'))
        codex_vendor = root / 'codex-acp' / 'node_modules' / '@openai' / 'codex-linux-x64' / 'vendor' / 'bin'
        codex_vendor.mkdir(parents=True, exist_ok=True)
        # No ELF binary at all.
        (codex_vendor / 'codex').write_bytes(b'#!/bin/sh\n')
        hashed = lambda path, cache=None: {'path': str(path), 'sha256': 'f' * 64}
        launchers = {'codex-acp': str(root / 'codex-acp' / 'entry'),
                     'codex': str(root / 'codex-acp' / 'launch')}
        with patch.object(policy, 'ROOT', root), \
                patch.object(policy, 'launcher_target', side_effect=launchers.__getitem__), \
                patch.object(policy, 'artifact', side_effect=hashed):
            with self.assertRaises(ValueError):
                policy.collect('codex')
        # Two ELF binaries is also ambiguous.
        (codex_vendor / 'codex').write_bytes(b'\x7fELF' + b'\x00' * 12)
        vendor2 = root / 'codex-acp' / 'node_modules' / '@openai' / 'codex-linux-arm64' / 'vendor' / 'bin'
        vendor2.mkdir(parents=True, exist_ok=True)
        (vendor2 / 'codex').write_bytes(b'\x7fELF' + b'\x00' * 12)
        with patch.object(policy, 'ROOT', root), \
                patch.object(policy, 'launcher_target', side_effect=launchers.__getitem__), \
                patch.object(policy, 'artifact', side_effect=hashed):
            with self.assertRaises(ValueError):
                policy.collect('codex')
        import shutil
        shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
