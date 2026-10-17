#!/usr/bin/python3
"""Root-owned, local-only receipts for synthetic Linux text policy probes.

No credentials are read. Runtime pins cover the installed launchers and ACP
entrypoints; this receipt additionally binds native executables and policy
source. Only the administrator's offline qualification driver writes receipts.
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import stat
import sys
import tempfile

ROOT = Path('/opt/distill-tools')
RECEIPTS = ROOT / 'text-policy-proofs'
CACHE = Path('/run/distill-text-proof-cache')
PROVIDERS = ('claude', 'codex', 'grok', 'kimi', 'zai')


def protected_info(info, directory=False):
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('unprotected runtime path')


def protected(path, directory=False):
    path = Path(path)
    protected_info(path.lstat(), directory)
    return path


def identity(path, info):
    return [str(path), info.st_dev, info.st_ino, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, info.st_uid, info.st_gid,
            info.st_mode, info.st_nlink]


def cached_digest(entries, path, observed):
    entry = entries.get(str(path), {})
    digest = entry.get('sha256', '')
    if (entry.get('identity') == observed and isinstance(digest, str) and
            len(digest) == 64 and all(char in '0123456789abcdef' for char in digest)):
        return digest
    return None


class HashCache:
    """Small protected cache; invalid cache contents never qualify a policy."""
    def __init__(self, provider, context):
        if os.geteuid() != 0:
            raise ValueError('text proof cache requires root')
        protected('/run', True)
        CACHE.mkdir(mode=0o700, exist_ok=True)
        protected(CACHE, True)
        self.path = CACHE / (provider + '.json')
        self.context = context
        self.entries = {}
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return
        with os.fdopen(fd) as file:
            info = os.fstat(file.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                    info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > 32768):
                raise ValueError('unprotected text proof cache')
            try:
                saved = json.load(file)
            except (ValueError, UnicodeError):
                return  # A damaged cache is a cold verification, never a pass.
        if (isinstance(saved, dict) and saved.get('context') == context and
                isinstance(saved.get('entries'), dict) and len(saved['entries']) <= 8):
            self.entries = saved['entries']

    def save(self):
        # Only called after the observed hashes match the protected proof.
        payload = json.dumps({'context': self.context, 'entries': self.entries}, sort_keys=True)
        if len(payload.encode()) > 32768:
            raise ValueError('text proof cache exceeds its bound')
        fd, temporary = tempfile.mkstemp(prefix='.hash-', dir=CACHE)
        try:
            with os.fdopen(fd, 'w') as file:
                file.write(payload)
                file.flush()
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


def artifact(path, cache=None):
    # Resolve package-manager symlinks, then validate every actual ancestor.
    path = Path(path).resolve(strict=True)
    if not path.is_relative_to(ROOT):
        raise ValueError('runtime outside protected tool installation')
    for parent in path.parents:
        protected(parent, True)
    protected(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        opened = os.fstat(file.fileno())
        protected_info(opened)
        before = identity(path, opened)
        if before != identity(path, path.lstat()):
            raise ValueError('runtime replaced while opening')
        digest = cached_digest(cache.entries, path, before) if cache else None
        if digest is None:
            hashed = hashlib.sha256()
            while chunk := file.read(1024 * 1024):
                hashed.update(chunk)
            digest = hashed.hexdigest()
        if (identity(path, os.fstat(file.fileno())) != before or
                identity(path, path.lstat()) != before):
            raise ValueError('runtime changed while verifying')
    if cache:
        cache.entries[str(path)] = {'identity': before, 'sha256': digest}
    return {'path': str(path), 'sha256': digest}


def launcher_target(name):
    launcher = protected(ROOT / 'bin' / name)
    for line in launcher.read_text().splitlines():
        words = shlex.split(line)
        if words and words[0] == 'exec':
            targets = [word for word in words[1:] if word.startswith(str(ROOT) + '/')]
            if targets:
                return targets[-1]
    raise ValueError('unrecognized pinned launcher')


def collect(provider, cache=None):
    if provider not in PROVIDERS:
        raise ValueError('unknown provider')
    entry = {'claude': 'claude-agent-acp', 'codex': 'codex-acp',
             'grok': 'grok', 'kimi': 'kimi', 'zai': 'opencode'}[provider]
    result = {'entrypoint': artifact(launcher_target(entry), cache)}
    if provider == 'claude':
        result['claudeCli'] = artifact(launcher_target('claude'), cache)
    elif provider == 'codex':
        result['codexLauncher'] = artifact(launcher_target('codex'), cache)
        # npm's Linux package layout can differ from the Windows one. Require
        # exactly one ELF codex executable, and attest the bytes actually used.
        natives = []
        for candidate in (ROOT / 'codex-acp' / 'node_modules' / '@openai').glob('codex*/vendor/**/codex'):
            if candidate.is_file():
                with candidate.open('rb') as file:
                    if file.read(4) == b'\x7fELF':
                        natives.append(candidate)
        if len(natives) != 1:
            raise ValueError('ambiguous or absent Linux Codex native executable')
        result['codexNative'] = artifact(natives[0], cache)
    elif provider == 'grok':
        result['grokNative'] = result['entrypoint']
    elif provider == 'zai':
        # OpenCode is its own ELF executable; its grep and glob tools run the
        # ripgrep only Z.ai sessions have on their PATH.
        result['ripgrep'] = artifact(ROOT / 'zai' / 'bin' / 'rg', cache)
    return result


def validate_receipt(proof, provider, revision, policy, cache=None):
    expected = {'schemaVersion': 1, 'recipe': 'linux-native-text-v1',
                'provider': provider, 'sandboxRevision': revision,
                'policyFingerprint': policy, 'status': 'passed'}
    if any(proof.get(key) != value for key, value in expected.items()):
        raise ValueError('absent or stale qualification')
    observed = collect(provider, cache)
    if proof.get('runtimeArtifacts') != observed:
        raise ValueError('qualified Linux executable changed')
    return observed


def main():
    operation, provider, *arguments = sys.argv[1:]
    if provider not in PROVIDERS:
        raise ValueError('unknown provider')
    if operation == 'inspect':
        print(json.dumps(collect(provider), sort_keys=True))
        return
    revision, policy = arguments
    if len(revision) != 64 or len(policy) != 64:
        raise ValueError('invalid fingerprint')
    protected('/opt', True)
    protected(ROOT, True)
    if operation == 'write':
        if os.getuid() != 0:
            raise ValueError('qualification must be installed by root')
        proof = json.loads(sys.stdin.read(8193))
        validate_receipt(proof, provider, revision, policy)
        RECEIPTS.mkdir(mode=0o755, exist_ok=True)
        protected(RECEIPTS, True)
        fd, temporary = tempfile.mkstemp(prefix='.proof-', dir=RECEIPTS)
        try:
            with os.fdopen(fd, 'w') as file:
                json.dump(proof, file, sort_keys=True)
                file.flush()
                os.fsync(file.fileno())
            os.chmod(temporary, 0o644)
            os.replace(temporary, RECEIPTS / (provider + '.json'))
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    elif operation in ('verify', 'verify-cold', 'verify-strict'):
        protected(RECEIPTS, True)
        fd = os.open(RECEIPTS / (provider + '.json'), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd) as file:
            info = os.fstat(file.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                    info.st_mode & 0o022 or info.st_nlink != 1 or info.st_size > 8192):
                raise ValueError('unprotected qualification receipt')
            raw = file.read(8193)
            if len(raw.encode()) > 8192:
                raise ValueError('qualification receipt exceeds its bound')
            context = {'schemaVersion': 1, 'provider': provider,
                       'sandboxRevision': revision, 'policyFingerprint': policy,
                       'receipt': identity(RECEIPTS / (provider + '.json'), info),
                       'receiptSha256': hashlib.sha256(raw.encode()).hexdigest()}
            cache = HashCache(provider, context) if operation != 'verify-strict' else None
            if operation == 'verify-cold':
                cache.entries = {}  # Explicit diagnostic: force real file hashing.
            artifacts = validate_receipt(json.loads(raw), provider, revision, policy, cache)
            receipt_path = RECEIPTS / (provider + '.json')
            if (identity(receipt_path, os.fstat(file.fileno())) != context['receipt'] or
                    identity(receipt_path, receipt_path.lstat()) != context['receipt']):
                raise ValueError('qualification changed while verifying')
        if cache:
            cache.save()
        # The caller incorporates actual native executable hashes into its
        # serving-runtime identity, not merely into an admission yes/no bit.
        print(json.dumps(artifacts, sort_keys=True))
        return
    else:
        raise ValueError('unknown operation')
    print('verified')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('capability_missing: Linux text policy proof is absent, stale or its pinned runtime changed; run the isolated loopback policy probe', file=sys.stderr)
        sys.exit(65)
