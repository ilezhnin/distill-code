"""Toy-only regressions for the readiness digest record; no WSL or provider."""
import contextlib
import hashlib
import importlib.machinery
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[1] / 'src-tauri/resources/benchmark-sandbox/bench-digest'
digest = importlib.machinery.SourceFileLoader('benchmark_digest_fixture', str(SOURCE)).load_module()
production_os = digest.os
production_protected = digest.protected


class DigestRecordTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        digest.CACHE = str(self.root / 'record')
        # Linux names root and the open flags; Windows test checkouts have
        # neither, and their mode bits cannot express a root-only directory.
        digest.os = SimpleNamespace(**{**vars(production_os), 'geteuid': lambda: 0,
                                       'O_NOFOLLOW': getattr(production_os, 'O_NOFOLLOW', 0),
                                       'O_NONBLOCK': getattr(production_os, 'O_NONBLOCK', 0)})
        digest.protected = lambda info, directory=False: True

    def tearDown(self):
        digest.os = production_os
        digest.protected = production_protected
        self.temporary.cleanup()

    def run_digest(self, *paths, scope='status'):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            argv, sys.argv = sys.argv, ['bench-digest', scope, *map(str, paths)]
            try:
                self.assertEqual(digest.main(), 0)
            finally:
                sys.argv = argv
        return [line.split(' ', 1) for line in output.getvalue().splitlines()]

    def record(self, scope='status'):
        return json.loads((self.root / 'record' / f'{scope}.json').read_text())

    def file(self, name, content):
        path = self.root / name
        path.write_bytes(content)
        return path

    def test_digests_match_sha256sum_in_order_and_missing_files_have_none(self):
        first = self.file('first', b'one\n')
        second = self.file('second', b'two\n')
        lines = self.run_digest(second, self.root / 'absent', first, '')
        self.assertEqual(lines, [
            [hashlib.sha256(b'two\n').hexdigest(), str(second)],
            ['-', str(self.root / 'absent')],
            [hashlib.sha256(b'one\n').hexdigest(), str(first)],
            ['-', ''],
        ])
        self.assertEqual(set(self.record()), {str(first), str(second)})

    def test_an_unchanged_identity_is_not_read_again_and_a_changed_one_is(self):
        path = self.file('tool', b'pinned\n')
        real = hashlib.sha256(b'pinned\n').hexdigest()
        self.assertEqual(self.run_digest(path)[0][0], real)
        # Only the record says what the bytes were: an unchanged identity is
        # answered from it without reading the file.
        record = self.record()
        record[str(path)]['sha256'] = 'b' * 64
        (self.root / 'record' / 'status.json').write_text(json.dumps(record))
        self.assertEqual(self.run_digest(path)[0][0], 'b' * 64)
        # Any change of identity is read again: new bytes and size, ...
        path.write_bytes(b'changed!\n')
        self.assertEqual(self.run_digest(path)[0][0], hashlib.sha256(b'changed!\n').hexdigest())
        # ... same size with only a later modify time, ...
        record = self.record()
        record[str(path)]['sha256'] = 'c' * 64
        (self.root / 'record' / 'status.json').write_text(json.dumps(record))
        info = path.stat()
        os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000_000))
        self.assertEqual(self.run_digest(path)[0][0], hashlib.sha256(b'changed!\n').hexdigest())
        # ... and a replacement file under the same name.
        replacement = self.file('replacement', b'changed!\n')
        os.replace(replacement, path)
        record = self.record()
        record[str(path)]['sha256'] = 'd' * 64
        (self.root / 'record' / 'status.json').write_text(json.dumps(record))
        self.assertEqual(self.run_digest(path)[0][0], hashlib.sha256(b'changed!\n').hexdigest())

    def test_every_identity_field_is_compared(self):
        info = SimpleNamespace(st_dev=1, st_ino=2, st_size=3, st_mtime_ns=4, st_ctime_ns=5,
                               st_uid=0, st_gid=0, st_mode=stat.S_IFREG | 0o755, st_nlink=1)
        base = digest.identity('/opt/distill-tools/bin/toy', info)
        self.assertEqual(len(base), 10)
        for field in vars(info):
            changed = SimpleNamespace(**{**vars(info), field: getattr(info, field) + 1})
            self.assertNotEqual(digest.identity('/opt/distill-tools/bin/toy', changed), base, field)
        self.assertNotEqual(digest.identity('/opt/distill-tools/bin/other', info), base)

    def test_a_damaged_or_foreign_record_is_a_cold_pass(self):
        path = self.file('tool', b'pinned\n')
        real = hashlib.sha256(b'pinned\n').hexdigest()
        self.run_digest(path)
        for damaged in ['not json', '[]', json.dumps({str(path): {'identity': [], 'sha256': 'e' * 64}}),
                        json.dumps({str(path): {'identity': self.record()[str(path)]['identity'],
                                                'sha256': 'unverified'}})]:
            (self.root / 'record' / 'status.json').write_text(damaged)
            self.assertEqual(self.run_digest(path)[0][0], real, damaged)
        # A record that is not root's own is never used nor rewritten.
        record = self.record()
        record[str(path)]['sha256'] = 'f' * 64
        (self.root / 'record' / 'status.json').write_text(json.dumps(record))
        digest.protected = lambda info, directory=False: not directory
        self.assertEqual(self.run_digest(path)[0][0], real)
        self.assertEqual(self.record()[str(path)]['sha256'], 'f' * 64)
        # Nor without root.
        digest.protected = lambda info, directory=False: True
        digest.os.geteuid = lambda: 1000
        self.assertEqual(self.run_digest(path)[0][0], real)
        self.assertEqual(self.record()[str(path)]['sha256'], 'f' * 64)

    def test_scopes_keep_only_their_own_last_paths(self):
        first = self.file('first', b'one\n')
        second = self.file('second', b'two\n')
        self.run_digest(first, second)
        self.run_digest(second, scope='browser')
        self.run_digest(first)
        self.assertEqual(set(self.record()), {str(first)})
        self.assertEqual(set(self.record('browser')), {str(second)})
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            argv, sys.argv = sys.argv, ['bench-digest', 'other', str(first)]
            try:
                self.assertEqual(digest.main(), 64)
            finally:
                sys.argv = argv

    def test_only_root_owned_private_records_and_directories_are_protected(self):
        self.assertTrue(production_protected(SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_nlink=1)))
        self.assertTrue(production_protected(SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0, st_nlink=2),
                                             directory=True))
        for mode, owner, links, directory in [
            (stat.S_IFREG | 0o600, 1000, 1, False), (stat.S_IFREG | 0o640, 0, 1, False),
            (stat.S_IFREG | 0o600, 0, 2, False), (stat.S_IFLNK | 0o777, 0, 1, False),
            (stat.S_IFDIR | 0o700, 0, 2, False), (stat.S_IFDIR | 0o750, 0, 2, True),
            (stat.S_IFDIR | 0o700, 1000, 2, True), (stat.S_IFLNK | 0o700, 0, 1, True),
        ]:
            info = SimpleNamespace(st_mode=mode, st_uid=owner, st_nlink=links)
            self.assertFalse(production_protected(info, directory=directory), (oct(mode), owner, links))


if __name__ == '__main__':
    unittest.main()
