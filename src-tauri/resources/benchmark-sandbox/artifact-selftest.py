"""Run inside distill-bench: python3 < artifact-selftest.py."""
import base64
import importlib.machinery
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

reader = importlib.machinery.SourceFileLoader('bench_judge', '/usr/local/sbin/bench-judge').load_module()


class ArtifactBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name); self.directory = self.base / 'probe'; self.directory.mkdir()
        self.root = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY); self.addCleanup(os.close, self.root)
        (self.directory / 'file').write_bytes(b'actual bytes')
        (self.base / 'private').write_text('private')

    def read(self, path):
        return reader.read_artifact(self.root, {'path': path})

    def test_regular_private_modes_and_unicode(self):
        nested = self.directory / 'λ space'; nested.mkdir(mode=0o700)
        file = nested / '雪'; file.write_bytes(b'\0\xff'); file.chmod(0o600)
        self.assertEqual(base64.b64decode(self.read('λ space/雪')['data']), b'\0\xff')

    def test_traversal_and_absolute_paths(self):
        for path in ['../private', '/etc/passwd', 'file/../../private', './file', 'a//file', 'a/..', '', 'a\0']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.read(path)

    def test_final_symlink(self):
        (self.directory / 'link').symlink_to(self.base / 'private')
        with self.assertRaises(OSError):
            self.read('link')

    def test_parent_symlink(self):
        (self.directory / 'link').symlink_to(self.base, target_is_directory=True)
        with self.assertRaises(OSError):
            self.read('link/private')

    def test_hardlink(self):
        os.link(self.base / 'private', self.directory / 'link')
        with self.assertRaises(ValueError):
            self.read('link')

    def test_fifo_never_blocks(self):
        os.mkfifo(self.directory / 'fifo')
        with self.assertRaises(ValueError):
            self.read('fifo')

    def test_oversize(self):
        with (self.directory / 'large').open('wb') as file:
            file.truncate(reader.ARTIFACT_LIMIT + 1)
        with self.assertRaises(ValueError):
            self.read('large')

    def test_pinned_root_survives_replacement(self):
        self.directory.rename(self.base / 'old')
        self.directory.symlink_to(self.base)
        self.assertEqual(base64.b64decode(self.read('file')['data']), b'actual bytes')
        with self.assertRaises(FileNotFoundError):
            self.read('private')

    def test_changed_file_is_refused(self):
        actual = os.fstat; count = 0
        def changed(descriptor):
            nonlocal count
            count += 1
            if count == 2:
                (self.directory / 'file').write_bytes(b'changed after read')
            return actual(descriptor)
        with patch.object(reader.os, 'fstat', changed), self.assertRaises(ValueError):
            self.read('file')

    def test_schema(self):
        for request in [None, [], {'path': 'file', 'command': 'ignored'}, {'path': 1}]:
            with self.subTest(request=request), self.assertRaises(ValueError):
                reader.read_artifact(self.root, request)

    def test_channel_framing_and_shutdown(self):
        server, client = socket.socketpair(); client.settimeout(3)
        worker = threading.Thread(target=reader.serve_artifacts, args=(server, os.dup(self.root)))
        worker.start()
        try:
            stream = client.makefile('rwb')
            stream.write(b'{"path":"missing"}\n{bad json}\n{"path":"file"}\n'); stream.flush()
            self.assertEqual(json.loads(stream.readline()), {'error': 'missing'})
            self.assertEqual(json.loads(stream.readline()), {'error': 'refused'})
            self.assertEqual(base64.b64decode(json.loads(stream.readline())['data']), b'actual bytes')
            stream.write(b'x' * 8193); stream.flush()
            self.assertEqual(stream.read(1), b'')
            stream.close()
        finally:
            client.close(); worker.join(3)
        self.assertFalse(worker.is_alive())


if __name__ == '__main__':
    unittest.main(verbosity=2)
