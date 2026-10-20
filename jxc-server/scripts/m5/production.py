#!/usr/bin/env python3
"""Explicit production target review and guarded restore using the existing M5 restore core.

A valid manifest is input validation, not production acceptance. This tool never posts,
closes, approves data, installs containers, provisions identities or resumes writes.
"""
import argparse
import importlib.util
import json
import math
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('m5_recovery', HERE / 'recovery.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class ProductionError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ProductionError(message)


def reviewed_text(value):
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        return False
    return re.match(r'^(?:TODO|TBD|PENDING|UNKNOWN|PLACEHOLDER|NOT[_ -]EXECUTED|N/A)(?:$|[\s:_-])',
                    value, re.IGNORECASE) is None


def evidence_references(value):
    return isinstance(value, list) and bool(value) and all(reviewed_text(item) for item in value)


def pinned_evidence(directory, item, label):
    require(isinstance(item, dict) and set(item) == {'path', 'sha256'}
            and reviewed_text(item.get('path')), 'Pinned evidence required: ' + label)
    source = recovery.private(directory / item['path'])
    require(re.fullmatch(r'[0-9a-f]{64}', str(item['sha256'])) is not None
            and recovery.hash_file(source) == item['sha256'], 'Evidence hash mismatch: ' + label)
    return source


def backup_policy(value):
    policy = value.get('backupPolicy', {'mode': 'INDEPENDENT_OFFSITE'})
    require(isinstance(policy, dict), 'Reviewed backup policy object required')
    mode = policy.get('mode')
    if mode == 'INDEPENDENT_OFFSITE':
        require(set(policy) == {'mode'}, 'Independent backup policy fields invalid')
        require(value.get('backupIndependentFromSourceHost') is True, 'Independent backup location must be confirmed')
    elif mode == 'LOCAL_ONLY_TEMPORARY':
        require(set(policy) == {'mode', 'reviewedBy', 'decisionEvidence'} and reviewed_text(policy.get('reviewedBy'))
                and isinstance(policy.get('decisionEvidence'), dict), 'Pinned human backup decision required')
        require(value.get('backupIndependentFromSourceHost') is False, 'Local-only backup cannot claim host independence')
        location = Path(value['backupLocation'])
        require(location.is_absolute() and len(location.parts) > 1 and '..' not in location.parts
                and all(reviewed_text(part) for part in location.parts[1:]), 'Explicit absolute local backup path required')
        recovery.outside_workspace(location)
    else:
        raise ProductionError('Unknown backup policy')
    return mode


def review_local_backup(directory, value, recovered, checked):
    policy = value['backupPolicy']
    decision_path = pinned_evidence(directory, policy['decisionEvidence'], 'backupPolicy.decisionEvidence')
    decision = recovery.read_json(decision_path)
    require(isinstance(decision, dict) and decision.get('mode') == 'LOCAL_ONLY_TEMPORARY'
            and decision.get('reviewedBy') == policy['reviewedBy']
            and all(decision.get(field) == value[field] for field in ('targetHost', 'backupLocation'))
            and reviewed_text(decision.get('decisionReference')) and reviewed_text(decision.get('reason')),
            'Human decision does not authorize this exact local backup policy')
    checked['backupPolicy.decisionEvidence'] = policy['decisionEvidence']['sha256']
    require(recovered.get('physicalOffsiteDurabilityVerified') is False
            and recovered.get('recoveryScope') == 'LOCAL_HOST_AVAILABLE'
            and recovered.get('backupLocation') == value['backupLocation'], 'Local recovery scope or backup path mismatch')
    backup_directory = recovery.private(Path(value['backupLocation']), directory=True)
    local = recovered.get('localBackupEvidence')
    require(isinstance(local, dict) and set(local) == {'sealedBackup', 'unsealReceipt', 'restoreReceipt', 'unsealedBundle'},
            'Pinned encrypted local backup and restore receipts required')
    sources = {}
    for field in ('sealedBackup', 'unsealReceipt', 'restoreReceipt'):
        item = local[field]
        sources[field] = pinned_evidence(directory, item, 'localBackupEvidence.' + field)
        checked['localBackupEvidence.' + field] = item['sha256']
    require(sources['sealedBackup'].resolve().is_relative_to(backup_directory.resolve()),
            'Encrypted backup is outside the reviewed local backup directory')
    spec = importlib.util.spec_from_file_location('m5_seal', HERE / 'seal.py')
    envelope = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(envelope)
    try:
        envelope.openssl('cms', '-cmsout', '-inform', 'DER', '-in', sources['sealedBackup'], '-noout')
    except envelope.SealError:
        raise ProductionError('Reviewed local backup is not a valid CMS envelope') from None
    unsealed = recovery.read_json(sources['unsealReceipt'])
    require(isinstance(unsealed, dict) and unsealed.get('status') == 'UNSEALED'
            and unsealed.get('databaseRestored') is False and unsealed.get('sha256') == local['sealedBackup']['sha256'],
            'Successful unseal receipt for the exact encrypted backup required')
    bundle = local['unsealedBundle']
    require(isinstance(bundle, dict) and set(bundle) == {'path', 'manifestSha256'}
            and reviewed_text(bundle.get('path')), 'Pinned unsealed M5 bundle required')
    bundle_path = recovery.private(directory / bundle['path'], directory=True)
    manifest = recovery.verify_bundle(bundle_path, bundle['manifestSha256'])
    require(manifest.get('source') == {field: value['targetAllowlist'][field] for field in ('container', 'database')},
            'Unsealed backup source does not match the reviewed production target')
    require(unsealed.get('manifestSha256') == bundle['manifestSha256']
            and unsealed.get('batchId') == manifest['batchId'] and unsealed.get('source') == manifest['source']
            and unsealed.get('bundlePath') == str(bundle_path.resolve()),
            'Selected CMS unseal receipt does not identify this exact verified M5 bundle')
    checked['localBackupEvidence.unsealedBundle.manifestSha256'] = bundle['manifestSha256']
    restored = recovery.read_json(sources['restoreReceipt'])
    require(isinstance(restored, dict) and restored.get('status') in ('RESTORED', 'VERIFIED_REPLAY')
            and restored.get('manifestSha256') == bundle['manifestSha256'] and restored.get('batchId') == manifest['batchId'],
            'Successful existing M5 restore receipt for the exact unsealed bundle required')
    verification = restored.get('verification', {})
    require(isinstance(verification, dict) and all(verification.get(field) is True for field in
            ('constraintsValid', 'schemaMatches', 'allTableDigestsMatch', 'allAttachmentHashesMatch')),
            'Local restored schema, tables and attachments remain unverified')
    allowed = value['targetAllowlist']
    target, storage = restored.get('target'), restored.get('storageTarget')
    require(isinstance(target, dict) and all(reviewed_text(target.get(field)) for field in ('container', 'database'))
            and (target['container'], target['database']) != (allowed['container'], allowed['database'])
            and isinstance(storage, dict) and all(reviewed_text(storage.get(field)) for field in ('endpoint', 'bucket'))
            and (storage['endpoint'].rstrip('/'), storage['bucket']) != (allowed['storageEndpoint'].rstrip('/'), allowed['storageBucket']),
            'Local restore evidence must identify a separate database and bucket')
    return {'kind': 'OFF_HOST_BACKUP_DURABILITY', 'policy': 'LOCAL_ONLY_TEMPORARY',
            'reviewedBy': policy['reviewedBy'], 'decisionReference': decision['decisionReference'],
            'decisionEvidenceSha256': policy['decisionEvidence']['sha256'], 'backupLocation': value['backupLocation'],
            'recoveryScope': 'LOCAL_HOST_AVAILABLE', 'sourceHostLossRecoveryVerified': False}


def check_identity(target, allowed, actual):
    expected = {'container': target.get('container'), 'database': target.get('database'),
                'storageEndpoint': target.get('storage', {}).get('endpoint', '').rstrip('/'),
                'storageBucket': target.get('storage', {}).get('bucket')}
    require(set(allowed) == {'container', 'database', 'systemIdentifier', 'storageEndpoint', 'storageBucket'},
            'Exact production target allowlist fields required')
    require(all(expected[key] == allowed[key] for key in expected), 'Target is not on the exact production allowlist')
    require(str(allowed['systemIdentifier']).isdigit() and len(str(allowed['systemIdentifier'])) >= 10,
            'Pinned PostgreSQL cluster identity required')
    require(actual == {'database': allowed['database'], 'systemIdentifier': str(allowed['systemIdentifier'])},
            'Live target database or PostgreSQL cluster identity mismatch')


def validate_release(value):
    for field in ('applicationImage', 'gatewayImage'):
        require(isinstance(value.get(field), str) and re.fullmatch(r'(?:[^\s@A-Z]+@)?sha256:[0-9a-f]{64}', value[field]),
                'Reviewed immutable image digest or local image Id required: ' + field)
    for field in ('reviewedBy', 'targetHost', 'domain', 'backupLocation', 'backupCustodian', 'configurationOwner', 'maintenanceWindow'):
        require(reviewed_text(value.get(field)), 'Production input required: ' + field)
    backup_policy(value)
    for field in ('rpoSeconds', 'rtoSeconds', 'concurrentUsers', 'expectedTransactionRows'):
        require(type(value.get(field)) is int and value[field] > 0, 'Confirmed positive capacity/recovery input required: ' + field)
    allowed=value.get('targetAllowlist')
    require(isinstance(allowed,dict) and set(allowed)=={'container','database','systemIdentifier','storageEndpoint','storageBucket'},'Exact production restore allowlist required')
    require(all(isinstance(v,str) and v.strip() for v in allowed.values()),'Reviewed production target identities required')
    require(allowed['systemIdentifier'].isdigit() and len(allowed['systemIdentifier'])>=10,'Pinned PostgreSQL cluster identity required')
    for field in ('initializationManifest', 'recoveryEvidence', 'capacityEvidence', 'permissionReview', 'pageAcceptance', 'keyCustodyEvidence'):
        require(isinstance(value.get(field), dict) and set(value[field]) == {'path', 'sha256'}, 'Pinned evidence required: ' + field)
    return value


def review_release(path):
    path = recovery.private(Path(path))
    value = validate_release(recovery.read_json(path))
    checked = {}
    for field in ('initializationManifest', 'recoveryEvidence', 'capacityEvidence', 'permissionReview', 'pageAcceptance', 'keyCustodyEvidence'):
        item = value[field]
        pinned_evidence(path.parent, item, field)
        checked[field] = item['sha256']
    spec = importlib.util.spec_from_file_location('m5_readiness', HERE / 'readiness.py')
    readiness = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(readiness)
    initialization, _, _ = readiness.load_manifest(path.parent / value['initializationManifest']['path'])
    require(initialization['mode'] == 'FIRST_START', 'Production first start cannot use synthetic history rehearsal')
    evidence={field:recovery.read_json(path.parent/value[field]['path']) for field in ('recoveryEvidence','capacityEvidence','permissionReview','pageAcceptance','keyCustodyEvidence')}
    for field,record in evidence.items():
        require(isinstance(record, dict) and record.get('applicationImage') == value['applicationImage']
                and reviewed_text(record.get('reviewedBy')), 'Stale/unreviewed release evidence: ' + field)
        require(record.get('targetHost') == value['targetHost'], 'Production evidence host mismatch: ' + field)
    # Page and request-latency acceptance exercise the public frontend and TLS/proxy route.
    for field in ('capacityEvidence', 'pageAcceptance'):
        require(all(evidence[field].get(key) == value[key] for key in ('gatewayImage', 'domain')),
                'Production gateway or domain mismatch: ' + field)
    # Direct recovery, authorization and key reviews apply to the exact DB cluster/private bucket.
    for field in ('recoveryEvidence', 'permissionReview', 'keyCustodyEvidence'):
        require(evidence[field].get('targetAllowlist') == value['targetAllowlist'],
                'Production database or storage identity mismatch: ' + field)
    # These are measured inputs, not estimates copied from the requested configuration.
    for field, measured, bound in (('capacityEvidence', 'p95Seconds', 2), ('recoveryEvidence', 'rtoSeconds', value['rtoSeconds']), ('recoveryEvidence', 'rpoSeconds', value['rpoSeconds'])):
        measurement = evidence[field].get(measured)
        require(type(measurement) in (int, float) and
                (type(measurement) is int or math.isfinite(measurement)) and 0 <= measurement <= bound,
                'Measured release threshold not met: ' + measured)
    capacity=evidence['capacityEvidence'];recovered=evidence['recoveryEvidence']
    require(all(type(capacity.get(field)) is int and capacity[field] >= value[requested]
                for field, requested in (('concurrentUsers', 'concurrentUsers'), ('transactionRows', 'expectedTransactionRows'))),
            'Confirmed production scale was not exercised')
    require(recovered.get('sourceSecretsDirectoryRemoved') is True and recovered.get('independentRecipientKeyUsed') is True,
            'Production secret-loss recovery or independent recipient key remains unverified')
    mode = backup_policy(value)
    deferred = []
    if mode == 'LOCAL_ONLY_TEMPORARY':
        deferred.append(review_local_backup(path.parent, value, recovered, checked))
    else:
        require(recovered.get('physicalOffsiteDurabilityVerified') is True,
                'Production off-host durability remains unverified')
    required={'PERMISSIONS','APPROVALS','BOOK_ACCOUNTS','MAPPINGS','FX','COSTING','FUND_ACCOUNTS','KEYS','OPENING'}
    reviews=evidence['permissionReview'].get('items',[])
    require(isinstance(reviews,list) and len(reviews) == len(required)
            and all(isinstance(row, dict) for row in reviews) and {r.get('kind') for r in reviews}==required,
            'Configuration review list incomplete')
    require(all(r.get('status')=='CONFIRMED' and reviewed_text(r.get('reviewedBy'))
                and (reviewed_text(r.get('evidence')) or evidence_references(r.get('evidence'))) for r in reviews),
            'Unconfirmed production configuration or opening')
    pages=evidence['pageAcceptance'];items=pages.get('items',[])
    require(isinstance(items,list) and len(items)==38 and {r.get('id') for r in items if isinstance(r,dict)}=={'A'+str(n).zfill(2) for n in range(1,39)},'Original A01-A38 acceptance list incomplete')
    for row in items:
        browser=row.get('browser',{})
        require(isinstance(browser, dict), 'Real-page acceptance pending: ' + row['id'])
        country = browser.get('country')
        country_valid = (type(country) is int and 0 < country <= 9007199254740991) or reviewed_text(country)
        require(browser.get('status')=='passed' and reviewed_text(browser.get('operator')) and country_valid
                and evidence_references(browser.get('evidence')), 'Real-page acceptance pending: '+row['id'])
    isolated=pages.get('isolationChecks',[])
    require(isinstance(isolated,list) and all(any(isinstance(row,dict) and row.get('kind')==kind and row.get('status')=='passed'
                and evidence_references(row.get('evidence')) for row in isolated) for kind in ('SECOND_COUNTRY','SECOND_STORE')),
            'Second country/store isolation acceptance pending')
    require(reviewed_text(evidence['keyCustodyEvidence'].get('independentCustodian'))
            and evidence['keyCustodyEvidence']['independentCustodian']==value['backupCustodian'],
            'Independent key custody remains unconfirmed')
    return {'status': 'MANIFEST_VALIDATED', 'productionReleased': False, 'evidenceHashes': checked,
            'backupPolicy': mode, 'acceptedDeferrals': deferred, 'offHostDurabilityVerified': not bool(deferred)}


def guarded_restore(config, allowlist_path, allowlist_pin, bundle, manifest_pin, expected_target, receipt):
    target = config.get('target', {})
    recovery.validate_database(target)
    require(expected_target == target['container'] + '/' + target['database'], 'Exact target confirmation mismatch')
    allowlist_path = recovery.private(Path(allowlist_path))
    require(recovery.hash_file(allowlist_path) == allowlist_pin, 'External production allowlist hash mismatch')
    allowed = recovery.read_json(allowlist_path)

    def validate(session, current):
        actual = session.json("SELECT json_build_object('database',current_database(),'systemIdentifier',system_identifier::text) FROM pg_control_system()")
        check_identity(current, allowed, actual)

    # Validate before any effects, then validate again under the restore core's held target guard.
    with recovery.PgSession(target) as session:
        validate(session, target)
    return recovery.restore_validated_target(config, bundle, manifest_pin, receipt, validate)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    check = sub.add_parser('check')
    check.add_argument('--manifest', required=True)
    restore = sub.add_parser('restore')
    for field in ('config', 'allowlist', 'allowlist-sha256', 'bundle', 'manifest-sha256', 'expect-target', 'receipt'):
        restore.add_argument('--' + field, required=True)
    args = parser.parse_args()
    config = {}
    try:
        if args.action == 'check':
            result = review_release(args.manifest)
        else:
            config = recovery.load_config(args.config)
            result = guarded_restore(config, args.allowlist, args.allowlist_sha256, args.bundle, args.manifest_sha256, args.expect_target, args.receipt)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    except (ProductionError, recovery.RecoveryError, OSError, ValueError) as error:
        print(json.dumps({'status': 'BLOCKED', 'productionReleased': False, 'reason': recovery.safe_error(error, config)}, ensure_ascii=False), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
