"""Run inside distill-bench; --helper PATH checks a helper before installation."""
import argparse
import base64
import importlib.machinery
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

arguments = argparse.ArgumentParser(add_help=False)
arguments.add_argument('--helper', default='/usr/local/sbin/bench-judge')
options, remaining = arguments.parse_known_args()
sys.argv = [sys.argv[0], *remaining]
reader = importlib.machinery.SourceFileLoader('bench_judge', options.helper).load_module()


class ArtifactBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name); self.directory = self.base / 'probe'; self.directory.mkdir()
        self.root = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY); self.addCleanup(os.close, self.root)
        (self.directory / 'file').write_bytes(b'actual bytes')
        (self.base / 'private').write_text('private')

    def read(self, path):
        return reader.read_artifact(self.root, {'path': path})

    def read_range(self, path, offset, length):
        return reader.read_artifact(self.root,
                                    {'path': path, 'op': 'range', 'offset': offset, 'length': length})

    def metadata(self, path):
        return reader.read_artifact(self.root, {'path': path, 'op': 'stat'})['metadata']

    def listing(self, path):
        return [base64.b64decode(name, validate=True) for name in
                reader.read_artifact(self.root, {'path': path, 'op': 'list'})['entries']]

    def test_listing_names_are_exact_and_links_not_traversed(self):
        nested = self.directory / 'folder'; nested.mkdir()
        (nested / 'z').write_text('ordinary')
        os.symlink(b'/not-present', os.fsencode(nested) + b'/\xff')
        (nested / 'a').symlink_to(self.base, target_is_directory=True)
        self.assertEqual(self.listing('folder'), [b'a', b'z', b'\xff'])
        with self.assertRaises(OSError):
            self.listing('folder/a')
        with self.assertRaises(OSError):
            self.listing('folder/a/private')

    def test_listing_limit_is_enforced(self):
        nested = self.directory / 'folder'; nested.mkdir()
        for number in range(reader.LIST_ENTRY_LIMIT + 1):
            (nested / str(number)).touch()
        with self.assertRaises(ValueError):
            self.listing('folder')

    def test_changed_listing_is_refused(self):
        nested = self.directory / 'folder'; nested.mkdir()
        initial = nested.stat()
        actual = os.fstat; count = 0
        def changed(descriptor):
            nonlocal count
            count += 1
            if count == 2:
                (nested / 'new').touch()
                # Some filesystems coalesce same-tick directory timestamps.
                os.utime(nested, ns=(initial.st_atime_ns, initial.st_mtime_ns + 1_000_000_000))
            return actual(descriptor)
        with patch.object(reader.os, 'fstat', changed), self.assertRaises(ValueError):
            self.listing('folder')

    def test_metadata_modes_and_directory(self):
        file = self.directory / 'file'; file.chmod(0o751)
        self.assertEqual(self.metadata('file'),
                         {'kind': 'file', 'mode': 0o751, 'size': 12, 'links': 1})
        nested = self.directory / 'folder'; nested.mkdir(); nested.chmod(0o700)
        info = self.metadata('folder')
        self.assertEqual((info['kind'], info['mode']), ('directory', 0o700))

    def test_metadata_reads_link_text_without_following(self):
        target = os.fsencode(self.base / 'private')
        os.symlink(target, os.fsencode(self.directory / 'link'))
        info = self.metadata('link')
        self.assertEqual(info['kind'], 'symlink')
        self.assertEqual(base64.b64decode(info['targetBase64']), target)
        self.assertNotIn('data', info)
        with self.assertRaises(OSError):
            self.read('link')
        (self.directory / 'parent').symlink_to(self.base, target_is_directory=True)
        with self.assertRaises(OSError):
            self.metadata('parent/private')

    def test_metadata_preserves_non_utf8_link_text(self):
        os.symlink(b'not-utf8-\xff', os.fsencode(self.directory / 'link'))
        self.assertEqual(base64.b64decode(self.metadata('link')['targetBase64']),
                         b'not-utf8-\xff')

    def test_metadata_special_and_hardlinked_entries_never_read(self):
        os.mkfifo(self.directory / 'fifo')
        self.assertEqual(self.metadata('fifo')['kind'], 'other')
        os.link(self.base / 'private', self.directory / 'linked')
        self.assertEqual(self.metadata('linked')['links'], 2)
        with self.assertRaises(ValueError):
            self.read('linked')

    def test_metadata_replacement_is_not_followed(self):
        link = self.directory / 'link'; link.symlink_to('original')
        actual = os.readlink
        def replaced(path, **kwargs):
            link.unlink(); link.symlink_to(self.base / 'private')
            return actual(path, **kwargs)
        with patch.object(reader.os, 'readlink', replaced), self.assertRaises(ValueError):
            self.metadata('link')

    def test_metadata_link_size_bound(self):
        (self.directory / 'link').symlink_to('small')
        with patch.object(reader.os, 'readlink', return_value=b'x' * (reader.LINK_LIMIT + 1)):
            with self.assertRaises(ValueError):
                self.metadata('link')

    def test_regular_private_modes_and_unicode(self):
        nested = self.directory / 'λ space'; nested.mkdir(mode=0o700)
        file = nested / '雪'; file.write_bytes(b'\0\xff'); file.chmod(0o600)
        self.assertEqual(base64.b64decode(self.read('λ space/雪')['data']), b'\0\xff')

    def test_traversal_and_absolute_paths(self):
        for path in ['../private', '/etc/passwd', 'file/../../private', './file', 'a//file', 'a/..', '', 'a\0']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.read(path)
            with self.subTest(metadata=path), self.assertRaises(ValueError):
                self.metadata(path)
            with self.subTest(listing=path), self.assertRaises(ValueError):
                self.listing(path)

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

    def test_range_reads_large_files_and_exact_endpoints(self):
        size = reader.ARTIFACT_LIMIT + 17
        with (self.directory / 'large').open('wb') as file:
            file.truncate(size)
            file.seek(reader.ARTIFACT_LIMIT - 2)
            file.write(b'cross-boundary')
        result = self.read_range('large', reader.ARTIFACT_LIMIT - 2, 14)
        self.assertEqual(result['size'], size)
        self.assertEqual(base64.b64decode(result['data']), b'cross-boundary')
        result = self.read_range('large', 0, reader.ARTIFACT_LIMIT)
        self.assertEqual(len(base64.b64decode(result['data'])), reader.ARTIFACT_LIMIT)
        self.assertEqual(self.read_range('large', size, 0), {'data': '', 'size': size})
        (self.directory / 'empty').touch()
        self.assertEqual(self.read_range('empty', 0, 0), {'data': '', 'size': 0})

    def test_range_bounds_and_integer_types(self):
        for offset, length in [(-1, 1), (0, -1), (True, 1), (0, False),
                               (1.0, 1), (0, '1'), (None, 0),
                               (0, reader.ARTIFACT_LIMIT + 1), (1 << 63, 0),
                               (13, 0), (12, 1), (11, 2)]:
            with self.subTest(offset=offset, length=length), self.assertRaises(ValueError):
                self.read_range('file', offset, length)

    def test_range_retains_confinement_and_regular_file_checks(self):
        (self.directory / 'link').symlink_to(self.base / 'private')
        (self.directory / 'parent').symlink_to(self.base, target_is_directory=True)
        os.link(self.base / 'private', self.directory / 'hardlink')
        os.mkfifo(self.directory / 'fifo')
        for path in ['../private', '/etc/passwd', 'link', 'parent/private', 'hardlink', 'fifo']:
            with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                self.read_range(path, 0, 1)

    def test_changed_range_is_refused(self):
        actual = os.fstat; count = 0
        def changed(descriptor):
            nonlocal count
            count += 1
            if count == 2:
                (self.directory / 'file').write_bytes(b'changed after read')
            return actual(descriptor)
        with patch.object(reader.os, 'fstat', changed), self.assertRaises(ValueError):
            self.read_range('file', 0, 3)

    def test_pinned_root_survives_replacement(self):
        self.directory.rename(self.base / 'old')
        self.directory.symlink_to(self.base)
        self.assertEqual(base64.b64decode(self.read('file')['data']), b'actual bytes')
        self.assertEqual(self.metadata('file')['size'], 12)
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
        for request in [None, [], {'path': 'file', 'command': 'ignored'}, {'path': 1},
                        {'path': 'file', 'op': 'read'}, {'path': 'file', 'op': True},
                        {'path': 'file', 'op': 'stat', 'extra': 1},
                        {'path': 'file', 'op': 'range', 'offset': 0},
                        {'path': 'file', 'op': 'range', 'offset': 0, 'length': 1, 'extra': 0},
                        {'path': 'file', 'offset': 0, 'length': 1}]:
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
