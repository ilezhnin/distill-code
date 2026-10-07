#!/usr/bin/python3
"""Offline integration checks for verdict/process separation, run as WSL root."""
import io
import json
from pathlib import Path
import subprocess
import tarfile
import uuid

CHECK = '''import json, os, pwd, secrets, socket
from pathlib import Path
assert pwd.getpwuid(os.getuid()).pw_name == 'checker'
assert Path('hidden/secret').read_text() == 'private-expected-state'
assert not Path('answer.txt').exists()
assert Path('/submission/answer.txt').read_text() == 'public'
try:
    Path('/submission/answer.txt').write_text('changed')
    raise AssertionError('Submitted evidence is writable')
except OSError:
    pass
sock = socket.socket(fileno=int(os.environ['DISTILL_BENCH_RPC_FD']))
sock.settimeout(3)
channel = sock.makefile('rwb')
for _ in range(3):
    number = secrets.randbelow(1000000)
    channel.write((json.dumps({'number':number})+'\\n').encode()); channel.flush()
    line = channel.readline(2048)
    assert line.endswith(b'\\n') and len(line) < 2048
    response = json.loads(line)
    assert response == {'value':number+1,'hidden':False,'uid':pwd.getpwnam('candidate').pw_uid,'pid':1}
print('trusted check passed')
'''
WORKER = '''import net from 'node:net';
import readline from 'node:readline';
import fs from 'node:fs';
const channel = new net.Socket({fd:Number(process.env.DISTILL_BENCH_RPC_FD),readable:true,writable:true});
readline.createInterface({input:channel}).on('line', text=>{
  const input=JSON.parse(text);
  channel.write(JSON.stringify({value:input.number+1,hidden:fs.existsSync('hidden/secret') || fs.existsSync('/submission/answer.txt'),uid:process.getuid(),pid:process.pid})+'\\n');
});
'''

def archive(worker, patch='', check=CHECK):
    files = {
        'snapshot/answer.txt': 'public', 'answer.patch': patch,
        'snapshot/socket.py': "raise RuntimeError('Candidate poisoned the import path')",
        'hidden/hidden/check.py': check, 'hidden/hidden/secret': 'private-expected-state',
        'probe/__probe__/worker.mjs': worker,
        'probe.json': json.dumps({'command': ['node', '__probe__/worker.mjs']}),
    }
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as tar:
        for name, value in files.items():
            value = value.encode()
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode = len(value), 0o644
            tar.addfile(entry, io.BytesIO(value))
    return stream.getvalue()

def run(name, worker, expected, patch='', prep_failure=False, cancel=False):
    identifier = 'paired-test-' + str(uuid.uuid4())
    process = None
    try:
        prepared = subprocess.run(['/usr/local/sbin/bench-check-prep', identifier], input=archive(worker, patch), capture_output=True, timeout=30)
        if prep_failure:
            assert prepared.returncode == 2, prepared.stderr.decode()
        else:
            assert prepared.returncode == 0, prepared.stderr.decode()
            process = subprocess.Popen(['/usr/local/sbin/bench-judge', identifier, '5', '--', 'python3', 'hidden/check.py'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if cancel:
                # A live supervisor plus both namespaces must exist before
                # cancellation, not just a timer or a stale directory.
                import time
                deadline = time.monotonic() + 5
                group = Path('/sys/fs/cgroup/distill-bench') / ('probe-' + identifier)
                while time.monotonic() < deadline:
                    if (group / 'cgroup.procs').exists() and (group / 'cgroup.procs').read_text().strip():
                        break
                    assert process.poll() is None
                    time.sleep(0.02)
                else:
                    raise AssertionError('No live probe to cancel')
                subprocess.run(['/usr/local/sbin/bench-kill', 'check', identifier], check=True)
            output, error = process.communicate(timeout=12)
            assert (process.returncode == 0) == expected, (name, process.returncode, output, error)
        print('PASS ' + name, flush=True)
    finally:
        subprocess.run(['/usr/local/sbin/bench-clean', identifier], check=True)
        if process is not None and process.poll() is None:
            process.wait(timeout=10)
        for directory in ['checks', 'probes', 'staging', 'submissions']:
            assert not (Path('/srv/bench') / directory / identifier).exists()
        assert not (Path('/srv/bench/pairs') / (identifier + '.json')).exists()
        for mode in ['check', 'probe']:
            group = Path('/sys/fs/cgroup/distill-bench') / (mode + '-' + identifier)
            assert not group.exists() or not (group / 'cgroup.procs').read_text().strip()

run('correct behavior, private expectations, separate UID and PID namespace', WORKER, True)
wrong = WORKER.replace('input.number+1', 'input.number')
run('incorrect response fails', wrong, False)
run('assert mutation cannot alter the verdict', "import assert from 'node:assert/strict'; assert.equal=()=>{}; assert.deepEqual=()=>{};\n" + wrong, False)
run('early successful exit cannot pass', 'process.exit(0);', False)
run('stdout cannot forge a verdict', "console.log('trusted check passed'); process.exit(0);", False)
run('a probe cannot overwrite the hidden checker', "import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('hidden',{recursive:true}); writeFileSync('hidden/check.py','exit(0)');\n" + wrong, False)
run('malformed responses fail', WORKER.replace('JSON.stringify({value:input.number+1,hidden:fs.existsSync(\'hidden/secret\') || fs.existsSync(\'/submission/answer.txt\'),uid:process.getuid(),pid:process.pid})', "'not json'"), False)
run('cancel ends supervisor, checker and detached probe children', "import {spawn} from 'node:child_process'; spawn('sleep',['600'],{detached:true,stdio:'ignore'}).unref(); setInterval(()=>{},1000);", False, cancel=True)
run('nonresponding probe is bounded and cleaned', 'setInterval(()=>{},1000);', False)
link = 'diff --git a/__probe__ b/__probe__\nnew file mode 120000\nindex 0000000..0000000\n--- /dev/null\n+++ b/__probe__\n@@ -0,0 +1 @@\n+/tmp\n\\ No newline at end of file\n'
run('linked probe driver parent is refused before root copy', WORKER, False, patch=link, prep_failure=True)
