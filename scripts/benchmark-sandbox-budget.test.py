"""Invented admission fixtures. No WSL changes, provider calls or private tasks."""
import contextlib
import importlib.machinery
import io
import json
import os
from pathlib import Path
import re
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
production_stop = budget.stop
production_os = budget.os
MIB = 1024 ** 2


class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        budget.STATE = root / 'leases'
        budget.REAPER_LOG = budget.STATE / 'reaper.err'
        budget.REAPER_PID = root / 'reaper.pid'
        budget.ROOT = root / 'groups'
        # Windows checkouts cannot make a root-owned 0644 file; the setting
        # path reports one, as the sandbox does.
        class RootOwned(type(Path())):
            def lstat(self):
                super().lstat()
                return types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0)
        budget.HEAVY_CAP = RootOwned(root / 'heavy-cap')
        budget.PEAKS = root / 'peaks.json'
        budget.PEAKS_BACKUP = root / 'peaks.json.bak'
        budget.USAGE = root / 'job-usage.jsonl'
        production_cores = budget.sandbox_cores
        self.addCleanup(setattr, budget, 'sandbox_cores', production_cores)
        production_guest = budget.guest_cores
        self.addCleanup(setattr, budget, 'guest_cores', production_guest)
        # The host's own /proc/stat must not decide: no guest sample unless a
        # test writes one.
        budget.PROC_STAT = root / 'guest-stat'
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
        guest = {'/proc/meminfo': root / 'guest-meminfo', '/proc/pressure/cpu': root / 'guest-pressure',
                 '/proc/pressure/memory': root / 'guest-memory-pressure'}
        budget.Path = lambda value: guest.get(value, Path(value))
        (root / 'guest-meminfo').write_text('MemAvailable: 33554432 kB\n')
        self.lock = threading.Lock()
        budget.locked = lambda: self.lock
        self.groups = []
        def child_group(name, *limits):
            self.groups.append((name, limits))
            (budget.ROOT / name).mkdir()
        budget.child_group = child_group
        budget.stop = lambda groups, patient=True: [shutil.rmtree(budget.ROOT / name, ignore_errors=True) for name in groups]

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

    def measure(self, cores):
        # What the benchmark jobs use now, as the CPU samples would show it.
        budget.sandbox_cores = lambda: cores

    def settle(self, kinds=None):
        # Every running job (of `kinds`) was admitted long enough ago that its
        # scratch use shows in the free space instead of its reservation, and
        # its CPU use in the samples.
        for path in budget.STATE.glob('lease-*.json'):
            row = json.loads(path.read_text())
            if kinds is None or row['kind'] in kinds:
                row['admitted'] = time.time() - 300
                path.write_text(json.dumps(row))

    def admit(self, kind, identifier, gate=None, continuing=False):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            budget.reserve(kind, identifier, int(time.time()*1000)+60000, gate or self.gate(), 0, continuing)
        return json.loads(output.getvalue())

    def reserve(self, kind, identifier, gate=None, continuing=False):
        return self.admit(kind, identifier, gate, continuing)['token']

    def test_status_reports_the_dynamic_policy_and_its_fixed_aggregate(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            budget.status()
        lines = output.getvalue().splitlines()
        for line in ('budget admission dynamic-v2', 'budget heavy-cap off', 'budget memory 25769803776',
                     'budget cpu 1500000/100000', 'budget swap 0', 'budget pids 4224',
                     'budget disk 8589934592', 'budget inodes 131072', 'budget io 1073741824/268435456',
                     'budget job-io heavy 134217728/33554432 prep 134217728/33554432 light 33554432/8388608'):
            self.assertIn(line, lines)

    def test_before_any_peak_is_learned_a_wave_starts_at_full_parallelism(self):
        # Repository sessions claim 3 GiB, half their ceiling, and checks
        # 1 GiB, a quarter of theirs, until eight are recorded; every other
        # class its ceiling. Six sessions fit beside room for one check and
        # one preparation, then memory holds the seventh.
        self.roomy()
        self.measure(1.0)
        for n in range(6):
            self.reserve('repository', f'fictional-{n}')
            self.settle()
        with self.assertRaisesRegex(BlockingIOError, 'memory the running jobs claim'):
            self.reserve('repository', 'fictional-seventh')
        self.assertEqual(budget.expected_memory('repository', budget.peaks()), 3 * budget.GIB)
        self.assertEqual(budget.expected_memory('check', budget.peaks()), budget.GIB)
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

    def test_sessions_using_their_cpus_still_get_todays_ceiling_rule(self):
        self.roomy()
        self.learn(repository=budget.GIB, check=budget.GIB, browser=512 * MIB)
        # Sessions busy with twelve CPUs leave the measured rule no room;
        # the ceiling rule of earlier builds still admits three on eight
        # cores (sixteen threads), leaving one check's two CPUs.
        self.measure(12.0)
        for name in ('fictional-a', 'fictional-b', 'fictional-c'):
            self.assertEqual(self.admit('repository', name)['admission']['admittedBy'], 'ceilings')
        with self.assertRaisesRegex(BlockingIOError, 'CPU cores the host leaves free'):
            self.reserve('repository', 'fictional-d')
        # A check still fits today's line; past it, timed jobs count their
        # ceilings against the logical CPUs and the sessions' allowances, and
        # the weights give them the CPU first.
        self.assertEqual(self.admit('check', 'fictional-check')['admission']['admittedBy'], 'ceilings')
        self.assertEqual(self.admit('browser', 'fictional-browser')['admission']['admittedBy'], 'measured')
        for row in budget.receipts():
            budget.release(next(path.name[6:-5] for path in budget.STATE.glob('lease-*.json')
                                if json.loads(path.read_text())['id'] == row['id']))
        # A host busy with four CPUs of its own and no sample yet: the
        # sessions' ceilings stand in for their use. 11 logical CPUs are left.
        self.measure(None)
        self.busy = 250
        admitted = [self.admit('repository', f'fictional-busy-{n}')['admission'] for n in range(4)]
        self.assertEqual([record['admittedBy'] for record in admitted],
                         ['ceilings', 'measured', 'measured', 'measured'])
        self.assertEqual(admitted[0]['cpuCapacity'], 11)
        with self.assertRaisesRegex(BlockingIOError, 'CPU cores'):
            self.reserve('repository', 'fictional-busy-4')
        # A browser check still finds its CPU beside them.
        self.reserve('browser', 'fictional-browser')

    def test_repository_sessions_are_admitted_by_measured_use_without_a_count(self):
        # Owner decision 2026-10-17: no fixed number of sessions; the measured
        # CPUs, the memory claims and guard and the pressure lines decide.
        self.roomy()
        self.learn(repository=budget.GIB, check=budget.GIB, prep=256 * MIB)
        self.measure(1.0)
        records = []
        for n in range(9):
            records.append(self.admit('repository', f'fictional-{n}')['admission'])
            self.settle()
        self.assertEqual([record['admittedBy'] for record in records], ['ceilings'] * 3 + ['measured'] * 6)
        self.assertEqual(records[-1]['repositorySessions'], 8)
        self.assertEqual(records[-1]['sessionBurst'], 0.5)
        # Checks beside them: each takes its two CPUs from the logical line
        # the sessions' allowances leave (15 - 9 x 0.5 = 10.5: five checks).
        for n in range(5):
            self.reserve('check', f'fictional-check-{n}')
        with self.assertRaisesRegex(BlockingIOError, 'CPU cores'):
            self.reserve('check', 'fictional-check-5')

    def test_sessions_too_new_to_be_measured_count_at_their_ceilings(self):
        # A wave start admits what the CPUs cover at the new sessions'
        # ceilings, not a burst of sessions admitted before any shows in the
        # samples; once measured, each costs its burst allowance.
        self.roomy()
        self.learn(repository=budget.GIB, check=budget.GIB, prep=256 * MIB)
        self.measure(1.0)
        self.busy = 375  # 6 of 16 busy, 5 outside the VM: 16 - 5 - 1 = 10
        admitted = 0
        while True:
            try:
                self.reserve('repository', f'fictional-new-{admitted}')
            except BlockingIOError as busy:
                self.assertIn('CPU cores', str(busy))
                break
            admitted += 1
        # 1 used + the new one's 0.5 + 2 per unsettled session + a check's 2
        # must fit 10: four sessions at once, then the settled ones cost 0.5.
        self.assertEqual(admitted, 4)
        self.settle()
        for n in range(8):
            self.reserve('repository', f'fictional-settled-{n}')
            self.settle()

    def test_cpu_pressure_and_check_stalls_hold_new_sessions_above_the_ceiling_rule(self):
        self.roomy()
        self.learn(repository=budget.GIB, check=budget.GIB, prep=256 * MIB)
        self.measure(1.0)
        for name in ('fictional-a', 'fictional-b', 'fictional-c'):
            self.reserve('repository', name)
        # A job whose tasks waited for CPUs other jobs held for more than a
        # tenth of the sampled seconds holds new sessions beyond the ceiling
        # rule.
        def sampled(before, now):
            at = time.time()
            (budget.STATE / 'cpu.json').write_text(json.dumps([
                [at - 10, 0, None, {'session-fictional-b': before}],
                [at - 0.5, 0, None, {'session-fictional-b': now}]]))
        sampled(0, 1_500_000)
        with self.assertRaisesRegex(BlockingIOError, 'CPU pressure in the sandbox'):
            self.reserve('repository', 'fictional-d')
        sampled(0, 500_000)
        self.assertAlmostEqual(budget.job_pressure(), 0.05 / 0.95, places=3)
        record = self.admit('repository', 'fictional-d')['admission']
        self.assertEqual(record['admittedBy'], 'measured')
        # 10-17: a check at its own cpu.max ceiling (it starts as many workers
        # as the guest has CPUs) read as pressure and held every session,
        # preparation and text attempt. Its throttled time is its own.
        leaf = budget.ROOT / 'check-fictional-busy'
        leaf.mkdir()
        (leaf / 'cpu.pressure').write_text('some avg10=95.00 avg60=1.00 avg300=1.00 total=4000000\n')
        (leaf / 'cpu.max').write_text('200000 100000\n')
        (leaf / 'cpu.stat').write_text('usage_usec 8000000\nnr_throttled 39\nthrottled_usec 54600000\n')
        self.assertEqual(budget.leaf_wait(leaf), 100_000)
        # Its throttled_usec, summed over every CPU's runqueue, can exceed the
        # wall time; what it waited outside its throttled periods still counts.
        (leaf / 'cpu.stat').write_text('usage_usec 8000000\nnr_throttled 1\nthrottled_usec 40000000\n')
        self.assertEqual(budget.leaf_wait(leaf), 3_900_000)
        # The supervisors' own control group never counts.
        (budget.ROOT / 'control').mkdir()
        (budget.ROOT / 'control' / 'cpu.pressure').write_text('some avg10=40.00 avg60=1.00 avg300=1.00 total=9\n')
        self.assertNotIn('control', budget.leaf_waits())
        self.assertEqual(budget.leaf_waits()['check-fictional-busy'], 3_900_000)
        # Checks that waited for CPUs hold new sessions too, while their
        # stalls are recent; older ones, and the old format, hold nothing.
        (budget.STATE / 'stalls.json').write_text(json.dumps([[time.time(), 0.3]] * 10))
        with self.assertRaisesRegex(BlockingIOError, 'CPU pressure in the sandbox'):
            self.reserve('repository', 'fictional-e')
        (budget.STATE / 'stalls.json').write_text(json.dumps([[time.time() - budget.STALL_WINDOW - 1, 0.3]] * 10))
        self.assertIsNone(budget.recent_stall())
        (budget.STATE / 'stalls.json').write_text(json.dumps([0.1125, 0.2143]))
        self.assertIsNone(budget.recent_stall())

    def test_measured_memory_use_or_pressure_holds_new_attempts(self):
        # The smaller initial claims are guarded by what the sandbox uses:
        # above 70 % of the admission memory, or with memory pressure above a
        # tenth, no attempt starts; checks and preparations still do.
        self.roomy()
        (budget.ROOT / 'memory.current').write_text(str(17 * budget.GIB))
        for kind in ('repository', 'text'):
            with self.assertRaisesRegex(BlockingIOError, 'memory in use or memory pressure'):
                self.reserve(kind, f'fictional-{kind}')
        self.reserve('check', 'fictional-check')
        self.reserve('prep', 'fictional-prep')
        (budget.ROOT / 'memory.current').write_text(str(15 * budget.GIB))
        pressure = budget.Path('/proc/pressure/memory')
        pressure.write_text('some avg10=12.50 avg60=1.00 avg300=1.00 total=9\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')
        with self.assertRaisesRegex(BlockingIOError, 'memory in use or memory pressure'):
            self.reserve('text', 'fictional-text')
        pressure.write_text('some avg10=4.00 avg60=1.00 avg300=1.00 total=9\n')
        self.reserve('text', 'fictional-text')
        self.assertEqual(budget.guest_pressure('memory'), 0.04)
        # Page cache is not in use: a wave's cache, reparented from finished
        # jobs, fills the root's memory.current long before reclaim; anonymous,
        # shared and kernel memory are what the guard counts.
        (budget.ROOT / 'memory.current').write_text(str(18 * budget.GIB))
        stat = budget.ROOT / 'memory.stat'
        stat.write_text(f'anon {4 * budget.GIB}\nfile {13 * budget.GIB}\nkernel {budget.GIB // 2}\nshmem 1024\n')
        self.reserve('text', 'fictional-cached')
        stat.write_text(f'anon {16 * budget.GIB}\nfile {budget.GIB}\nkernel {budget.GIB // 2}\nshmem 1024\n')
        with self.assertRaisesRegex(BlockingIOError, 'memory in use or memory pressure'):
            self.reserve('text', 'fictional-anonymous')
        # Kernels before 5.18 report kernel memory in parts.
        stat.write_text(f'anon {15 * budget.GIB}\nfile 0\nkernel_stack {budget.GIB}\nslab {budget.GIB}\n')
        self.assertEqual(budget.memory_in_use(), 17 * budget.GIB)

    def test_a_later_workflow_step_goes_ahead_of_new_attempts(self):
        # Its earlier steps are paid for: the room kept for waiting jobs and
        # the CPU pressure and check-stall guards hold new attempts, not it;
        # memory and the Windows floors still bound it.
        self.roomy()
        self.learn(repository=budget.GIB, text=512 * MIB, check=budget.GIB, prep=256 * MIB)
        self.measure(1.0)
        budget.hold('memory', time.time() + 60, budget.ADMISSION_MEMORY)
        with self.assertRaisesRegex(BlockingIOError, 'waits for room first'):
            self.reserve('text', 'fictional-new-text')
        record = self.admit('text', 'fictional-step-text', continuing=True)['admission']
        self.assertTrue(record['continuing'])
        budget.hold('memory')
        # A queued job keeps only the room it was refused: an attempt starts
        # beside a queue whose head asked for nothing it would take.
        ticket = budget.STATE / ('wait-' + 'b' * 32 + '.json')
        ticket.write_text(json.dumps({'pid': budget.os.getpid(), 'start': budget.proc_identity(budget.os.getpid()),
                                      'deadline': time.time() + 60, 'created': time.time_ns()}))
        self.reserve('repository', 'fictional-new-queued')
        self.reserve('repository', 'fictional-step-queued', continuing=True)
        ticket.unlink()
        for n in range(6):
            self.reserve('repository', f'fictional-{n}')
            self.settle()
        # A job whose tasks wait for CPUs other jobs hold keeps new sessions
        # out, not a later step.
        at = time.time()
        (budget.STATE / 'cpu.json').write_text(json.dumps([
            [at - 10, 0, None, {'session-fictional-0': 0}],
            [at - 0.5, 0, None, {'session-fictional-0': 3_000_000}]]))
        with self.assertRaisesRegex(BlockingIOError, 'CPU pressure'):
            self.reserve('repository', 'fictional-new-pressed')
        self.reserve('repository', 'fictional-step-pressed', continuing=True)
        (budget.STATE / 'cpu.json').unlink()
        self.settle()
        # Memory still bounds it, and a refused later step holds new attempts
        # back so it takes the next freed room.
        (budget.ROOT / 'memory.current').write_text('0')
        budget.ADMISSION_MEMORY, production_memory = 12 * budget.GIB, budget.ADMISSION_MEMORY
        try:
            with self.assertRaisesRegex(BlockingIOError, 'memory the running jobs claim'):
                self.reserve('repository', 'fictional-step-full', continuing=True)
        finally:
            budget.ADMISSION_MEMORY = production_memory
        self.assertEqual(budget.priority_waiting('text'), 'a check or preparation waits for room first')

    def test_a_group_that_vanishes_has_stopped(self):
        # The job's supervisor and the reaper remove groups too, so a group
        # can go between bench-kill's test and its kill write, or between
        # observe's and stop()'s reads. That is a stopped group, not a failed
        # cleanup: g6 lost attempts to "cgroup.kill: No such file or directory".
        gone = budget.ROOT / 'session-fictional-gone'
        self.assertFalse(budget.populated(gone))
        budget.stop = production_stop
        self.assertTrue(budget.stop(['session-fictional-gone']))
        self.assertIsNone(budget.observe('session', 'fictional-gone'))
        bash = shutil.which('bash') if sys.platform != 'win32' else next(
            (str(path) for path in (Path(r'C:\Program Files\Git\bin\bash.exe'),) if path.exists()), None)
        if bash is None:
            self.skipTest('no POSIX bash for bench-kill')
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            group = work / 'cgroups' / 'session-fictional'
            group.mkdir(parents=True)
            (group / 'cgroup.procs').write_text('')
            # The observation is where the group goes: its supervisor removes
            # it meanwhile.
            observe = work / 'observe'
            observe.write_text(f'#!/bin/bash\nrm -rf "{group.as_posix()}"\n', newline='\n')
            observe.chmod(0o755)
            killer = work / 'bench-kill'
            killer.write_text(source.with_name('bench-kill').read_text()
                              .replace('/sys/fs/cgroup/distill-bench', (work / 'cgroups').as_posix())
                              .replace('/usr/local/sbin/bench-budget', observe.as_posix()),
                              newline='\n')
            stopped = subprocess.run([bash, killer.as_posix(), 'session', 'fictional'],
                                     capture_output=True, text=True, timeout=60)
            self.assertEqual(stopped.returncode, 0, stopped.stderr)
            self.assertNotIn('No such file', stopped.stderr)
            self.assertFalse(group.exists())

    def test_a_group_with_exiting_tasks_is_left_for_the_next_reap(self):
        # cgroup.procs can read empty while exiting tasks still populate the
        # group, and rmdir then fails with EBUSY. That must not fail another
        # job's admission: the expired lease stays until its group is gone.
        import errno as errnos
        busy = {'count': 0}

        class Group(type(Path())):
            def rmdir(self):
                if busy['count']:
                    busy['count'] -= 1
                    raise OSError(errnos.EBUSY, 'Device or resource busy', str(self))
                shutil.rmtree(self)
        budget.ROOT = Group(budget.ROOT)
        budget.stop = production_stop
        budget.RMDIR_RETRY, production_retry = 0.2, budget.RMDIR_RETRY
        self.addCleanup(setattr, budget, 'RMDIR_RETRY', production_retry)
        leaf = budget.ROOT / 'session-fictional-old'
        leaf.mkdir()
        (leaf / 'cgroup.procs').write_text('')
        (leaf / 'cgroup.events').write_text('populated 0\nfrozen 0\n')
        lease = budget.STATE / ('lease-' + 'c' * 32 + '.json')
        lease.write_text(json.dumps({'pid': 2 ** 30, 'start': 'gone', 'deadline': time.time() + 60, 'kind': 'text',
                                     'id': 'fictional-old', 'groups': ['session-fictional-old'], 'memory': 0,
                                     'cpu': 1, 'pids': 1, 'lane': 'light'}))
        busy['count'] = 10 ** 6
        self.assertEqual(budget.receipts(), [])
        self.assertTrue(lease.exists() and leaf.exists())
        self.assertIn('busy_since', json.loads(lease.read_text()))
        # Once found busy it is tried once per reap, without the wait.
        busy['count'] = 1
        self.assertEqual(budget.receipts(), [])
        self.assertTrue(lease.exists() and leaf.exists())
        # Free at last: removed, and the lease goes.
        self.assertEqual(budget.receipts(), [])
        self.assertFalse(lease.exists() or leaf.exists())
        # Busy for a moment only on a first stop: removed on the retry.
        again = budget.ROOT / 'session-fictional-brief'
        again.mkdir()
        (again / 'cgroup.procs').write_text('')
        busy['count'] = 2
        self.assertTrue(budget.stop(['session-fictional-brief']))
        self.assertFalse(again.exists())
        # Exiting tasks show in cgroup.events even when cgroup.procs is empty.
        exiting = budget.ROOT / 'session-fictional-exiting'
        exiting.mkdir()
        (exiting / 'cgroup.procs').write_text('')
        (exiting / 'cgroup.events').write_text('populated 1\nfrozen 0\n')
        self.assertTrue(budget.populated(exiting))
        (exiting / 'cgroup.events').unlink()
        self.assertFalse(budget.populated(exiting))
        shutil.rmtree(exiting)

    def test_a_process_in_the_root_group_is_named_not_waited_for(self):
        # The kernel refuses to enable controllers while a process sits in
        # the parent group itself; that lasts, so it must not read as the
        # transient EBUSY the app requeues on.
        import errno as errnos
        parent = budget.ROOT / 'fictional-parent'
        parent.mkdir()
        (parent / 'cgroup.subtree_control').write_text('cpu\n')
        production_write = budget.write
        self.addCleanup(setattr, budget, 'write', production_write)

        def write(path, value):
            if path.name == 'cgroup.subtree_control':
                raise OSError(errnos.EBUSY, 'Device or resource busy', str(path))
            production_write(path, value)
        budget.write = write
        with self.assertRaises(RuntimeError) as refused:
            budget.enable_controllers(parent)
        self.assertIn('capability_missing: a process sits in', str(refused.exception))
        self.assertNotIn('Errno 16', str(refused.exception))
        # Enabled already: nothing is written.
        (parent / 'cgroup.subtree_control').write_text('cpu io memory pids\n')
        budget.enable_controllers(parent)

    def test_a_stuck_or_vanishing_group_never_fails_or_stalls_another_call(self):
        # A task that survives cgroup.kill keeps its group populated for
        # minutes; bench-kill removes groups outside the broker lock. Neither
        # may fail a reserve, and a group already found stuck costs no wait.
        budget.stop = production_stop
        stuck = budget.ROOT / 'session-fictional-stuck'
        stuck.mkdir()
        (stuck / 'cgroup.procs').write_text('4711\n')
        (stuck / 'cgroup.events').write_text('populated 1\nfrozen 0\n')
        lease = budget.STATE / ('lease-' + 'd' * 32 + '.json')
        lease.write_text(json.dumps({'pid': 2 ** 30, 'start': 'gone', 'deadline': time.time() + 60, 'kind': 'text',
                                     'id': 'fictional-stuck', 'groups': ['session-fictional-stuck'], 'memory': 0,
                                     'cpu': 1, 'pids': 1, 'lane': 'light', 'busy_since': time.time() - 60}))
        started = time.monotonic()
        self.assertEqual(budget.receipts(), [])
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertTrue(lease.exists() and stuck.exists())
        # A group that vanished, or vanishes, is gone, not an error.
        self.assertFalse(budget.populated(budget.ROOT / 'session-fictional-gone'))
        self.assertTrue(budget.stop(['session-fictional-gone']))
        shutil.rmtree(stuck)
        lease.unlink()

    def test_the_first_admission_after_boot_waits_for_the_scratch_mount(self):
        # The boot command's bench-net may still be mounting the scratch disk
        # when the app's first reserve arrives: that waits for bench-net's lock
        # instead of failing with "findmnt -M /srv/bench exit 1".
        lock = Path(self.temporary.name) / 'distill-bench-net'
        lock.write_text('')
        production = (budget.NET_LOCK, budget.fcntl, budget.scratch_mount)
        self.addCleanup(lambda: [setattr(budget, name, value) for name, value in
                                 zip(('NET_LOCK', 'fcntl', 'scratch_mount'), production)])
        budget.NET_LOCK = lock
        busy = {'left': 3}

        def flock(_handle, _flags):
            if busy['left']:
                busy['left'] -= 1
                raise BlockingIOError
        budget.fcntl = types.SimpleNamespace(flock=flock, LOCK_SH=1, LOCK_NB=4)
        mounts = [[], ['ext4', '/dev/loop7', 'rw,nosuid,nodev']]
        budget.scratch_mount = lambda: mounts.pop(0) if busy['left'] == 0 or len(mounts) == 2 else []
        self.assertEqual(budget.scratch_mount(), [])
        budget.wait_for_net_setup()
        self.assertEqual(busy['left'], 0)
        self.assertEqual(budget.scratch_mount(), ['ext4', '/dev/loop7', 'rw,nosuid,nodev'])
        # bench-net's own setup never waits for the lock it holds.
        busy['left'] = 5
        budget.os.environ = dict(budget.os.environ, DISTILL_BENCH_NET_LOCKED='1')
        budget.wait_for_net_setup()
        self.assertEqual(busy['left'], 5)

    def test_installing_helpers_stops_the_reaper_that_holds_the_old_code(self):
        # A reaper keeps its helpers in memory and holds its lock, so a fresh
        # one would exit at once after new helpers: install-helpers.sh ends it
        # (found by command line, whatever its era) before setup starts anew.
        proc = Path(self.temporary.name) / 'proc'
        for pid, argv in ((100, [b'/usr/bin/python3', b'/usr/local/sbin/bench-budget', b'reap', b'--daemon']),
                          (101, [b'/usr/bin/python3', b'/usr/local/sbin/bench-budget', b'status']),
                          (102, [b'/bin/bash', b'/usr/local/sbin/bench-run'])):
            (proc / str(pid)).mkdir(parents=True)
            (proc / str(pid) / 'cmdline').write_bytes(b'\0'.join(argv) + b'\0')
        production = (budget.Path, budget.fcntl, budget.signal)
        self.addCleanup(lambda: setattr(budget, 'Path', production[0]) or setattr(budget, 'fcntl', production[1])
                        or setattr(budget, 'signal', production[2]))
        routed = budget.Path
        budget.Path = lambda value: proc if value == '/proc' else routed(value)
        signals = []
        held = {'until': None}

        def kill(pid, sent):
            signals.append((pid, sent))
            if sent == held['until']:
                held['until'] = 'free'

        def flock(_handle, _flags):
            if held['until'] != 'free':
                raise BlockingIOError
        budget.os.kill = kill
        budget.signal = types.SimpleNamespace(SIGTERM='TERM', SIGKILL='KILL')
        budget.fcntl = types.SimpleNamespace(flock=flock, LOCK_EX=2, LOCK_NB=4)
        budget.REAPER_PID.write_text('17\n')
        held['until'] = 'TERM'
        self.assertEqual(budget.stop_reaper(), 1)
        self.assertEqual(signals, [(100, 'TERM')])
        self.assertFalse(budget.REAPER_PID.exists())
        # One that ignores SIGTERM is killed after five seconds.
        signals.clear()
        held['until'] = 'KILL'
        clock = {'now': 0.0}
        budget.time = types.SimpleNamespace(time=time.time, sleep=lambda s: clock.update(now=clock['now'] + s),
                                            monotonic=lambda: clock['now'])
        self.addCleanup(setattr, budget, 'time', time)
        self.assertEqual(budget.stop_reaper(), 1)
        self.assertEqual(signals, [(100, 'TERM'), (100, 'KILL')])

    def test_a_reaper_that_keeps_failing_gives_way_and_says_why(self):
        # A failure that lasts must not hide behind a live pid: after twelve
        # failed passes the reaper removes its pid and exits, so bench-net
        # starts a fresh one, and its bounded log names the error.
        (budget.ROOT / 'control').mkdir()
        sleeps = []

        def reap_pass():
            raise ValueError('an owner file nobody can read')
        production = (budget.reap_pass, budget.time, budget.fcntl, sys.argv)

        def restore():
            budget.reap_pass, budget.time, budget.fcntl, sys.argv = production
            vars(budget).pop('open', None)
        self.addCleanup(restore)
        budget.reap_pass = reap_pass
        budget.time = types.SimpleNamespace(time=time.time, monotonic=time.monotonic, sleep=sleeps.append)
        budget.fcntl = types.SimpleNamespace(flock=lambda *_: None, LOCK_EX=2, LOCK_NB=4)
        budget.open = lambda *_args, **_options: io.StringIO()
        sys.argv = ['bench-budget', 'reap', '--daemon']
        self.assertEqual(budget.reap(), 70)
        self.assertEqual(len(sleeps), budget.REAPER_FAILURES - 1)
        self.assertFalse(budget.REAPER_PID.exists())
        self.assertEqual(budget.reaper_state(), 'down')
        log = budget.REAPER_LOG.read_text().splitlines()
        self.assertEqual(len(log), budget.REAPER_LOG_LINES - 8)
        self.assertIn('pass failed (12/12): ValueError: an owner file nobody can read', log[-1])
        # The log stays bounded however long the failures go on.
        for _ in range(3 * budget.REAPER_LOG_LINES):
            budget.note_reaper('invented failure')
        kept = len(budget.REAPER_LOG.read_text().splitlines())
        self.assertTrue(budget.REAPER_LOG_LINES <= kept <= 2 * budget.REAPER_LOG_LINES, kept)

    def test_bench_net_takes_the_fast_path_only_for_the_reaper_it_started(self):
        # The pid space wraps: a live process under the reaper's old pid is
        # not the reaper unless its start time matches too.
        bash = shutil.which('bash') if sys.platform != 'win32' else next(
            (str(path) for path in (Path(r'C:\Program Files\Git\bin\bash.exe'),) if path.exists()), None)
        if bash is None:
            self.skipTest('no POSIX bash for bench-net')
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory)
            for folder in ('run/netns', 'sys/class/net', 'sys/fs/cgroup/distill-bench/control',
                           'proc/sys/kernel/random', 'proc/4711'):
                (fake / folder).mkdir(parents=True)
            (fake / 'run/netns/bench').write_text('')
            (fake / 'sys/class/net/bench0').write_text('')
            # Linux files end lines with \n alone, as the shell reads them.
            (fake / 'proc/sys/kernel/random/boot_id').write_text('invented-boot\n', newline='\n')
            (fake / 'run/distill-bench-net.ready').write_text('invented-boot\n', newline='\n')
            fields = ['S'] + [str(field) for field in range(4, 22)] + ['12345'] + ['0'] * 8
            (fake / 'proc/4711/stat').write_text('4711 (python3 a) b) ' + ' '.join(fields) + '\n', newline='\n')
            net = fake / 'bench-net'
            text = source.with_name('bench-net').read_text()
            # Stop where the full setup would start; only the fast path runs.
            text = text.replace('mkdir -p /run/lock', 'exit 3')
            text = re.sub(r'(?<![\w/.-])/(run|proc|sys)/', lambda m: (fake / m.group(1)).as_posix() + '/', text)
            net.write_text(text, newline='\n')
            for line, expected in (('4711 12345', 0), ('4711 99999', 3), ('4711', 3), ('4712 12345', 3)):
                (fake / 'run/distill-bench-reaper.pid').write_text(line + '\n', newline='\n')
                ran = subprocess.run([bash, net.as_posix()], capture_output=True, text=True, timeout=30)
                self.assertEqual(ran.returncode, expected, (line, ran.stderr))
                self.assertEqual(ran.stderr, '', line)

    def test_a_half_written_state_file_is_set_aside_not_fatal(self):
        # Every writer replaces files whole now, so a file that does not parse
        # and is a minute old was cut short by a crash: readers skip it and set
        # it aside instead of failing every pass. A fresh one is only skipped.
        torn = budget.STATE / ('lease-' + 'e' * 32 + '.json')
        torn.write_text('{"pid": 4')
        old = time.time() - budget.TORN_AFTER - 5
        os.utime(torn, (old, old))
        fresh = budget.STATE / 'wait-fictional.json'
        fresh.write_text('')
        self.assertEqual(budget.receipts(), [])
        self.assertEqual(budget.waiting(), [])
        self.assertFalse(torn.exists())
        self.assertTrue(torn.with_name(torn.name + '.unreadable').exists())
        self.assertTrue(fresh.exists())
        self.assertIn('set aside unreadable ' + torn.name, budget.REAPER_LOG.read_text())
        # A row that parses but lacks what its readers need (another build's
        # schema, an operator's edit) is set aside the same way.
        foreign = budget.STATE / ('lease-' + 'f' * 32 + '.json')
        foreign.write_text(json.dumps({'pid': 4711, 'start': 'x'}))
        os.utime(foreign, (old, old))
        self.assertEqual(budget.receipts(), [])
        self.assertTrue(foreign.with_name(foreign.name + '.unreadable').exists())
        # One unreadable owner does not keep an expired one from its cleanup.
        production_scratch = budget.SCRATCH
        self.addCleanup(setattr, budget, 'SCRATCH', production_scratch)
        budget.SCRATCH = Path(self.temporary.name) / 'scratch'
        owners = budget.SCRATCH / 'owners'
        owners.mkdir(parents=True, exist_ok=True)
        (owners / 'fictional-broken.json').write_text('{"id": ')
        (owners / 'fictional-done.json').write_text(json.dumps({'id': 'fictional-done', 'deadline': 0}))
        cleaned = []
        production_run = budget.subprocess.run
        self.addCleanup(setattr, budget.subprocess, 'run', production_run)
        budget.subprocess.run = lambda command, **_: cleaned.append(command[1]) or types.SimpleNamespace(returncode=0)
        budget.expire_scratch(set())
        self.assertEqual(cleaned, ['fictional-done'])
        self.assertFalse((owners / 'fictional-done.json').exists())
        self.assertTrue((owners / 'fictional-broken.json').exists())

    def test_the_reaper_survives_a_failed_pass_and_names_itself(self):
        # Once the sandbox is up, bench-net restarts the reaper only after its
        # pid is gone, so one failed pass must not end it.
        (budget.ROOT / 'control').mkdir()
        passes = []

        class Stop(Exception):
            pass

        def reap_pass():
            passes.append('pass')
            if len(passes) == 1:
                raise ValueError('a ticket read while it is written')

        def sleep(_seconds):
            if len(passes) >= 3:
                raise Stop

        production = (budget.reap_pass, budget.time, budget.fcntl, budget.REAPER_PID, sys.argv)

        def restore():
            budget.reap_pass, budget.time, budget.fcntl, budget.REAPER_PID, sys.argv = production
            vars(budget).pop('open', None)
        self.addCleanup(restore)
        budget.reap_pass = reap_pass
        budget.time = types.SimpleNamespace(time=time.time, monotonic=time.monotonic, sleep=sleep)
        budget.fcntl = types.SimpleNamespace(flock=lambda *_: None, LOCK_EX=2, LOCK_NB=4)
        budget.REAPER_PID = budget.STATE / 'reaper.pid'
        budget.open = lambda *_args, **_options: io.StringIO()
        sys.argv = ['bench-budget', 'reap', '--daemon']
        with self.assertRaises(Stop):
            budget.reap()
        self.assertEqual(len(passes), 3)
        # The pid and its start time: a reused pid does not pass as the reaper.
        self.assertEqual(budget.REAPER_PID.read_text().split()[0], str(budget.os.getpid()))
        self.assertEqual(len(budget.REAPER_PID.read_text().split()), 2)
        self.assertIn('pass failed (1/12): ValueError', budget.REAPER_LOG.read_text())
        self.assertIn('recovered after 1 failed passes', budget.REAPER_LOG.read_text())

    def test_cgroup_settings_are_written_only_when_they_differ(self):
        path = budget.ROOT / 'cpu.max'
        path.write_text('100000 100000\n')
        written = []
        production_write = budget.write
        budget.write = lambda target, value: written.append((target.name, value))
        try:
            budget.ensure(path, '100000 100000')
            self.assertEqual(written, [])
            budget.ensure(path, '150000 100000')
            budget.ensure(budget.ROOT / 'missing.max', 5)
            self.assertEqual(written, [('cpu.max', '150000 100000'), ('missing.max', 5)])
        finally:
            budget.write = production_write

    def test_supervisors_get_the_cpu_admission_leaves_them(self):
        # The aggregate is the jobs' 14 CPUs and the supervisors' one, which
        # the logical line already leaves out.
        self.assertEqual(budget.cpu_max(), '1500000 100000')
        self.assertEqual(budget.SUPERVISOR_CPUS, 1)
        self.assertIsNone(budget.job_pressure())

    def test_timed_jobs_weigh_a_hundred_times_a_session(self):
        self.roomy()
        self.learn(repository=budget.GIB, text=512 * MIB, check=budget.GIB, pair=budget.GIB,
                   browser=512 * MIB, prep=256 * MIB)
        for kind in ('repository', 'text', 'check', 'pair', 'browser', 'prep'):
            self.reserve(kind, f'fictional-{kind}')
        weights = {name: limits[-1] for name, limits in self.groups}
        self.assertEqual(weights, {
            'session-fictional-repository': 100, 'session-fictional-text': 100,
            'check-fictional-check': 10000, 'check-fictional-pair': 10000, 'probe-fictional-pair': 10000,
            'browser-fictional-browser': 10000, 'prep-fictional-prep': 300})

    def test_finished_jobs_record_their_cpu_seconds_and_teach_the_session_burst(self):
        leaf = budget.ROOT / 'session-fictional'
        leaf.mkdir()
        (leaf / 'memory.peak').write_text(str(700 * MIB))
        (leaf / 'cpu.stat').write_text('usage_usec 30000000\nuser_usec 20000000\n')
        budget.record_usage('repository', 'fictional', ['session-fictional'], time.time() - 100)
        entry = json.loads(budget.USAGE.read_text().splitlines()[-1])
        self.assertEqual((entry['kind'], entry['id'], entry['cpuSeconds'], entry['memoryPeak']),
                         ('repository', 'fictional', 30.0, 700 * MIB))
        self.assertAlmostEqual(entry['cores'], 0.3, places=2)
        # Until eight sessions are recorded the allowance is half a core.
        self.assertEqual(budget.session_burst(budget.peaks()), budget.SESSION_BURST)
        for _ in range(budget.PEAK_SAMPLES):
            budget.record_usage('repository', 'fictional', ['session-fictional'], time.time() - 100)
        self.assertAlmostEqual(budget.session_burst(budget.peaks()), 0.3, places=2)
        # Never below a quarter core, never above a session's ceiling.
        for cores, burst in ((0.05, budget.SESSION_BURST_FLOOR), (3.5, 2.0)):
            budget.PEAKS.write_text(json.dumps({'cpu-repository': [cores] * budget.PEAK_SAMPLES}))
            self.assertEqual(budget.session_burst(budget.peaks()), burst)
        # Memory expectations ignore the CPU ring, and the log stays bounded.
        self.assertEqual(budget.expected_memory('repository', budget.peaks()), 3 * budget.GIB)
        budget.USAGE.write_text('{}\n' * (budget.USAGE_LINES + 50))
        budget.record_usage('text', 'fictional', ['session-fictional'], time.time() - 100)
        self.assertEqual(len(budget.USAGE.read_text().splitlines()), budget.USAGE_LINES)

    def test_text_leaves_a_learned_repository_claim_while_repository_runs(self):
        self.roomy()
        self.learn(text=budget.GIB, repository=2 * budget.GIB, check=budget.GIB, prep=256 * MIB)
        repository = self.reserve('repository', 'fictional-repository')

        def fill(prefix):
            count = 0
            while True:
                try:
                    self.reserve('text', f'{prefix}-{count}')
                except BlockingIOError:
                    return count
                count += 1
        # 23 GiB: the repository's 2.5, then per text 1.25 with room for a
        # check, a preparation and one more repository claim.
        self.assertEqual(fill('fictional-text'), 13)
        budget.release(repository)
        held = json.loads((budget.STATE / 'priority.json').read_text())
        held['repository-active'] = time.time() - 1
        (budget.STATE / 'priority.json').write_text(json.dumps(held))
        self.assertEqual(fill('fictional-later'), 4)

    def test_a_check_waiting_for_room_holds_back_the_attempts_that_would_take_it(self):
        self.roomy()
        self.learn(repository=budget.GIB, check=budget.GIB, text=512 * MIB, pair=budget.GIB)
        self.measure(1.0)
        for n in range(8):
            self.reserve('repository', f'fictional-{n}')
            self.settle()
        for n in range(5):
            self.reserve('check', f'fictional-check-{n}')
            self.settle()
        # The next check waits for CPUs: repository attempts wait behind it,
        # text attempts (no CPU ceiling counted) do not.
        with self.assertRaisesRegex(BlockingIOError, 'CPU cores'):
            self.reserve('check', 'fictional-check-5')
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
        # Before any peak is learned a text attempt needs 5 GiB of room and a
        # repository attempt 6: text sessions refilling every few minutes
        # would otherwise keep the repository attempt out for good.
        self.roomy()
        texts = [self.reserve('text', f'fictional-text-{n}') for n in range(9)]
        with self.assertRaisesRegex(BlockingIOError, 'memory the running jobs claim'):
            self.reserve('repository', 'fictional-repository')
        self.assertEqual(budget.priority_waiting('text'),
                         'a repository attempt waits for the memory text sessions claim')
        self.assertIsNone(budget.priority_waiting('repository'))
        # A text attempt that would take the repository attempt's room waits.
        budget.release(texts[0])
        with self.assertRaisesRegex(BlockingIOError, 'repository attempt waits for the memory'):
            self.reserve('text', 'fictional-text-refill')
        # One that fits beside it starts.
        for token in texts[1:3]:
            budget.release(token)
        self.reserve('text', 'fictional-text-beside')
        # Checks and preparations are not held by it.
        self.reserve('prep', 'fictional-prep')
        budget.release(next(path.name[6:-5] for path in budget.STATE.glob('lease-*.json')
                            if json.loads(path.read_text())['id'] == 'fictional-prep'))
        self.reserve('repository', 'fictional-repository')
        # Once it is in, the hold is gone.
        self.assertIsNone(budget.priority_waiting('text'))

    def test_asking_before_preparing_reserves_nothing_and_keeps_the_hold(self):
        # A repository attempt asks before its workspace is verified and
        # copied. The answer makes no group or lease; a refusal holds text
        # attempts back as a refused reservation does, and an admission keeps
        # that hold until the reservation itself.
        self.roomy()
        texts = [self.reserve('text', f'fictional-text-{n}') for n in range(9)]
        deadline = int(time.time() * 1000) + 60000

        def ask():
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                budget.reserve('repository', 'fictional-repository', deadline, self.gate(), 0, False, True)
            return json.loads(output.getvalue())
        with self.assertRaisesRegex(BlockingIOError, 'memory the running jobs claim'):
            ask()
        held = 'a repository attempt waits for the memory text sessions claim'
        self.assertEqual(budget.priority_waiting('text'), held)
        for token in texts[:3]:
            budget.release(token)
        leases = sorted(path.name for path in budget.STATE.glob('lease-*.json'))
        self.assertEqual(ask(), {'id': 'fictional-repository', 'class': 'repository',
                                 'deadlineMs': deadline, 'admits': True})
        self.assertEqual(sorted(path.name for path in budget.STATE.glob('lease-*.json')), leases)
        self.assertFalse((budget.ROOT / 'session-fictional-repository').exists())
        self.assertEqual(budget.priority_waiting('text'), held)
        self.reserve('repository', 'fictional-repository')
        self.assertIsNone(budget.priority_waiting('text'))

    def test_a_repository_attempt_text_cannot_make_room_for_holds_nothing(self):
        self.roomy()
        self.learn(repository=9 * budget.GIB // 2)
        for name in ('fictional-a', 'fictional-b', 'fictional-c'):
            self.reserve('repository', name)
        with self.assertRaisesRegex(BlockingIOError, 'memory the running jobs claim'):
            self.reserve('repository', 'fictional-d')
        self.assertIsNone(budget.priority_waiting('text'))
        # A text attempt is refused by memory alone (it would leave no room
        # for another learned repository claim), not by a hold.
        with self.assertRaisesRegex(BlockingIOError, 'memory the running jobs claim'):
            self.reserve('text', 'fictional-text')

    def test_a_queued_sign_in_keeps_only_the_room_it_was_refused(self):
        # A sign-in or probe without a reservation waits in the ticket queue.
        # 19:30 PDT 10-17: any queued job refused every new attempt, so a
        # preparation waiting on the light-job line stopped all repository
        # starts. Now attempts wait only for the room it was refused.
        self.roomy()
        ticket = budget.STATE / ('wait-' + 'a' * 32 + '.json')
        ticket.write_text(json.dumps({'pid': budget.os.getpid(), 'start': budget.proc_identity(budget.os.getpid()),
                                      'deadline': time.time() + 60, 'created': time.time_ns()}))
        for kind in ('text', 'repository', 'check', 'browser', 'prep'):
            self.reserve(kind, f'fictional-{kind}')
        budget.hold('memory', time.time() + 10, budget.ADMISSION_MEMORY)
        with self.assertRaisesRegex(BlockingIOError, 'waits for room first'):
            self.reserve('text', 'fictional-text-behind')
        ticket.unlink()

    def test_the_owners_desktop_load_leaves_four_sessions_and_their_checks(self):
        # The owner keeps Unity and VS Code open (~3 cores) beside Distill and
        # its WebView (~2.3): 5.3 cores outside the VM. The guest's own work
        # (2.0 here, the jobs' 1.5 among it) is inside and not counted twice.
        self.roomy()
        self.learn(**{'repository': budget.GIB, 'check': budget.GIB, 'cpu-repository': 0.41})
        self.measure(1.5)
        budget.guest_cores = lambda: 4.0
        self.busy = 581  # 9.3 of 16 logical CPUs busy on the host
        self.assertAlmostEqual(budget.outside_cores(7.3, 1.5, 2.0), 5.3)
        self.assertAlmostEqual(budget.outside_cores(7.3, 1.5), 5.8)
        for n in range(4):
            self.reserve('repository', f'fictional-{n}')
            self.settle()
        self.reserve('check', 'fictional-check-running')
        # The running check uses its two CPUs: the jobs measure 1.5 + 2, and
        # its ceiling already counts them, so they are not counted twice.
        (budget.ROOT / 'check-fictional-check-running' / 'cpu.stat').write_text('usage_usec 2000000\n')
        self.measure(3.5)
        # 1.5 used + 0.41 x 5 bursts + the running check's 2 + one check's
        # reserve of 2 = 7.55 of the 16 - 6 - 1 = 9 the host leaves.
        record = self.admit('repository', 'fictional-fifth')['admission']
        self.assertEqual((record['cpuCapacity'], record['admittedBy']), (9, 'measured'))
        self.assertEqual(record['outsideCpu'], 5.296)
        self.settle(('repository',))
        # A check that waits for CPUs keeps them: a sixth session would take
        # them and waits; the check starts beside the five.
        budget.hold('cpu', time.time() + budget.PRIORITY_HOLD, budget.CHECK_CPUS)
        with self.assertRaisesRegex(BlockingIOError, 'a check waits for CPUs first'):
            self.reserve('repository', 'fictional-sixth')
        self.reserve('check', 'fictional-check-waiting')
        budget.hold('cpu')
        # Two checks running leave no room for a sixth session's burst and
        # one more check: the checks keep their CPUs.
        with self.assertRaisesRegex(BlockingIOError, 'CPU cores the host leaves free'):
            self.reserve('repository', 'fictional-sixth')

    def test_a_timing_sensitive_check_runs_with_no_new_cpu_heavy_job_beside_it(self):
        # A planning lab times its planner on budgets of seconds: while its
        # check runs, no new CPU-heavy job starts, the running ones go on,
        # and the hold ends with the check's lease. Light jobs still start.
        self.roomy()
        self.learn(repository=budget.GIB, check=budget.GIB)
        self.measure(1.0)
        self.reserve('repository', 'fictional-running')
        self.settle()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            budget.reserve('check', 'fictional-planning', int(time.time() * 1000) + 60000, self.gate(), 0,
                           False, False, True)
        answer = json.loads(output.getvalue())
        # Its admission records the load it started under, for a later audit.
        self.assertTrue(answer['admission']['timing'])
        self.assertEqual(answer['admission']['sandboxCpu'], 1.0)
        self.assertIn('cpuCapacity', answer['admission'])
        for kind in ('repository', 'check', 'browser', 'pair'):
            with self.assertRaisesRegex(BlockingIOError, 'timing-sensitive check runs'):
                self.reserve(kind, f'fictional-new-{kind}')
        with self.assertRaisesRegex(BlockingIOError, 'timing-sensitive check runs'):
            self.reserve('repository', 'fictional-step', continuing=True)
        self.reserve('text', 'fictional-text')
        self.reserve('prep', 'fictional-prep')
        budget.release(answer['token'])
        self.reserve('repository', 'fictional-after')
        # Only a check can be one.
        with self.assertRaisesRegex(RuntimeError, 'only a check'):
            budget.reserve('repository', 'fictional-timed', int(time.time() * 1000) + 60000, self.gate(), 0,
                           False, False, True)

    def test_a_timing_sensitive_check_starts_only_with_its_whole_ceiling_free(self):
        # The measured use must leave its two CPUs free beside the running
        # jobs; an ordinary check starts by its own line meanwhile.
        self.roomy()
        self.learn(check=budget.GIB)
        self.measure(14.0)  # of the 15 the host leaves
        deadline = int(time.time() * 1000) + 60000
        with self.assertRaisesRegex(BlockingIOError, 'whole ceiling'):
            budget.reserve('check', 'fictional-timed', deadline, self.gate(), 0, False, False, True)
        # Its refusal keeps its CPUs from new attempts, as a waiting check's.
        self.assertEqual(budget.kept_room('repository', budget.peaks())[1], budget.CHECK_CPUS)
        self.reserve('check', 'fictional-ordinary')
        # The ordinary check counts at its ceiling beside the measured use:
        # 11 + 2 + 2 fits the 15.
        self.measure(11.0)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            budget.reserve('check', 'fictional-timed-later', deadline, self.gate(), 0, False, False, True)
        self.assertTrue(json.loads(output.getvalue())['admission']['timing'])

    def test_the_timing_ceiling_rule_counts_what_the_samples_do_not_show_yet(self):
        # The samples lag behind jobs admitted moments ago: sessions too new
        # to be measured count at their ceilings, as the running timed jobs
        # do, so a timing check never starts beside work about to take its
        # CPUs. A second timing check waits for the first and keeps its CPUs
        # from new attempts meanwhile.
        self.roomy()
        self.learn(repository=budget.GIB, check=budget.GIB)
        self.measure(1.0)
        for n in range(4):
            self.reserve('repository', f'fictional-new-{n}')
        self.busy = 500  # now 8 of 16 busy, 7 outside the VM: 16 - 7 - 1 = 8
        deadline = int(time.time() * 1000) + 60000
        # 1 measured, plus four unsettled sessions at 2 CPUs: 1 + 8 + 2 > 8.
        with self.assertRaisesRegex(BlockingIOError, 'whole ceiling'):
            budget.reserve('check', 'fictional-timed', deadline, self.gate(), 0, False, False, True)
        self.settle(('repository',))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            budget.reserve('check', 'fictional-timed', deadline, self.gate(), 0, False, False, True)
        (budget.STATE / 'priority.json').unlink(missing_ok=True)
        with self.assertRaisesRegex(BlockingIOError, 'timing-sensitive check runs'):
            budget.reserve('check', 'fictional-timed-second', deadline, self.gate(), 0, False, False, True)
        self.assertEqual(budget.kept_room('repository', budget.peaks())[1], budget.CHECK_CPUS)

    def test_a_timing_check_counts_a_fresh_check_on_top_of_the_measured_sessions(self):
        # Settled sessions show in the samples; a check admitted moments ago
        # does not yet. Its ceiling adds to their measured use, so a timing
        # check never starts where the two would leave it less than its own.
        self.roomy()
        self.learn(repository=budget.GIB, check=budget.GIB)
        self.measure(1.0)
        for n in range(3):
            self.reserve('repository', f'fictional-settled-{n}')
        self.settle(('repository',))
        fresh = self.reserve('check', 'fictional-fresh')
        self.measure(5.0)
        self.busy = 750  # now 12 of 16 busy, 7 outside the VM: 16 - 7 - 1 = 8
        deadline = int(time.time() * 1000) + 60000
        # 5 measured + 2 for the fresh check + 2 > 8; the ordinary line would
        # admit it (2 + 2 + 3 bursts of 0.5 <= 8).
        with self.assertRaisesRegex(BlockingIOError, 'whole ceiling'):
            budget.reserve('check', 'fictional-timed', deadline, self.gate(), 0, False, False, True)
        budget.release(self.reserve('check', 'fictional-ordinary'))
        budget.release(fresh)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            budget.reserve('check', 'fictional-timed', deadline, self.gate(), 0, False, False, True)
        self.assertTrue(json.loads(output.getvalue())['admission']['timing'])

    def test_reservation_flags_are_named_once_each(self):
        calls = []
        production = budget.reserve
        budget.reserve = lambda *args: calls.append(args)
        self.addCleanup(setattr, budget, 'reserve', production)
        argv = sys.argv
        self.addCleanup(setattr, sys, 'argv', argv)
        budget.os.geteuid = lambda: 0
        for flags, expected in (([], (False, False)), (['timing'], (False, True)),
                                (['continuing', 'timing'], (True, True))):
            sys.argv = ['bench-budget', 'reserve', 'check', 'fictional', '1', 'gate', '0', *flags]
            budget.main()
            self.assertEqual((calls[-1][5], calls[-1][7]), expected)
        for flags in (['timing', 'timing'], ['fast']):
            sys.argv = ['bench-budget', 'reserve', 'check', 'fictional', '1', 'gate', '0', *flags]
            with self.assertRaisesRegex(RuntimeError, 'unsupported benchmark reservation flag'):
                budget.main()

    def test_a_preparation_refused_by_the_light_line_holds_nobody(self):
        # 19:30 PDT 10-17: preparations refused on the light-job line kept
        # the 'cpu' hold armed, so no repository session started for minutes.
        self.roomy()
        self.measure(1.0)
        budget.guest_cores = lambda: 1.0
        self.busy = 750  # 12 of 16 logical CPUs busy: 11 outside the VM
        with self.assertRaisesRegex(BlockingIOError, 'light-job admission line'):
            self.reserve('prep', 'fictional-prep')
        self.assertNotIn('cpu', budget.priority_state())
        self.assertNotIn('memory', budget.priority_state())
        self.assertIsNone(budget.priority_waiting('repository'))
        # The repository line is the measured one: 1 used + one burst + one
        # check's reserve fits the 16 - 11 - 1 = 4 the host leaves.
        record = self.admit('repository', 'fictional-repository')['admission']
        self.assertEqual(record['admittedBy'], 'measured')

    def test_a_cancellation_is_never_read_as_a_missing_file(self):
        # SIGHUP's exception used to be a TimeoutError, an OSError: inside a
        # read it passed for a missing file, a dead owner or an empty ring.
        self.assertFalse(issubclass(budget.Cancelled, OSError))

        class Interrupted(type(Path())):
            def read_text(self, *args, **kwargs):
                raise budget.Cancelled('benchmark resource owner cancelled')
        with self.assertRaises(budget.Cancelled):
            budget.readable(Interrupted(budget.STATE / 'lease-fictional.json'))
        budget.PEAKS = Interrupted(budget.PEAKS)
        with self.assertRaises(budget.Cancelled):
            budget.peaks()

    def test_the_guest_cpu_sample_reads_the_vms_work(self):
        stat_file = budget.PROC_STAT
        stat_file.write_text('cpu  1000 0 500 9000 100 50 50 200 0 0\ncpu0 1 2 3 4 5 6 7 8 0 0\n', newline='\n')
        # user + nice + system + irq + softirq, at 100 ticks a second.
        self.assertEqual(budget.guest_work(), (1000 + 0 + 500 + 50 + 50) * 1_000_000 // budget.CLOCK_TICKS)
        stat_file.write_text('intr 1 2 3\n', newline='\n')
        self.assertIsNone(budget.guest_work())
        now = time.time()
        (budget.STATE / 'cpu.json').write_text(json.dumps([[now - 4, 0, 0], [now, 4_000_000, 12_000_000]]))
        self.assertAlmostEqual(budget.sandbox_cores(), 1.0)
        self.assertAlmostEqual(budget.guest_cores(), 3.0)
        # Samples from before the guest was sampled still give the jobs' use.
        (budget.STATE / 'cpu.json').write_text(json.dumps([[now - 4, 0], [now, 4_000_000, None]]))
        self.assertAlmostEqual(budget.sandbox_cores(), 1.0)
        self.assertIsNone(budget.guest_cores())

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

    def test_the_operator_cap_bounds_cpu_heavy_jobs_and_a_capped_check_goes_next(self):
        self.roomy()
        self.learn(repository=budget.GIB, check=budget.GIB)
        quiet = io.StringIO()
        with contextlib.redirect_stdout(quiet):
            budget.set_heavy_cap('1')
        self.assertEqual(budget.HEAVY_CAP.read_text(), '1\n')
        session = self.reserve('repository', 'fictional-a')
        with self.assertRaisesRegex(BlockingIOError, 'operator caps CPU-heavy benchmark jobs at 1'):
            self.reserve('check', 'fictional-check')
        # The capped check holds new repository sessions, not text ones, so
        # it takes the place the running session frees.
        self.assertTrue(budget.priority_waiting('repository'))
        self.reserve('text', 'fictional-text')
        budget.release(session)
        self.reserve('check', 'fictional-check-next')
        (budget.STATE / 'priority.json').unlink()
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
        self.assertLess(abs(record.pop('hostGateAgeMs')), 2000)
        # No memory.stat in the fixture: the guard read memory.current.
        self.assertEqual((record.pop('memoryInUse'), record.pop('memoryFile')), (3 * budget.GIB, None))
        self.assertEqual(record, {
            'policy': 'dynamic-v2', 'heavyCap': None, 'lane': 'heavy',
            'competing': {'text': 1, 'repository': 1}, 'competingHeavy': 1,
            'reservedMemory': 5 * budget.GIB, 'reservedCpu': 2,
            'memoryCurrent': 3 * budget.GIB, 'guestLoad': [1.5, 0.75, 0.25], 'guestCpus': 16,
            'hostAvailableRam': 60 * budget.GIB, 'hostAvailableCommit': 60 * budget.GIB,
            'guestMemAvailable': 32 * budget.GIB, 'hostCpuBusy': 0.125,
            'expectedMemory': 3 * budget.GIB, 'cpuLine': 6, 'sandboxCpu': None,
            'guestCpu': None, 'outsideCpu': 2.0, 'keptMemory': 0, 'keptCpus': 0,
            'cpuPressure': None, 'checkStall': None, 'cpuCapacity': 13, 'sessionBurst': 0.5,
            'repositorySessions': 1, 'admittedBy': 'ceilings'})

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
        budget.PEAKS.write_text(json.dumps({'pair': [MIB] * (budget.PEAK_SAMPLES - 1)}))
        self.assertEqual(budget.expected_memory('pair', budget.peaks()), 8 * budget.GIB)
        budget.PEAKS.write_text('not json')
        self.assertEqual(budget.expected_memory('pair', budget.peaks()), 8 * budget.GIB)
        # An unlearned check claims its initial quarter, not its ceiling.
        self.assertEqual(budget.expected_memory('check', budget.peaks()), budget.GIB)

    def test_a_failed_read_never_resets_what_admission_learned(self):
        # 10-17 19:05:56: a supervisor that could not read the learned state
        # wrote a fresh one, and every class went back to its initial claim.
        # Now an update keeps the version it replaces, a backup answers when
        # the current file cannot be read, and nothing is written over state
        # that cannot be read at all.
        self.learn(repository=budget.GIB)
        before = budget.PEAKS.read_text()
        leaf = budget.ROOT / 'session-fictional-done'
        leaf.mkdir()
        (leaf / 'memory.peak').write_text(str(2 * budget.GIB))
        (leaf / 'cpu.stat').write_text('usage_usec 1000000\n')
        budget.record_peak('repository', ['session-fictional-done'])
        self.assertEqual(budget.PEAKS_BACKUP.read_text(), before)
        self.assertEqual(json.loads(budget.PEAKS.read_text())['repository'][-1], 2 * budget.GIB)
        # A torn current file: decisions and the next update use the backup.
        budget.PEAKS.write_bytes(b'\xff\xfe{"torn')
        self.assertEqual(budget.peaks(), json.loads(before))
        budget.record_peak('repository', ['session-fictional-done'])
        recovered = json.loads(budget.PEAKS.read_text())
        self.assertEqual(recovered['repository'], [budget.GIB] * budget.PEAK_SAMPLES + [2 * budget.GIB])
        self.assertEqual(budget.PEAKS_BACKUP.read_text(), before)
        self.assertIn('recovered it from', budget.REAPER_LOG.read_text())
        # Neither readable: both stay as they are, and the log says why.
        budget.PEAKS.write_bytes(b'\xff')
        budget.PEAKS_BACKUP.write_bytes(b'\xff')
        budget.record_peak('repository', ['session-fictional-done'])
        self.assertEqual((budget.PEAKS.read_bytes(), budget.PEAKS_BACKUP.read_bytes()), (b'\xff', b'\xff'))
        self.assertIn('kept the learned admission state', budget.REAPER_LOG.read_text())
        self.assertEqual(budget.peaks(), {})
        # The usage log is kept, not started over, when it cannot be read.
        budget.USAGE.mkdir()
        budget.record_usage('repository', 'fictional-done', ['session-fictional-done'], time.time() - 10)
        self.assertTrue(budget.USAGE.is_dir())
        self.assertIn('kept ' + budget.USAGE.name, budget.REAPER_LOG.read_text())
        # 19:39:59.9: the host's SIGHUP, as the supervisor's TimeoutError (an
        # OSError), interrupted the usage read; the log is kept then too.
        class Interrupted(type(Path())):
            def read_text(self, *args, **kwargs):
                raise TimeoutError('benchmark resource owner cancelled')
        budget.USAGE = Interrupted(budget.USAGE.parent / 'interrupted-usage.jsonl')
        budget.USAGE.write_bytes(b'{"kept": true}\n')
        budget.record_usage('repository', 'fictional-done', ['session-fictional-done'], time.time() - 10)
        self.assertEqual(budget.USAGE.read_bytes(), b'{"kept": true}\n')
        self.assertIn('kept interrupted-usage.jsonl, it could not be read: TimeoutError', budget.REAPER_LOG.read_text())

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
            ('session-fictional-repository', (6 * budget.GIB, 2, 768, 128 * MIB, 32 * MIB, 100)),
            ('session-fictional-text', (2 * budget.GIB, 1, 256, 32 * MIB, 8 * MIB, 100)),
            ('check-fictional-pair', (4 * budget.GIB, 1, 384, 64 * MIB, 16 * MIB, 10000)),
            ('probe-fictional-pair', (4 * budget.GIB, 1, 384, 64 * MIB, 16 * MIB, 10000))])

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
        for gate in (self.gate(age=61000), self.gate(age=-61000), self.gate(commit=9), self.gate(disk=29)):
            with self.assertRaises(BlockingIOError):
                self.reserve('text', 'fictional-rejected', gate)
            self.assertEqual(budget.receipts(), [])
        # Evidence without the host's CPU share is no evidence.
        legacy = ','.join(self.gate().split(',')[:4])
        with self.assertRaisesRegex(RuntimeError, 'capability_missing:'):
            self.reserve('text', 'fictional-legacy', legacy)

    def test_a_leased_run_prints_its_outcome_last_framed_by_the_host_nonce(self):
        # The host passes a nonce with a leased call; the run's supervisor
        # prints its receipt as the last stderr line, so the host needs no
        # second wsl.exe start for it. Without a nonce nothing is printed.
        production = (budget.OUTCOME_TOKEN, budget.OUTCOME_NONCE)
        self.addCleanup(lambda: setattr(budget, 'OUTCOME_TOKEN', production[0])
                        or setattr(budget, 'OUTCOME_NONCE', production[1]))
        token, nonce = 'a' * 32, 'b' * 32
        (budget.STATE / 'outcomes').mkdir(parents=True, exist_ok=True)
        budget.OUTCOME_TOKEN, budget.OUTCOME_NONCE = token, None
        quiet = io.StringIO()
        with contextlib.redirect_stderr(quiet):
            budget.print_outcome()
        self.assertEqual(quiet.getvalue(), '')
        budget.OUTCOME_NONCE = nonce
        for written, expected in ((None, None), ('infrastructure_error: invented', 'infrastructure_error: invented')):
            if written:
                (budget.STATE / 'outcomes' / (token + '.json')).write_text(
                    json.dumps({'token': token, 'infrastructureError': written}))
            printed = io.StringIO()
            with contextlib.redirect_stderr(printed):
                budget.print_outcome()
            line = printed.getvalue().splitlines()[-1]
            self.assertTrue(line.startswith(nonce + ' outcome '))
            self.assertEqual(json.loads(line[len(nonce) + 9:]), {'token': token, 'infrastructureError': expected})

    def test_a_drifted_wsl_clock_admits_within_a_minute_and_names_the_clock(self):
        # WSL2's clock can fall behind Windows after sleep until it is
        # resynchronised: evidence up to a minute off still admits, with its
        # age recorded; beyond that the refusal says it is the clock.
        self.roomy()
        record = self.admit('text', 'fictional-behind', gate=self.gate(age=30000))['admission']
        self.assertAlmostEqual(record['hostGateAgeMs'], 30000, delta=2000)
        self.admit('text', 'fictional-ahead', gate=self.gate(age=-30000))
        with self.assertRaisesRegex(BlockingIOError, r'Windows headroom evidence expired .* \+61\.\d s from the sandbox clock'):
            self.reserve('text', 'fictional-drifted', self.gate(age=61000))
        self.assertAlmostEqual(budget.gate_age(self.gate(age=4000)), 4000, delta=2000)
        self.assertIsNone(budget.gate_age(None))

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
        self.pool.f_bavail = int(2.2 * budget.GIB) // 4096
        # Just admitted, its 1 GiB reservation still counts: a check waits.
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
