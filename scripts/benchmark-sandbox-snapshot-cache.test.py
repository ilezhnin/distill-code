"""Invented-snapshot regressions for bench-unpack's snapshot cache; no WSL or
provider. Runs on Windows with ownership and mode shims, and with real root
ownership and modes as root on Linux (`sudo python3 -I <this file>`)."""
import contextlib
import importlib.machinery
import io
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from types import SimpleNamespace
import unittest

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[1] / 'src-tauri/resources/benchmark-sandbox/bench-unpack'
unpack = importlib.machinery.SourceFileLoader('benchmark_snapshot_cache_fixture', str(SOURCE)).load_module()
production = SimpleNamespace(os=unpack.os, trusted=unpack.trusted, CACHE=unpack.CACHE,
                             CACHE_BYTES=unpack.CACHE_BYTES, CACHE_ENTRIES=unpack.CACHE_ENTRIES)
LINUX_ROOT = os.name == 'posix' and os.geteuid() == 0


def archive(files):
    """A tar of {path: content} or {path: (content, mode)}, as git archive
    writes one: a directory entry before its files."""
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.PAX_FORMAT) as tar:
        directories = set()
        for path, value in files.items():
            content, mode = value if isinstance(value, tuple) else (value, 0o644)
            parts = path.split('/')
            for depth in range(1, len(parts)):
                directory = '/'.join(parts[:depth])
                if directory not in directories:
                    directories.add(directory)
                    entry = tarfile.TarInfo(directory + '/')
                    entry.type, entry.mode = tarfile.DIRTYPE, 0o755
                    tar.addfile(entry)
            entry = tarfile.TarInfo(path)
            entry.size, entry.mode = len(content), mode
            tar.addfile(entry, io.BytesIO(content))
    return stream.getvalue()


def git(directory, *args, data=None):
    return subprocess.run(['git', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false',
                           '-C', str(directory), *args], input=data, capture_output=True, check=True).stdout


def git_tree(root, files, object_format='sha1'):
    """Git's own tree id for `files` and its archive of that tree."""
    repository = Path(tempfile.mkdtemp(dir=root))
    git(repository, 'init', '-q', '--object-format=' + object_format)
    for path, value in files.items():
        content, mode = value if isinstance(value, tuple) else (value, 0o644)
        blob = git(repository, 'hash-object', '-w', '--stdin', data=content).strip().decode()
        git(repository, 'update-index', '--add', '--cacheinfo',
            ('100755' if mode & 0o111 else '100644') + ',' + blob + ',' + path)
    tree = git(repository, 'write-tree').strip().decode()
    return tree, git(repository, 'archive', '--format=tar', tree)


