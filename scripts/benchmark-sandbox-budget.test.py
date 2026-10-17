"""Invented admission fixtures. No WSL changes, provider calls or private tasks."""
import contextlib
import importlib.machinery
import io
import json
from pathlib import Path
import shutil
import stat
import subprocess
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
        # Windows checkouts cannot make a root-owned 0644 file; the setting
        # path reports one, as the sandbox does.
        class RootOwned(type(Path())):
            def lstat(self):
                super().lstat()
                return types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0)
        budget.HEAVY_CAP = RootOwned(root / 'heavy-cap')
        budget.PEAKS = root / 'peaks.json'
        budget.STATE.mkdir()
        budget.ROOT.mkdir()
        (budget.ROOT / 'memory.current').write_text('0')
        (budget.ROOT / 'pids.current').write_text('0')
        budget.setup = lambda: None
        budget.scratch_headroom = production_scratch_headroom
        self.headroom = (28, 20)
        self.busy = 0
        self.applied = []
        budget.apply_limits = lambda: self.applied.append('applied')
        self.pool = types.SimpleNamespace(f_bavail=8*budget.GIB//4096, f_frsize=4096, f_favail=131072)
        budget.os = types.SimpleNamespace(**vars(production_os))
        budget.os.statvfs = lambda _path: self.pool
        budget.os.getloadavg = lambda: (1.5, 0.75, 0.25)
        budget.os.cpu_count = lambda: 16
        guest = {'/proc/meminfo': root / 'guest-meminfo', '/proc/pressure/cpu': root / 'guest-pressure'}
        budget.Path = lambda value: guest.get(value, Path(value))
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

    def gate(self, ram=None, commit=None, disk=57, age=0, busy=None):
        ram = self.headroom[0] if ram is None else ram
        commit = self.headroom[1] if commit is None else commit
        busy = self.busy if busy is None else busy
        return f'{int(time.time() * 1000)-age},{ram*budget.GIB},{commit*budget.GIB},{disk*budget.GIB},{busy}'

    def roomy(self):
        # Capacity tests run on a host whose Windows headroom covers every
        # claim; the Windows floors have their own tests.
        self.headroom = (60, 60)

    def learn(self, **peaks):
        budget.PEAKS.write_text(json.dumps({kind: [value] * budget.PEAK_SAMPLES for kind, value in peaks.items()}))

    def admit(self, kind, identifier, gate=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            budget.reserve(kind, identifier, int(time.time()*1000)+60000, gate or self.gate())
        return json.loads(output.getvalue())

    def reserve(self, kind, identifier, gate=None):
        return self.admit(kind, identifier, gate)['token']

    def test_status_reports_the_dynamic_policy_and_its_fixed_aggregate(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            budget.status()
        lines = output.getvalue().splitlines()
        for line in ('budget admission dynamic-v1', 'budget heavy-cap off', 'budget memory 25769803776',
                     'budget cpu 1450000/100000', 'budget swap 0', 'budget pids 4224',
                     'budget disk 8589934592', 'budget inodes 131072', 'budget io 1073741824/268435456',
                     'budget job-io heavy 134217728/33554432 prep 134217728/33554432 light 33554432/8388608'):
            self.assertIn(line, lines)

    def test_before_any_peak_is_learned_todays_mix_still_fits(self):
        # Ceilings stand in for unknown needs: two repository sessions, two
        # text sessions and room for one check and one preparation.
        self.roomy()
        for name in ('fictional-a', 'fictional-b'):
            self.reserve('repository', name)
        self.reserve('text', 'fictional-light-a')
        self.reserve('text', 'fictional-light-b')
        with self.assertRaisesRegex(BlockingIOError, 'memory the running jobs claim'):
            self.reserve('text', 'fictional-light-c')
        # Checks and preparation take the room attempts leave.
        self.reserve('check', 'fictional-check')
        self.reserve('prep', 'fictional-prep')

    def test_learned_peaks_admit_as_many_light_jobs_as_memory_and_load_allow(self):
        self.roomy()
        self.learn(text=500 * MIB, repository=2 * budget.GIB, check=budget.GIB, prep=256 * MIB)
        self.assertEqual(budget.expected_memory('text', budget.peaks()), 625 * MIB)
        self.assertEqual(budget.expected_memory('prep', budget.peaks()), 320 * MIB)
        for name in ('fictional-a', 'fictional-b'):
            self.reserve('repository', name)
        for n in range(12):
            self.reserve('text', f'fictional-text-{n}')
        # A running job claims what it really uses when that is more.
        (budget.ROOT / 'session-fictional-a' / 'memory.current').write_text(str(6 * budget.GIB))
        claims = sum(budget.claim(row, budget.peaks()) for row in budget.receipts())
        self.assertEqual(claims, 6 * budget.GIB + int(2.5 * budget.GIB) + 12 * 625 * MIB)
        # Light jobs stop at the measured load line instead of a count.
        self.busy = 700
        with self.assertRaisesRegex(BlockingIOError, 'measured CPU load'):
            self.reserve('text', 'fictional-text-over-load')

    def test_cpu_heavy_jobs_keep_a_check_its_cpus_on_the_cores_the_host_leaves(self):
        self.roomy()
        self.learn(repository=budget.GIB, check=budget.GIB, browser=512 * MIB)
        # Eight cores (sixteen threads): three repository sessions leave one
        # check's two CPUs, and the check then still gets in.
        for name in ('fictional-a', 'fictional-b', 'fictional-c'):
            self.reserve('repository', name)
        with self.assertRaisesRegex(BlockingIOError, 'CPU cores the host leaves free'):
            self.reserve('repository', 'fictional-d')
        self.reserve('check', 'fictional-check')
        with self.assertRaisesRegex(BlockingIOError, 'CPU cores'):
            self.reserve('browser', 'fictional-browser')
        # A host busy with four cores of its own leaves room for one session.
        for row in budget.receipts():
            budget.release(next(path.name[6:-5] for path in budget.STATE.glob('lease-*.json')
                                if json.loads(path.read_text())['id'] == row['id']))
        # (The refused browser check held CPU-heavy attempts for a moment.)
        (budget.STATE / 'priority.json').unlink()
        self.busy = 250
        self.reserve('repository', 'fictional-busy-host')
        with self.assertRaisesRegex(BlockingIOError, 'CPU cores'):
            self.reserve('repository', 'fictional-second-on-busy-host')
        # A browser check still finds its CPU beside it.
        self.reserve('browser', 'fictional-browser')

    def test_a_check_waiting_for_room_holds_back_the_attempts_that_would_take_it(self):
        self.roomy()
        self.learn(repository=budget.GIB, check=budget.GIB, text=512 * MIB, pair=7 * budget.GIB)
        for name in ('fictional-a', 'fictional-b', 'fictional-c'):
            self.reserve('repository', name)
        self.reserve('check', 'fictional-check-a')
        # A second check waits for CPUs: repository attempts wait behind it,
        # text attempts (no CPU ceiling counted) do not.
        with self.assertRaisesRegex(BlockingIOError, 'CPU cores'):
            self.reserve('check', 'fictional-check-b')
        self.reserve('text', 'fictional-text')
        self.assertTrue(budget.priority_waiting('repository'))
        self.assertFalse(budget.priority_waiting('text'))
        # A check waiting for memory holds every attempt back.
        self.headroom = (23, 60)
        with self.assertRaisesRegex(BlockingIOError, 'available RAM'):
            self.reserve('pair', 'fictional-pair')
        self.headroom = (60, 60)
        with self.assertRaisesRegex(BlockingIOError, 'waits for room first'):
            self.reserve('text', 'fictional-text-held')
        # The hold lapses on its own once nothing asks again.
        held = json.loads((budget.STATE / 'priority.json').read_text())
        (budget.STATE / 'priority.json').write_text(json.dumps({key: time.time() - 1 for key in held}))
        self.reserve('text', 'fictional-text-later')

    def test_a_repository_attempt_short_of_memory_holds_new_text_attempts_back(self):
        # Before any peak is learned a text attempt needs 8 GiB of room and a
        # repository attempt 12: text sessions refilling every few minutes
        # would otherwise keep the repository attempt out for good.
        self.roomy()
        texts = [self.reserve('text', f'fictional-text-{n}') for n in range(8)]
        with self.assertRaisesRegex(BlockingIOError, 'memory the running jobs claim'):
            self.reserve('repository', 'fictional-repository')
        self.assertEqual(budget.priority_waiting('text'),
                         'a repository attempt waits for the memory text sessions claim')
        self.assertIsNone(budget.priority_waiting('repository'))
        for token in texts[:3]:
            budget.release(token)
        with self.assertRaisesRegex(BlockingIOError, 'repository attempt waits for the memory'):
            self.reserve('text', 'fictional-text-refill')
        # Checks and preparations are not held by it.
        self.reserve('prep', 'fictional-prep')
        budget.release(next(path.name[6:-5] for path in budget.STATE.glob('lease-*.json')
                            if json.loads(path.read_text())['id'] == 'fictional-prep'))
        self.reserve('repository', 'fictional-repository')
        # Once it is in, the hold is gone.
        self.assertIsNone(budget.priority_waiting('text'))

    def test_a_repository_attempt_text_cannot_make_room_for_holds_nothing(self):
        self.roomy()
        for name in ('fictional-a', 'fictional-b'):
            self.reserve('repository', name)
        with self.assertRaisesRegex(BlockingIOError, 'memory the running jobs claim'):
            self.reserve('repository', 'fictional-c')
        self.assertIsNone(budget.priority_waiting('text'))
        self.reserve('text', 'fictional-text')

    def test_checks_and_preparations_go_ahead_of_a_queued_sign_in(self):
        # A sign-in or probe without a reservation waits in the ticket queue;
        # attempts wait behind it, checks and preparations do not.
        self.roomy()
        ticket = budget.STATE / ('wait-' + 'a' * 32 + '.json')
        ticket.write_text(json.dumps({'pid': budget.os.getpid(), 'start': budget.proc_identity(budget.os.getpid()),
                                      'deadline': time.time() + 60, 'created': time.time_ns()}))
        for kind in ('text', 'repository'):
            with self.assertRaisesRegex(BlockingIOError, 'capacity is queued'):
                self.reserve(kind, f'fictional-{kind}')
        for kind in ('check', 'browser', 'prep'):
            self.reserve(kind, f'fictional-{kind}')
        ticket.unlink()
        self.reserve('text', 'fictional-text')

    def test_unknown_host_cpu_counts_no_load_outside_the_sandbox(self):
        # 1001 (or any share above 1000) is "not sampled": the operator
        # scripts send it, and the line is then the guest's physical cores.
        self.roomy()
        self.busy = 1001
        record = self.admit('repository', 'fictional-a')['admission']
        self.assertIsNone(record['hostCpuBusy'])
        self.assertEqual(record['cpuLine'], 8)
        self.busy = 250
        record = self.admit('text', 'fictional-text')['admission']
        self.assertEqual(record['hostCpuBusy'], 0.25)
        self.assertEqual(record['cpuLine'], 4)

    def test_a_four_field_host_gate_is_refused(self):
        old = f'{int(time.time() * 1000)},{60 * budget.GIB},{60 * budget.GIB},{57 * budget.GIB}'
        with self.assertRaisesRegex(RuntimeError, 'fresh Windows headroom evidence is required'):
            self.reserve('text', 'fictional-text', gate=old)
        bash = shutil.which('bash') if sys.platform != 'win32' else next(
            (str(path) for path in (Path(r'C:\Program Files\Git\bin\bash.exe'),) if path.exists()), None)
        if bash is None:
            self.skipTest('no POSIX bash for bench-run')
        script = source.with_name('bench-run')
        refused = subprocess.run([bash, script.as_posix(), 'login', 'fictional', 'DISTILL_BENCH_HOST_GATE=' + old, '--', 'true'],
                                 capture_output=True, text=True, timeout=30)
        self.assertEqual(refused.returncode, 64, refused.stderr)
        self.assertIn('the host gate needs five fields', refused.stderr)

    def test_the_operator_cap_bounds_cpu_heavy_jobs_without_holding_attempts(self):
        self.roomy()
        self.learn(repository=budget.GIB, check=budget.GIB)
        quiet = io.StringIO()
        with contextlib.redirect_stdout(quiet):
            budget.set_heavy_cap('1')
        self.assertEqual(budget.HEAVY_CAP.read_text(), '1\n')
        self.reserve('repository', 'fictional-a')
        with self.assertRaisesRegex(BlockingIOError, 'operator caps CPU-heavy benchmark jobs at 1'):
            self.reserve('check', 'fictional-check')
        self.assertFalse(budget.priority_waiting('repository'))
        self.reserve('text', 'fictional-text')
        with contextlib.redirect_stdout(quiet):
            budget.set_heavy_cap('off')
        self.assertFalse(budget.HEAVY_CAP.exists())
        self.reserve('check', 'fictional-check')
        for text, cap in (('1', 1), ('8\n', 8), ('off', None), ('off\n', None)):
            self.assertEqual(budget.heavy_cap_from(text), cap)
        for text in ('0', '9', '', 'two', ' 2', '2\n\n', '-1', 'on'):
            with self.assertRaisesRegex(RuntimeError, 'capability_missing:'):
                budget.heavy_cap_from(text)

    def test_admission_records_the_policy_and_what_it_measured(self):
        self.reserve('text', 'fictional-light')
        self.reserve('repository', 'fictional-earlier')
        (budget.ROOT / 'memory.current').write_text(str(3 * budget.GIB))
        self.busy = 125
        record = self.admit('repository', 'fictional-measured', self.gate(ram=60, commit=60))['admission']
        self.assertEqual(record, {
            'policy': 'dynamic-v1', 'heavyCap': None, 'lane': 'heavy',
            'competing': {'text': 1, 'repository': 1}, 'competingHeavy': 1,
            'reservedMemory': 8 * budget.GIB, 'reservedCpu': 2,
            'memoryCurrent': 3 * budget.GIB, 'guestLoad': [1.5, 0.75, 0.25], 'guestCpus': 16,
            'hostAvailableRam': 60 * budget.GIB, 'hostAvailableCommit': 60 * budget.GIB,
            'guestMemAvailable': 32 * budget.GIB, 'hostCpuBusy': 0.125,
            'expectedMemory': 6 * budget.GIB, 'cpuLine': 6, 'sandboxCpu': None,
            'cpuPressure': None, 'checkStall': None})

    def test_windows_floors_count_the_claims_not_yet_in_use(self):
        self.learn(repository=2 * budget.GIB)
        gate = self.gate(ram=29, commit=40)
        self.reserve('repository', 'fictional-a', gate)
        self.reserve('repository', 'fictional-b', gate)
        # Nothing has started using memory yet: the third job needs the 12 GiB
        # desktop floor, its own 2.5 GiB and both earlier 2.5 GiB claims.
        with self.assertRaisesRegex(BlockingIOError, 'available RAM .* 12 GiB desktop floor'):
            self.reserve('repository', 'fictional-c', self.gate(ram=19, commit=40))
        # Once both run, their memory already left Windows' available RAM.
        for name in ('session-fictional-a', 'session-fictional-b'):
            (budget.ROOT / name / 'memory.current').write_text(str(int(2.5 * budget.GIB)))
        self.reserve('repository', 'fictional-c', self.gate(ram=15, commit=40))
        with self.assertRaisesRegex(BlockingIOError, 'commit headroom .* 8 GiB floor'):
            self.reserve('text', 'fictional-light', self.gate(ram=28, commit=9))
        with self.assertRaisesRegex(BlockingIOError, 'less than 30 GiB free'):
            self.reserve('text', 'fictional-light', self.gate(ram=28, commit=40, disk=29))

    def test_finished_jobs_teach_their_class_peak(self):
        (budget.ROOT / 'session-fictional').mkdir()
        for n in range(40):
            (budget.ROOT / 'session-fictional' / 'memory.peak').write_text(str((n + 1) * 10 * MIB))
            budget.record_peak('text', ['session-fictional'])
        recorded = budget.peaks()['text']
        self.assertEqual(len(recorded), budget.PEAK_RING)
        self.assertEqual(recorded[-1], 400 * MIB)
        # 95th percentile of 90..400 MiB is 390 MiB, plus a quarter.
        self.assertEqual(budget.expected_memory('text', budget.peaks()), 390 * MIB + 390 * MIB // 4)
        # Never above the class ceiling, never below 256 MiB, and the ceiling
        # until eight are recorded.
        self.learn(text=4 * budget.GIB, prep=MIB)
        self.assertEqual(budget.expected_memory('text', budget.peaks()), 2 * budget.GIB)
        self.assertEqual(budget.expected_memory('prep', budget.peaks()), 256 * MIB)
        budget.PEAKS.write_text(json.dumps({'check': [MIB] * (budget.PEAK_SAMPLES - 1)}))
        self.assertEqual(budget.expected_memory('check', budget.peaks()), 4 * budget.GIB)
        budget.PEAKS.write_text('not json')
        self.assertEqual(budget.expected_memory('check', budget.peaks()), 4 * budget.GIB)

    def test_checks_that_waited_for_cpus_tighten_the_line(self):
        self.assertEqual(budget.cpu_line(0.0, None), 8)
        self.assertEqual(budget.cpu_line(6.0, 2.0), 4)
        self.assertEqual(budget.cpu_line(15.0, 0.0), budget.CHECK_CPUS)
        leaf = budget.ROOT / 'check-fictional'
        leaf.mkdir()
        (leaf / 'cpu.pressure').write_text('some avg10=0.00 avg60=0.00 avg300=0.00 total=1000000\n'
                                           'full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')
        before = budget.stall_total(['check-fictional'])
        (leaf / 'cpu.pressure').write_text('some avg10=0.00 avg60=0.00 avg300=0.00 total=4000000\n')
        for _ in range(10):
            budget.record_stall('check', ['check-fictional'], time.time() - 10, before)
        self.assertAlmostEqual(budget.recent_stall(), 0.3, places=2)
        self.assertEqual(budget.cpu_line(0.0, None), 8 - budget.CHECK_CPUS)
        # Only checks teach it, and a kernel without pressure files is silent.
        budget.record_stall('text', ['check-fictional'], time.time() - 10, before)
        self.assertEqual(len(json.loads((budget.STATE / 'stalls.json').read_text())), 10)
        self.assertIsNone(budget.stall_total(['missing-leaf']))
        self.assertIsNone(budget.guest_pressure())
        budget.Path('/proc/pressure/cpu').write_text('some avg10=31.50 avg60=1.00 avg300=1.00 total=9\n')
        self.assertEqual(budget.guest_pressure(), 0.315)

    def test_cpu_samples_measure_what_the_jobs_use(self):
        stat = budget.ROOT / 'cpu.stat'
        self.assertIsNone(budget.sandbox_cores())
        clock = [1000.0]
        production_time = budget.time.time
        budget.time.time = lambda: clock[0]
        try:
            for second, used in ((0, 0), (2, 4_000_000), (5, 10_000_000)):
                clock[0] = 1000.0 + second
                stat.write_text(f'usage_usec {used}\nuser_usec 0\n')
                budget.sample_cpu()
            # Two CPUs busy over the five sampled seconds.
            self.assertAlmostEqual(budget.sandbox_cores(), 2.0)
            clock[0] = 1030.0
            self.assertIsNone(budget.sandbox_cores())
        finally:
            budget.time.time = production_time

    def test_every_job_gets_its_own_io_ceiling_and_a_pair_splits_it(self):
        self.roomy()
        self.reserve('repository', 'fictional-repository')
        self.reserve('text', 'fictional-text')
        self.reserve('pair', 'fictional-pair')
        self.assertEqual(self.groups, [
            ('session-fictional-repository', (6 * budget.GIB, 2, 768, 128 * MIB, 32 * MIB)),
            ('session-fictional-text', (2 * budget.GIB, 1, 256, 32 * MIB, 8 * MIB)),
            ('check-fictional-pair', (4 * budget.GIB, 1, 384, 64 * MIB, 16 * MIB)),
            ('probe-fictional-pair', (4 * budget.GIB, 1, 384, 64 * MIB, 16 * MIB))])

    def test_parallel_light_calls_and_one_heavy_share_aggregate_not_serialized(self):
        first = self.reserve('text', 'fictional-one')
        second = self.reserve('text', 'fictional-two')
        heavy = self.reserve('repository', 'fictional-build')
        self.assertEqual(sum(row['memory'] for row in budget.receipts()), 10 * budget.GIB)
        for token in (first, second, heavy):
            budget.release(token)
        self.assertEqual(budget.receipts(), [])

    def test_paired_check_reserves_both_leaves_atomically(self):
        token = self.reserve('pair', 'fictional-pair')
        row = budget.receipts()[0]
        self.assertEqual(row['groups'], ['check-fictional-pair', 'probe-fictional-pair'])
        self.assertEqual(row['memory'], 8 * budget.GIB)
        budget.release(token)
        self.assertFalse((budget.ROOT / 'probe-fictional-pair').exists())

    def test_pending_reservations_close_near_floor_admission_race(self):
        # Both metadata snapshots report 15 GiB available. The first 2 GiB
        # claim is charged before the second can take the same headroom.
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
        # Evidence without the host's CPU share is no evidence.
        legacy = ','.join(self.gate().split(',')[:4])
        with self.assertRaisesRegex(RuntimeError, 'capability_missing:'):
            self.reserve('text', 'fictional-legacy', legacy)

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

    def test_a_settled_jobs_scratch_shows_in_the_free_space_not_its_reservation(self):
        self.roomy()
        self.learn(repository=budget.GIB, check=budget.GIB)
        token = self.reserve('repository', 'fictional-settled')
        self.pool.f_bavail = int(2.6 * budget.GIB) // 4096
        # Just admitted, its 2 GiB reservation still counts: a check waits.
        with self.assertRaisesRegex(BlockingIOError, 'scratch'):
            self.reserve('check', 'fictional-check')
        # Two minutes later what it wrote shows in the free space instead.
        path = budget.STATE / ('lease-' + token + '.json')
        row = json.loads(path.read_text())
        row['admitted'] = time.time() - budget.SCRATCH_SETTLE - 1
        path.write_text(json.dumps(row))
        self.reserve('check', 'fictional-check')

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
