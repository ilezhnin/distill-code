"""Prepare only the fresh, app-owned offline policy probe workspace."""
import os, pathlib, pwd, re, stat, subprocess, sys

ident = sys.argv[1]
if not re.fullmatch('[A-Za-z0-9_-]{1,80}', ident):
    raise ValueError('invalid probe owner')
parent = pathlib.Path('/srv/bench/probes')
for path in (pathlib.Path('/srv'), pathlib.Path('/srv/bench'), parent):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('unprotected probe parent')
target = parent / ident
target.mkdir(mode=0o700)
subprocess.run(['/usr/local/sbin/bench-budget', 'own', ident], check=True)
subprocess.run(['/usr/local/sbin/bench-unpack', str(target)], check=True)
owner = pwd.getpwnam('candidate')
for path in [target, *target.rglob('*')]:
    os.chown(path, owner.pw_uid, owner.pw_gid, follow_symlinks=False)