SNAPSHOT = {'README.md': b'# Invented\n', 'src/main.js': b'console.log(1)\n', 'src/run.sh': (b'#!/bin/sh\n', 0o755),
            'src/lib/util.js': b'', 'a.b': b'1', 'a/b': b'2', 'a-b': b'3', 'a0': b'4',
            'ünicøde/日本.txt': b'u'}


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / 'bench').mkdir(mode=0o700)
        unpack.CACHE = self.root / 'bench' / 'cache'
        self.free = 8 * 1024 ** 3
        self.modes = {}
        facade = {**vars(production.os), 'statvfs': lambda _path: SimpleNamespace(
            f_bavail=self.free // 4096, f_frsize=4096)}
        if not LINUX_ROOT:
            # Windows has neither root nor these open flags, and a read-only
            # file there could not be replaced or removed: record the modes
            # the helper sets and judge entries by them.
            facade.update(geteuid=lambda: 0, O_NOFOLLOW=getattr(os, 'O_NOFOLLOW', 0),
                          O_NONBLOCK=getattr(os, 'O_NONBLOCK', 0),
                          chmod=lambda path, mode: self.modes.__setitem__(os.stat(path).st_ino, mode))
            unpack.trusted = lambda info, mode=None: (
                stat.S_ISDIR(info.st_mode) or self.modes.get(info.st_ino, 0o600) == mode)
        unpack.os = SimpleNamespace(**facade)

    def tearDown(self):
        unpack.os, unpack.trusted, unpack.CACHE = production.os, production.trusted, production.CACHE
        unpack.CACHE_BYTES, unpack.CACHE_ENTRIES = production.CACHE_BYTES, production.CACHE_ENTRIES
        self.temporary.cleanup()

    def directory(self, name):
        path = self.root / name
        path.mkdir()
        return path

    def run_main(self, *arguments, stdin=b''):
        argv, standard_input = sys.argv, sys.stdin
        sys.argv = ['bench-unpack', *map(str, arguments)]
        sys.stdin = SimpleNamespace(buffer=io.BytesIO(stdin))
        self.printed = io.StringIO()
        try:
            with contextlib.redirect_stdout(self.printed):
                return unpack.main()
        finally:
            sys.argv, sys.stdin = argv, standard_input

    def files(self, root):
        return {path.relative_to(root).as_posix(): path.read_bytes() for path in sorted(root.rglob('*')) if path.is_file()}

    def entry(self, tree):
        return unpack.CACHE / (tree + '.tar')

    def read_only(self, path):
        if LINUX_ROOT:
            info = path.lstat()
            return info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o400
        return self.modes.get(path.stat().st_ino) == 0o400

    def test_tree_ids_are_git_s_own_for_sha1_and_sha256(self):
        for object_format in ('sha1', 'sha256'):
            for files in (SNAPSHOT, {'only.txt': b'x'}, {}):
                with self.subTest(object_format=object_format, files=sorted(files)):
                    try:
                        tree, data = git_tree(self.root, files, object_format)
                    except subprocess.CalledProcessError:
                        self.skipTest('this Git has no ' + object_format + ' repositories')
                    self.assertEqual(unpack.unpack(io.BytesIO(data), None, object_format), tree)
                    # The invented archive writer gives the same id as git archive.
                    self.assertEqual(unpack.unpack(io.BytesIO(archive(files)), None, object_format), tree)

    def test_reading_refuses_exactly_what_extracting_refuses(self):
        bad = []
        for files in ([('a', b'file', tarfile.REGTYPE), ('a/b', b'below a file', tarfile.REGTYPE)],
                      [('a/', b'', tarfile.DIRTYPE), ('a', b'over a directory', tarfile.REGTYPE)],
                      [('a', b'file', tarfile.REGTYPE), ('a/', b'', tarfile.DIRTYPE)],
                      [('../outside', b'', tarfile.REGTYPE)], [('link', b'', tarfile.SYMTYPE)],
                      [('same', b'a', tarfile.REGTYPE), ('same', b'b', tarfile.REGTYPE)]):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w') as tar:
                for name, content, kind in files:
                    entry = tarfile.TarInfo(name)
                    entry.type, entry.size = kind, len(content) if kind == tarfile.REGTYPE else 0
                    entry.linkname = 'fictional-target'
                    tar.addfile(entry, io.BytesIO(content) if kind == tarfile.REGTYPE else None)
            bad.append(stream.getvalue())
        for data in bad:
            with self.subTest(data=data[:120]):
                with self.assertRaises(ValueError):
                    unpack.unpack(io.BytesIO(data), None, 'sha1')
                with self.assertRaises(ValueError):
                    unpack.unpack(io.BytesIO(data), self.directory('extract-' + str(len(list(self.root.iterdir())))))

    def test_store_extracts_checks_and_keeps_a_read_only_archive_named_by_its_tree(self):
        tree, data = git_tree(self.root, SNAPSHOT)
        target = self.directory('base')
        self.assertEqual(self.run_main('--tree', tree, target, stdin=data), 0)
        self.assertEqual(self.printed.getvalue().splitlines(), ['cached ' + tree])
        self.assertEqual(self.files(target), self.files_of(SNAPSHOT))
        self.assertEqual(self.entry(tree).read_bytes(), data)
        self.assertTrue(self.read_only(self.entry(tree)))
        self.assertEqual(sorted(path.name for path in unpack.CACHE.iterdir()), [tree + '.tar'])
        if LINUX_ROOT:
            info = unpack.CACHE.lstat()
            self.assertEqual((info.st_uid, stat.S_IMODE(info.st_mode)), (0, 0o700))

    def files_of(self, files):
        return {path: value[0] if isinstance(value, tuple) else value for path, value in sorted(files.items())}

    def test_an_archive_without_its_published_tree_is_refused_and_never_kept(self):
        tree, _ = git_tree(self.root, SNAPSHOT)
        _, other = git_tree(self.root, {**SNAPSHOT, 'README.md': b'# Changed\n'})
        with self.assertRaisesRegex(ValueError, 'does not hold its published tree'):
            self.run_main('--tree', tree, self.directory('base'), stdin=other)
        self.assertEqual(list(unpack.CACHE.iterdir()), [])

    def test_a_cached_copy_is_the_stored_snapshot_and_is_marked_used(self):
        tree, data = git_tree(self.root, SNAPSHOT)
        self.run_main('--tree', tree, self.directory('first'), stdin=data)
        old = time.time() - 3600
        os.utime(self.entry(tree), (old, old))
        second = self.directory('second')
        self.assertEqual(self.run_main('--cached', tree, second), 0)
        self.assertEqual(self.files(second), self.files_of(SNAPSHOT))
        self.assertGreater(self.entry(tree).stat().st_mtime, old + 60)
        if os.name == 'posix':
            self.assertTrue(os.access(second / 'src' / 'run.sh', os.X_OK))
            self.assertFalse(os.access(second / 'README.md', os.X_OK))

    def test_a_miss_writes_nothing(self):
        tree, _ = git_tree(self.root, SNAPSHOT)
        target = self.directory('base')
        self.assertEqual(self.run_main('--cached', tree, target), unpack.NOT_CACHED)
        self.assertEqual(list(target.iterdir()), [])

    def test_an_entry_that_does_not_hold_its_tree_is_removed_and_never_extracted(self):
        tree, data = git_tree(self.root, SNAPSHOT)
        _, other = git_tree(self.root, {'decoy.txt': b'not the snapshot'})
        for index, damaged in enumerate((other, data[:len(data) // 2], b'not an archive')):
            with self.subTest(index=index):
                unpack.cache_directory()
                self.entry(tree).write_bytes(damaged)
                unpack.os.chmod(self.entry(tree), 0o400)
                target = self.directory('base-' + str(index))
                self.assertEqual(self.run_main('--cached', tree, target), unpack.NOT_CACHED)
                self.assertFalse(self.entry(tree).exists())
                self.assertEqual(list(target.iterdir()), [])

    def test_an_entry_others_could_have_changed_is_never_used(self):
        tree, data = git_tree(self.root, SNAPSHOT)
        self.run_main('--tree', tree, self.directory('first'), stdin=data)
        # Writable again, as an entry nobody but its writer should touch.
        if LINUX_ROOT:
            os.chmod(self.entry(tree), 0o644)
        else:
            self.modes[self.entry(tree).stat().st_ino] = 0o644
        target = self.directory('second')
        self.assertEqual(self.run_main('--cached', tree, target), unpack.NOT_CACHED)
        self.assertFalse(self.entry(tree).exists())
        self.assertEqual(list(target.iterdir()), [])
        if LINUX_ROOT:
            self.run_main('--tree', tree, self.directory('third'), stdin=data)
            os.chown(self.entry(tree), 1500, 1500)
            self.assertEqual(self.run_main('--cached', tree, self.directory('fourth')), unpack.NOT_CACHED)
            linked = self.root / 'outside.tar'
            linked.write_bytes(data)
            os.symlink(linked, self.entry(tree))
            self.assertEqual(self.run_main('--cached', tree, self.directory('fifth')), unpack.NOT_CACHED)
            self.assertFalse(self.entry(tree).is_symlink())
            self.assertTrue(linked.exists())

    def test_an_unsafe_cache_directory_is_refused(self):
        unpack.trusted = lambda info, mode=None: False
        with self.assertRaisesRegex(ValueError, 'unsafe benchmark snapshot cache'):
            unpack.cache_directory()
        if LINUX_ROOT:
            unpack.trusted = production.trusted
            unpack.CACHE.mkdir(mode=0o755)
            os.chmod(unpack.CACHE, 0o755)
            with self.assertRaisesRegex(ValueError, 'unsafe benchmark snapshot cache'):
                unpack.cache_directory()

    def test_an_unsafe_cache_directory_degrades_to_an_uncached_copy(self):
        tree, data = git_tree(self.root, SNAPSHOT)
        _, other = git_tree(self.root, {'decoy.txt': b'not the snapshot'})
        if LINUX_ROOT:
            # Writable by others: an entry in it could have been changed.
            unpack.CACHE.mkdir(mode=0o755)
            os.chmod(unpack.CACHE, 0o755)
            planted = self.entry(tree)
            planted.write_bytes(data)
            os.chmod(planted, 0o400)
        else:
            unpack.trusted = lambda info, mode=None: False
        # A sent archive is still checked and copied, and nothing is kept or
        # said: a check's recorded reason must not depend on the cache.
        target = self.directory('base')
        said = io.StringIO()
        with contextlib.redirect_stderr(said):
            self.assertEqual(self.run_main('--tree', tree, target, stdin=data), 0)
        self.assertEqual(self.files(target), self.files_of(SNAPSHOT))
        self.assertEqual((self.printed.getvalue(), said.getvalue()), ('', ''))
        with self.assertRaisesRegex(ValueError, 'does not hold its published tree'):
            self.run_main('--tree', tree, self.directory('wrong'), stdin=other)
        # Nothing is read from it: a cached copy is a miss that writes nothing.
        untouched = self.directory('cached')
        self.assertEqual(self.run_main('--cached', tree, untouched), unpack.NOT_CACHED)
        self.assertEqual(list(untouched.iterdir()), [])
        if LINUX_ROOT:
            self.assertEqual(sorted(path.name for path in unpack.CACHE.iterdir()), [tree + '.tar'])
            self.assertEqual(planted.read_bytes(), data)
        else:
            self.assertFalse(unpack.CACHE.exists())

    def test_eviction_drops_old_and_least_recently_used_entries_only(self):
        cache = unpack.cache_directory()
        now = time.time()
        def entry(name, age, size=1024):
            path = cache / name
            path.write_bytes(b'x' * size)
            os.utime(path, (now - age, now - age))
            return path
        stale = entry('a' * 40 + '.tar', unpack.CACHE_AGE + 60)
        recent = [entry(character * 40 + '.tar', age) for character, age in (('b', 10), ('c', 20), ('d', 30))]
        oldest_kept = entry('e' * 64 + '.tar', 40)
        foreign = entry('operator-notes.txt', unpack.CACHE_AGE + 60)
        dead_spool = entry(unpack.SPOOL + 'killed', unpack.SPOOL_AGE + 60)
        live_spool = entry(unpack.SPOOL + 'storing', 5)
        unpack.CACHE_BYTES = 3 * 1024
        unpack.evict(cache, now)
        self.assertFalse(stale.exists())
        self.assertEqual([path.exists() for path in recent], [True, True, True])
        self.assertFalse(oldest_kept.exists())
        self.assertTrue(foreign.exists())
        self.assertFalse(dead_spool.exists())
        self.assertTrue(live_spool.exists())
        unpack.CACHE_BYTES, unpack.CACHE_ENTRIES = production.CACHE_BYTES, 2
        unpack.evict(cache, now)
        self.assertEqual([path.exists() for path in recent], [True, True, False])

    def test_a_store_keeps_nothing_when_scratch_room_is_short_or_the_archive_large(self):
        tree, data = git_tree(self.root, SNAPSHOT)
        self.free = unpack.CACHE_FLOOR - 1
        target = self.directory('base')
        self.assertEqual(self.run_main('--tree', tree, target, stdin=data), 0)
        self.assertEqual(self.files(target), self.files_of(SNAPSHOT))
        self.assertEqual(list(unpack.CACHE.iterdir()), [])
        # Nothing kept, nothing claimed: the host sends this archive again.
        self.assertEqual(self.printed.getvalue(), '')
        self.free = 8 * 1024 ** 3
        largest, unpack.CACHE_LARGEST = unpack.CACHE_LARGEST, len(data) - 1
        try:
            self.assertEqual(self.run_main('--tree', tree, self.directory('again'), stdin=data), 0)
        finally:
            unpack.CACHE_LARGEST = largest
        self.assertEqual(list(unpack.CACHE.iterdir()), [])

    def test_the_plain_form_still_extracts_without_the_cache(self):
        target = self.directory('staging')
        self.assertEqual(self.run_main(target, stdin=archive(SNAPSHOT)), 0)
        self.assertEqual(self.files(target), self.files_of(SNAPSHOT))
        self.assertFalse(unpack.CACHE.exists())

    def test_a_bad_tree_id_is_refused_before_anything_is_read(self):
        for tree in ('A' * 40, 'a' * 39, 'g' * 40, '../' + 'a' * 37):
            with self.subTest(tree=tree):
                with self.assertRaisesRegex(ValueError, 'full Git object id'):
                    self.run_main('--cached', tree, self.directory('t-' + str(len(list(self.root.iterdir())))))


if __name__ == '__main__':
    if shutil.which('git') is None:
        sys.exit('git is required')
    unittest.main()
