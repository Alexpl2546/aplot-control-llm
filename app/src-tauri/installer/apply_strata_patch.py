"""Apply the reviewed Aplot patch to its pinned Strata source without requiring Git."""
from pathlib import Path
import re
import sys


def parse_patch(source):
    files = []
    current = None
    hunk = None
    for line in source.splitlines(keepends=True):
        if line.startswith('+++ b/'):
            current = {'path': line[6:].strip(), 'hunks': []}
            files.append(current)
            hunk = None
        elif line.startswith('@@ '):
            match = re.match(r'@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@', line)
            if current is None or match is None:
                raise ValueError('Invalid patch hunk')
            hunk = {'old': int(match[1]), 'new': int(match[2]), 'lines': []}
            current['hunks'].append(hunk)
        elif hunk is not None and line[:1] in (' ', '+', '-'):
            hunk['lines'].append(line)
        elif line.startswith('diff --git '):
            hunk = None
    return files


def apply_text(text, hunks, reverse=False):
    lines = text.splitlines(keepends=True)
    output = []
    cursor = 0
    for hunk in hunks:
        position = max(0, hunk['new' if reverse else 'old'] - 1)
        old = [line[1:] for line in hunk['lines'] if line[0] in (' ', '+' if reverse else '-')]
        new = [line[1:] for line in hunk['lines'] if line[0] in (' ', '-' if reverse else '+')]
        # A reviewed unified hunk ending with a change has no trailing context:
        # it targets EOF. Without this check an append can match its unchanged
        # prefix again on every retry and duplicate the added section.
        at_eof = bool(hunk['lines']) and hunk['lines'][-1][0] in ('+', '-')
        if (position < cursor or lines[position:position + len(old)] != old
                or (at_eof and position + len(old) != len(lines))):
            raise ValueError('Patch context does not match the pinned source')
        output.extend(lines[cursor:position])
        output.extend(new)
        cursor = position + len(old)
    return ''.join(output + lines[cursor:])


def apply(root, patch):
    root = Path(root).resolve()
    updates = []
    for file in parse_patch(Path(patch).read_text(encoding='utf-8')):
        path = (root / file['path']).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError('Patch file is outside the Strata source')
        original = path.read_text(encoding='utf-8')
        try:
            updated = apply_text(original, file['hunks'])
        except ValueError:
            apply_text(original, file['hunks'], reverse=True)
            continue  # Already applied; do not apply it twice on a retry.
        updates.append((path, updated))
    for path, updated in updates:
        path.write_text(updated, encoding='utf-8', newline='\n')


if __name__ == '__main__':
    apply(sys.argv[1], sys.argv[2])
