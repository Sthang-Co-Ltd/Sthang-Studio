"""One-use exact-byte transport of reviewed local source edits; no product/runtime data.
Removed from the PR after transfer. This is not portfolio intake or release tooling.
"""
from pathlib import Path
import hashlib
import json
import subprocess


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


expected = [
    'aaa1f071af9e3e4d5f026637142ca7693222cc6b',
    '1982416246b158685cb2f5ac90c70703026ee75d',
    'f2b8786c8a0589d7f712cd4dc586fc61f1e37667',
    '849253c4897252cfb8d7afa233f457f0da704eb3',
]
rows = []
for index, sha in enumerate(expected):
    data = Path(f'.audit-transfer/{index}.json').read_bytes()
    assert blob(data) == sha, 'Transport descriptor changed'
    rows.extend(json.loads(data))
assert len(rows) == 38 and len({row['path'] for row in rows}) == 38
prepared = []
for row in rows:
    name = row['path']
    file = Path(name)
    assert not file.is_absolute() and '..' not in file.parts and '.git' not in file.parts
    assert name.startswith(('apps/', 'packages/', 'tests/')) or name in {'.gitignore', 'package.json', 'package-lock.json', 'playwright.config.ts'}
    assert file.is_file() and not file.is_symlink(), name
    assert all(not parent.is_symlink() for parent in file.parents), name
    old = file.read_bytes()
    if row['before'] is None:
        assert blob(old) == row['after'] and not row['edits'], name
        continue
    assert blob(old) == row['before'], f'Unexpected revision: {name}'
    if row['after'] is None:
        assert not row['edits']
        prepared.append((file, None))
        continue
    last_end = 0
    for edit in row['edits']:
        assert isinstance(edit['at'], int) and isinstance(edit['remove'], int)
        assert edit['at'] >= last_end and edit['remove'] >= 0 and edit['at'] + edit['remove'] <= len(old), name
        last_end = edit['at'] + edit['remove']
    new = old
    for edit in reversed(row['edits']):
        new = new[:edit['at']] + edit['text'].encode() + new[edit['at'] + edit['remove']:]
    assert blob(new) == row['after'], f'Transfer mismatch: {name}'
    prepared.append((file, new))
# No filesystem write happens before EVERY path and expected source/result blob verifies.
for file, data in prepared:
    if data is None:
        file.unlink()
    else:
        file.write_bytes(data)
subprocess.run(['git', 'add', '--', *[str(file) for file, _ in prepared]], check=True)
changed = set(git('diff', '--cached', '--name-only').splitlines())
assert changed == {str(file) for file, _ in prepared}, 'Unexpected staged paths'
for row in rows:
    if row['after']:
        assert git('rev-parse', ':' + row['path']) == row['after'], row['path']
print('Verified and staged all 38 exact local source results; no other paths changed.')
