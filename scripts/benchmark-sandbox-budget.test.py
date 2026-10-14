"""Invented admission fixtures. No WSL changes, provider calls or private tasks."""
import contextlib
import importlib.machinery
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
import tarfile
import threading
import time
import types
import unittest

sys.dont_write_bytecode = True

# fcntl is Linux-only. Tests replace its boundary with a thread lock; production
# source still calls real flock and cgroup kernel files inside Linux.
if sys.platform == 'win32':
    sys.modules['fcntl'] = types.SimpleNamespace()
source = Path(__file__).parent.parent / 'src-tauri/resources/benchmark-sandbox/bench-budget'
budget = importlib.machinery.SourceFileLoader('benchmark_budget_fixture', str(source)).load_module()
unpack = importlib.machinery.SourceFileLoader('benchmark_unpack_fixture', str(source.with_name('bench-unpack'))).load_module()
production_scratch_headroom = budget.scratch_headroom
production_os = budget.os


class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        budget.STATE = root / 'leases'
        budget.ROOT = root / 'groups'
        budget.STATE.mkdir()
        budget.ROOT.mkdir()
        (budget.ROOT / 'memory.current').write_text('0')
        budget.setup = lambda: None
        budget.scratch_headroom = production_scratch_headroom
        self.pool = types.SimpleNamespace(f_bavail=8*budget.GIB//4096, f_frsize=4096, f_favail=131072)
        budget.os = types.SimpleNamespace(**vars(production_os))
        budget.os.statvfs = lambda _path: self.pool
        budget.Path = lambda value: root / 'guest-meminfo' if value == '/proc/meminfo' else Path(value)
        (root / 'guest-meminfo').write_text('MemAvailable: 33554432 kB\n')
        self.lock = threading.Lock()
        budget.locked = lambda: self.lock
        budget.child_group = lambda name, *args: (budget.ROOT / name).mkdir()
        budget.stop = lambda groups: [shutil.rmtree(budget.ROOT / name, ignore_errors=True) for name in groups]

    def tearDown(self):
        self.temporary.cleanup()

    def gate(self, ram=28, commit=20, disk=57, age=0):
        return f'{int(time.time() * 1000)-age},{ram*budget.GIB},{commit*budget.GIB},{disk*budget.GIB}'

    def reserve(self, kind, identifier, gate=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            budget.reserve(kind, identifier, int(time.time()*1000)+60000, gate or self.gate())
        return json.loads(output.getvalue())['token']

    def test_parallel_light_calls_and_one_heavy_share_aggregate_not_serialized(self):
        first = self.reserve('text', 'fictional-one')
        second = self.reserve('text', 'fictional-two')
        heavy = self.reserve('repository', 'fictional-build')
        self.assertEqual(sum(row['memory'] for row in budget.receipts()), 10 * budget.GIB)
        with self.assertRaises(BlockingIOError):
            self.reserve('text', 'fictional-three')
        with self.assertRaises(BlockingIOError):
            self.reserve('browser', 'fictional-browser')
        for token in (first, second, heavy):
            budget.release(token)
        self.assertEqual(budget.receipts(), [])

    def test_paired_check_reserves_both_leaves_atomically(self):
        token = self.reserve('pair', 'fictional-pair')
        row = budget.receipts()[0]
        self.assertEqual(row['groups'], ['check-fictional-pair', 'probe-fictional-pair'])
        self.assertEqual(row['memory'], 8 * budget.GIB)
        self.reserve('text', 'fictional-light')
        with self.assertRaises(BlockingIOError):
            self.reserve('text', 'fictional-over-parent')
        budget.release(token)
        self.assertFalse((budget.ROOT / 'probe-fictional-pair').exists())

    def test_pending_reservations_close_near_floor_admission_race(self):
        # Both metadata snapshots report 15 GiB available. The first 2 GiB
        # reservation is charged before the second can claim an unused slot.
        self.reserve('text', 'fictional-first', self.gate(ram=15))
        with self.assertRaises(BlockingIOError):
            self.reserve('text', 'fictional-second', self.gate(ram=15))

    def test_simultaneous_claims_cannot_both_spend_the_same_windows_headroom(self):
        outcomes = []
        barrier = threading.Barrier(2)
        budget.print = lambda *_args, **_kwargs: None
        def attempt(identifier):
            barrier.wait()
            try:
                budget.reserve('text', identifier, int(time.time()*1000)+60000, self.gate(ram=15))
                outcomes.append('admitted')
            except BlockingIOError:
                outcomes.append('waiting')
        threads = [threading.Thread(target=attempt, args=(name,)) for name in ('fictional-a', 'fictional-b')]
        try:
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=5)
            self.assertEqual(sorted(outcomes), ['admitted', 'waiting'])
        finally:
            del budget.print

    def test_stale_gate_commit_and_actual_sandbox_volume_fail_before_spawn(self):
        for gate in (self.gate(age=6000), self.gate(age=-1500), self.gate(commit=9), self.gate(disk=29)):
            with self.assertRaises(BlockingIOError):
                self.reserve('text', 'fictional-rejected', gate)
            self.assertEqual(budget.receipts(), [])

    def test_shared_guest_memory_floor_protects_other_wsl_workloads(self):
        budget.Path('/proc/meminfo').write_text('MemAvailable: 3145728 kB\n')
        with self.assertRaises(BlockingIOError):
            self.reserve('text', 'fictional-ubuntu-pressure')
        self.assertEqual(budget.receipts(), [])

    def test_low_pool_bytes_or_inodes_wait_before_start_and_include_pending_claims(self):
        self.pool.f_bavail = 128 * 1024 ** 2 // 4096
        with self.assertRaises(BlockingIOError):
            self.reserve('text', 'fictional-low-bytes')
        self.pool.f_bavail = 8 * budget.GIB // 4096
        self.pool.f_favail = 7000
        with self.assertRaises(BlockingIOError):
            self.reserve('text', 'fictional-low-inodes')
        self.pool.f_favail = 131072
        self.reserve('text', 'fictional-pending-files')
        self.pool.f_favail = 10000
        with self.assertRaises(BlockingIOError):
            self.reserve('text', 'fictional-second-files')

    def test_expired_pending_owner_is_reaped_and_live_claim_is_not_released(self):
        token = self.reserve('text', 'fictional-expiry')
        path = budget.STATE / ('lease-' + token + '.json')
        row = json.loads(path.read_text())
        row['pending_until'] = time.time() - 1
        path.write_text(json.dumps(row))
        self.assertEqual(budget.receipts(), [])
        token = self.reserve('text', 'fictional-live')
        path = budget.STATE / ('lease-' + token + '.json')
        row = json.loads(path.read_text())
        row.update(pending=False, pid=123, start='fictional-start')
        path.write_text(json.dumps(row))
        budget.release(token)
        self.assertTrue(path.is_file())

    def test_authoritative_kernel_oom_receipt_survives_leaf_cleanup(self):
        token = self.reserve('text', 'fictional-oom')
        outcomes = budget.STATE / 'outcomes'
        outcomes.mkdir()
        events = budget.ROOT / 'session-fictional-oom' / 'memory.events'
        events.write_text('oom 0\noom_kill 0\n')
        budget.observe('session', 'fictional-oom')
        self.assertFalse((outcomes / (token + '.json')).exists())
        events.write_text('oom 1\noom_kill 1\n')
        budget.observe('session', 'fictional-oom')
        budget.release(token)
        receipt = json.loads((outcomes / (token + '.json')).read_text())
        self.assertEqual(receipt['token'], token)
        self.assertIn('memory ceiling', receipt['infrastructureError'])
        self.assertFalse(events.exists())

    def test_execution_scratch_floor_is_an_infrastructure_error(self):
        self.pool.f_bavail = 32 * 1024 ** 2 // 4096
        with self.assertRaisesRegex(RuntimeError, 'infrastructure_error:'):
            budget.scratch_runtime_floor()
        self.pool.f_bavail = 8 * budget.GIB // 4096
        self.pool.f_favail = 1024
        with self.assertRaisesRegex(RuntimeError, 'infrastructure_error:'):
            budget.scratch_runtime_floor()


class ArchiveTests(unittest.TestCase):
    def extract(self, entries):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:') as archive:
            for name, content, kind in entries:
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.size = len(content) if kind == tarfile.REGTYPE else 0
                entry.linkname = '/outside/fictional-private'
                archive.addfile(entry, io.BytesIO(content) if kind == tarfile.REGTYPE else None)
        with tempfile.TemporaryDirectory() as directory:
            previous_argv, previous_stdin = sys.argv, sys.stdin
            previous_uid = getattr(unpack.os, 'geteuid', None)
            added_flags = []
            for name in ('O_NOFOLLOW',):
                if not hasattr(unpack.os, name):
                    setattr(unpack.os, name, 0)
                    added_flags.append(name)
            try:
                unpack.os.geteuid = lambda: 0
                sys.argv = ['bench-unpack', directory]
                sys.stdin = types.SimpleNamespace(buffer=io.BytesIO(output.getvalue()))
                unpack.main()
                return {str(file.relative_to(directory)): file.read_bytes() for file in Path(directory).rglob('*') if file.is_file()}
            finally:
                sys.argv, sys.stdin = previous_argv, previous_stdin
                if previous_uid is None:
                    del unpack.os.geteuid
                else:
                    unpack.os.geteuid = previous_uid
                for name in added_flags:
                    delattr(unpack.os, name)

    def test_only_data_files_are_created(self):
        self.assertEqual(self.extract([('fixture.txt', b'fictional data', tarfile.REGTYPE)]),
                         {'fixture.txt': b'fictional data'})

    def test_traversal_absolute_links_and_duplicate_paths_are_refused(self):
        for entries in ([('../outside', b'', tarfile.REGTYPE)],
                        [('/outside', b'', tarfile.REGTYPE)],
                        [('link', b'', tarfile.SYMTYPE)],
                        [('hardlink', b'', tarfile.LNKTYPE)],
                        [('same', b'a', tarfile.REGTYPE), ('same', b'b', tarfile.REGTYPE)]):
            with self.assertRaises(ValueError):
                self.extract(entries)


if __name__ == '__main__':
    unittest.main()
