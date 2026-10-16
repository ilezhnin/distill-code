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
MIB = 1024 ** 2


class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        budget.STATE = root / 'leases'
        budget.ROOT = root / 'groups'
        budget.LANES = root / 'heavy-lanes'
        budget.STATE.mkdir()
        budget.ROOT.mkdir()
        (budget.ROOT / 'memory.current').write_text('0')
        budget.setup = lambda: None
        budget.scratch_headroom = production_scratch_headroom
        # The original single-lane policy unless a test widens it. Production
        # reads the root-owned setting file; tests set the value directly.
        self.lanes = 1
        self.headroom = (28, 20)
        budget.heavy_lanes = lambda: self.lanes
        self.applied = []
        budget.apply_limits = self.applied.append
        self.pool = types.SimpleNamespace(f_bavail=8*budget.GIB//4096, f_frsize=4096, f_favail=131072)
        budget.os = types.SimpleNamespace(**vars(production_os))
        budget.os.statvfs = lambda _path: self.pool
        budget.os.getloadavg = lambda: (1.5, 0.75, 0.25)
        budget.os.cpu_count = lambda: 16
        budget.Path = lambda value: root / 'guest-meminfo' if value == '/proc/meminfo' else Path(value)
        (root / 'guest-meminfo').write_text('MemAvailable: 33554432 kB\n')
        self.lock = threading.Lock()
        budget.locked = lambda: self.lock
        self.groups = []
        def child_group(name, *limits):
            self.groups.append((name, limits))
            (budget.ROOT / name).mkdir()
        budget.child_group = child_group
        budget.stop = lambda groups: [shutil.rmtree(budget.ROOT / name, ignore_errors=True) for name in groups]

    def tearDown(self):
        self.temporary.cleanup()

    def gate(self, ram=None, commit=None, disk=57, age=0):
        ram = self.headroom[0] if ram is None else ram
        commit = self.headroom[1] if commit is None else commit
        return f'{int(time.time() * 1000)-age},{ram*budget.GIB},{commit*budget.GIB},{disk*budget.GIB}'

    def widen(self, lanes):
        # Lane capacity tests run on a host whose Windows headroom covers
        # every unstarted reservation; the headroom rule has its own tests.
        self.lanes = lanes
        self.headroom = (60, 60)

    def admit(self, kind, identifier, gate=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            budget.reserve(kind, identifier, int(time.time()*1000)+60000, gate or self.gate())
        return json.loads(output.getvalue())

    def reserve(self, kind, identifier, gate=None):
        return self.admit(kind, identifier, gate)['token']

    def test_each_added_lane_adds_one_repository_envelope(self):
        single, three = budget.limits(1), budget.limits(3)
        self.assertEqual((single['admission'], single['memory'], single['cpu'], single['pids']),
                         (11 * budget.GIB, 12 * budget.GIB, 4, 1408))
        self.assertEqual((single['read'], single['write']), (320 * MIB, 80 * MIB))
        self.assertEqual((three['admission'], three['memory'], three['cpu'], three['pids']),
                         (23 * budget.GIB, 24 * budget.GIB, 8, 2944))
        self.assertEqual((three['read'], three['write']), (576 * MIB, 144 * MIB))
        # Supervisors get their own half CPU above what jobs can reserve.
        self.assertEqual(budget.cpu_max(three), '850000 100000')

    def test_two_lanes_run_two_repositories_and_queue_a_third(self):
        self.widen(2)
        self.reserve('repository', 'fictional-first')
        self.reserve('repository', 'fictional-second')
        self.reserve('text', 'fictional-light')
        with self.assertRaises(BlockingIOError):
            self.reserve('repository', 'fictional-third')
        with self.assertRaises(BlockingIOError):
            self.reserve('check', 'fictional-check')

    def test_three_lanes_hold_three_repositories_beside_two_light_jobs(self):
        self.widen(3)
        for name in ('fictional-a', 'fictional-b', 'fictional-c'):
            self.reserve('repository', name)
        self.reserve('text', 'fictional-light-a')
        self.reserve('text', 'fictional-light-b')
        active = budget.receipts()
        self.assertEqual(sum(row['memory'] for row in active), 22 * budget.GIB)
        self.assertEqual(sum(row['cpu'] for row in active), 8)
        # Preparation would take a CPU or memory some admitted job was promised.
        with self.assertRaises(BlockingIOError):
            self.reserve('prep', 'fictional-prep')

    def test_windows_headroom_covers_every_unstarted_reservation_at_three_lanes(self):
        self.lanes = 3
        gate = self.gate(ram=29, commit=40)
        self.reserve('repository', 'fictional-a', gate)
        self.reserve('repository', 'fictional-b', gate)
        # Nothing has started using memory yet: the third job needs the 12 GiB
        # desktop floor plus its own 6 GiB plus both earlier 6 GiB promises.
        with self.assertRaisesRegex(BlockingIOError, 'available RAM .* 12 GiB desktop floor'):
            self.reserve('repository', 'fictional-c', self.gate(ram=29, commit=40))
        # Once both run, their memory already left Windows' available RAM.
        (budget.ROOT / 'memory.current').write_text(str(12 * budget.GIB))
        self.reserve('repository', 'fictional-c', self.gate(ram=18, commit=40))
        with self.assertRaisesRegex(BlockingIOError, 'available RAM'):
            self.reserve('text', 'fictional-light', self.gate(ram=18, commit=40))
        # Commit headroom follows the same rule with its 8 GiB floor, and
        # the wait names which floor holds it.
        with self.assertRaisesRegex(BlockingIOError, 'commit headroom .* 8 GiB floor'):
            self.reserve('text', 'fictional-light', self.gate(ram=28, commit=9))
        with self.assertRaisesRegex(BlockingIOError, 'less than 30 GiB free'):
            self.reserve('text', 'fictional-light', self.gate(ram=28, commit=40, disk=29))

    def test_admission_records_the_lane_setting_and_competing_load(self):
        self.lanes = 2
        self.reserve('text', 'fictional-light')
        self.reserve('repository', 'fictional-earlier')
        (budget.ROOT / 'memory.current').write_text(str(3 * budget.GIB))
        record = self.admit('repository', 'fictional-measured')['admission']
        self.assertEqual(record, {
            'heavyLanes': 2, 'lane': 'heavy', 'competing': {'text': 1, 'repository': 1},
            'competingHeavy': 1, 'reservedMemory': 8 * budget.GIB, 'reservedCpu': 3,
            'memoryCurrent': 3 * budget.GIB, 'guestLoad': [1.5, 0.75, 0.25], 'guestCpus': 16,
            'hostAvailableRam': 28 * budget.GIB, 'hostAvailableCommit': 20 * budget.GIB,
            'guestMemAvailable': 32 * budget.GIB})

    def test_every_job_gets_its_own_io_ceiling_and_a_pair_splits_it(self):
        self.widen(2)
        self.reserve('repository', 'fictional-repository')
        self.reserve('text', 'fictional-text')
        self.reserve('pair', 'fictional-pair')
        self.assertEqual(self.groups, [
            ('session-fictional-repository', (6 * budget.GIB, 2, 768, 128 * MIB, 32 * MIB)),
            ('session-fictional-text', (2 * budget.GIB, 1, 256, 32 * MIB, 8 * MIB)),
            ('check-fictional-pair', (4 * budget.GIB, 1, 384, 64 * MIB, 16 * MIB)),
            ('probe-fictional-pair', (4 * budget.GIB, 1, 384, 64 * MIB, 16 * MIB))])
        two = budget.limits(2)
        self.assertEqual((two['read'], two['write']), (2 * 128 * MIB + 128 * MIB + 2 * 32 * MIB,
                                                       2 * 32 * MIB + 32 * MIB + 2 * 8 * MIB))

    def test_lane_setting_accepts_only_one_to_three(self):
        for text, lanes in (('1', 1), ('2\n', 2), ('3\n', 3)):
            self.assertEqual(budget.lanes_from(text), lanes)
        for text in ('0', '4', '', 'two', ' 2', '2\n\n', '-1'):
            with self.assertRaisesRegex(RuntimeError, 'capability_missing:'):
                budget.lanes_from(text)

    def test_lane_change_waits_until_admitted_jobs_fit_the_new_budget(self):
        self.widen(3)
        tokens = [self.reserve('repository', name) for name in ('fictional-a', 'fictional-b', 'fictional-c')]
        quiet = io.StringIO()
        with self.assertRaisesRegex(BlockingIOError, 'resource_busy:'):
            with contextlib.redirect_stdout(quiet):
                budget.set_heavy_lanes('1')
        self.assertFalse(budget.LANES.exists())
        self.assertEqual(self.applied, [])
        for token in tokens[1:]:
            budget.release(token)
        with contextlib.redirect_stdout(quiet):
            budget.set_heavy_lanes('1')
        self.assertEqual(budget.LANES.read_text(), '1\n')
        self.assertEqual(self.applied, [budget.limits(1)])
        # Raising never waits: every admitted job fits a larger budget.
        with contextlib.redirect_stdout(quiet):
            budget.set_heavy_lanes('3')
        self.assertEqual(budget.LANES.read_text(), '3\n')
        with self.assertRaisesRegex(RuntimeError, 'capability_missing:'):
            budget.set_heavy_lanes('5')

    def test_status_reports_the_setting_and_its_scaled_budget(self):
        self.lanes = 2
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            budget.status()
        lines = output.getvalue().splitlines()
        for line in ('budget heavy-lanes 2', 'budget memory 19327352832', 'budget cpu 650000/100000',
                     'budget swap 0', 'budget pids 2304', 'budget disk 8589934592', 'budget inodes 131072',
                     'budget io 469762048/117440512',
                     'budget job-io heavy 134217728/33554432 prep 134217728/33554432 light 33554432/8388608'):
            self.assertIn(line, lines)

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
