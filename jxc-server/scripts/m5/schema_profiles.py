"""Pinned migration profiles shared by read-only auditing and recovery provenance checks."""
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent


def identity(row):
    try:version='.'.join(str(int(part)) for part in str(row['version']).split('.'))
    except (KeyError,TypeError,ValueError):return None
    return version,row.get('script')


def select_contract(migrations):
    if not migrations or any(row.get('success') is False for row in migrations):return None
    observed=[identity(row) for row in migrations]
    if None in observed or len(observed)!=len(set(observed)):return None
    actual=set(observed)
    for name in ('audit_contract_closure.json','audit_contract.json'):
        path=HERE/name
        if not path.is_file():continue
        contract=json.loads(path.read_bytes())
        required={identity(row) for row in contract['migrations']}
        allowed={identity(row) for row in contract.get('allowed_additions',{}).get('migrations',[])}
        if required<=actual<=required|allowed:return path,contract
    return None
