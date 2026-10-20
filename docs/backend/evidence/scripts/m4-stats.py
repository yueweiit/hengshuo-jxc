#!/usr/bin/env python3
"""Reproducible phase snapshot diff. M4/M5 remain compatible; closure uses --phase release."""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[4])
parser.add_argument('--baseline', type=Path)
parser.add_argument('--output', type=Path)
parser.add_argument('--phase', choices=('m4', 'm5', 'release'), default='m4')
args = parser.parse_args()
root = args.root.resolve()
base = (args.baseline or Path(Path(f'/tmp/hengshuo-{args.phase}-baseline-path').read_text().strip())).resolve()
output_path = args.output or root / f'docs/backend/evidence/change-statistics-{args.phase}.json'
excluded = {f'docs/backend/evidence/change-statistics-{args.phase}.json', f'docs/backend/evidence/verification-{args.phase}.json'}
ignored = {'.git', 'target', 'node_modules', 'dist', '__pycache__'}

def inventory(folder):
    result = {}
    tops = ('docs', 'jxc-server', 'jxc-web', 'deploy') if args.phase == 'release' else ('docs', 'jxc-server', 'jxc-web')
    for top in tops:
        if not (folder / top).is_dir():
            if args.phase == 'release' and top == 'deploy':
                continue
            raise ValueError(f'Missing snapshot root: {folder / top}')
        paths=[]
        def fail(error):raise error
        for directory, children, files in os.walk(folder/top,onerror=fail):
            children[:] = [name for name in children if name not in ignored and not re.fullmatch(r'target \d+',name)]
            paths.extend(Path(directory)/name for name in files)
        for path in paths:
            relative = path.relative_to(folder).as_posix()
            if (not path.is_file() or any(part in ignored or re.fullmatch(r"target \d+", part) for part in path.relative_to(folder).parts)
                    or path.name == '.DS_Store' or path.name.endswith('.tsbuildinfo') or relative in excluded):
                continue
            result[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    if args.phase == 'release':
        for name in ('.gitignore', '.dockerignore'):
            if (folder / name).is_file():
                result[name] = hashlib.sha256((folder / name).read_bytes()).hexdigest()
    return result

generated = {f'docs/backend/contracts/{name}.json' for name in
             ('route-catalog', 'openapi', 'controller-mappings', 'mock-regressions', 'request-evidence')}
generated.add('jxc-server/scripts/m5/audit_contract.json')
generated.add('jxc-server/scripts/m5/audit_contract_closure.json')

def category(path):
    if path.endswith('.md'):
        return 'manual_docs_and_contracts'
    if args.phase == 'release' and path.startswith('docs/backend/evidence/') and not path.startswith('docs/backend/evidence/scripts/'):
        return 'acceptance_artifacts'
    if (path.startswith('docs/backend/evidence/m5/') or path.startswith('docs/backend/evidence/m5-')
            or path.startswith('docs/backend/evidence/browser-m4/')
            or path in {'docs/backend/evidence/browser-m4.json', 'docs/backend/evidence/runtime-m4.json'}):
        return 'acceptance_artifacts'
    if path.startswith('docs/backend/evidence/scripts/'):
        return 'configuration_build_scripts'
    if path in generated:
        return 'generated_contracts'
    if '/src/test/' in path or path.startswith(('jxc-web/tests/', 'jxc-server/scripts/m5/tests/')):
        return 'tests'
    if '/db/migration/' in path:
        return 'migration_sql'
    if '/src/main/java/' in path:
        return 'backend_business_java'
    if path.startswith('jxc-web/src/'):
        return 'frontend_business'
    if path.startswith('docs/'):
        return 'manual_docs_and_contracts'
    return 'configuration_build_scripts'

def empty():
    return dict(added_files=0, modified_files=0, deleted_files=0, changed_files=0,
                added_lines=0, deleted_lines=0, net_lines=0, binary_changed_files=0)

before, after = inventory(base), inventory(root)
categories = {name: empty() for name in ('backend_business_java', 'migration_sql', 'frontend_business',
                                       'tests', 'configuration_build_scripts', 'manual_docs_and_contracts',
                                       'generated_contracts', 'acceptance_artifacts')}
summary, changes = empty(), []
for path in sorted(before.keys() | after.keys()):
    if before.get(path) == after.get(path):
        continue
    state = 'added' if path not in before else 'deleted' if path not in after else 'modified'
    old = str(base / path) if path in before else '/dev/null'
    new = str(root / path) if path in after else '/dev/null'
    diff = subprocess.run(['git', 'diff', '--no-index', '--numstat', '--', old, new],
                          capture_output=True, text=True)
    if diff.returncode not in (0, 1):
        raise RuntimeError(diff.stderr)
    fields = diff.stdout.strip().split('\t')
    if len(fields) < 3:
        raise ValueError(f'No numstat for changed file: {path}')
    binary = fields[0] == '-'
    added, deleted = (0, 0) if binary else (int(fields[0]), int(fields[1]))
    group = category(path)
    for target in (categories[group], summary):
        target[state + '_files'] += 1
        target['changed_files'] += 1
        target['added_lines'] += added
        target['deleted_lines'] += deleted
        target['net_lines'] += added - deleted
        target['binary_changed_files'] += int(binary)
    changes.append(dict(path=path, change=state, category=group, added_lines=added, deleted_lines=deleted,
                        baseline_sha256=before.get(path), current_sha256=after.get(path)))

result = dict(
    generated_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
    workspace=str(root), baseline=str(base),
    method=f'Full {args.phase.upper()} before/after snapshots of docs, jxc-server and jxc-web'
           + (', deploy, .gitignore and .dockerignore' if args.phase == 'release' else '')
           + '; SHA-256 path comparison; '
           'git diff --no-index --numstat for line counts; no rename detection.',
    ignored_directories=sorted(ignored), ignored_files=['.DS_Store', '*.tsbuildinfo'],
    excluded_evidence_files=sorted(excluded),
    excluded_evidence_note='The two manifest files are excluded to prevent self-referential hashes/line counts. '
                           'Report their added/modified/deleted status separately in the acceptance document.',
    excluded_evidence_changes=[dict(path=p, change='modified' if (base / p).is_file() else 'added')
                               for p in sorted(excluded) if (root / p).is_file()],
    baseline_file_count=len(before), current_file_count=len(after),
    summary=summary, categories=categories, changes=changes)
output_path.parent.mkdir(parents=True, exist_ok=True)
output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(dict(output=str(output_path), summary=summary, categories=categories), ensure_ascii=False))
