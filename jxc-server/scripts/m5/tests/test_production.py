"""Production identity must be explicit; M5 prefix isolation remains independently enforced."""
import importlib.util
import copy
import json
from pathlib import Path
import tempfile
import unittest
from test_recovery import tool


def production():
    path = Path(__file__).resolve().parents[1] / 'production.py'
    spec = importlib.util.spec_from_file_location('production', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ProductionBoundaryTest(unittest.TestCase):
    def release_fixture(self, application_image=None, gateway_image=None):
        from test_readiness import ReadinessTests
        fixture = ReadinessTests('test_first_start_reads_real_evidence_without_importing_or_rewriting')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        initial = fixture.save()
        initial.chmod(0o600)
        fixture.directory.chmod(0o700)
        fixture.source.chmod(0o600)
        p = production()
        value = {'applicationImage': application_image if application_image is not None else 'app@sha256:' + 'a' * 64,
                 'gatewayImage': gateway_image if gateway_image is not None else 'web@sha256:' + 'b' * 64,
                 'reviewedBy': 'fixture-owner', 'targetHost': 'fixture-host', 'domain': 'fixture.example',
                 'backupLocation': 'independent-fixture-host', 'backupCustodian': 'fixture-custodian',
                 'configurationOwner': 'fixture-owner', 'maintenanceWindow': 'fixture-window',
                 'backupIndependentFromSourceHost': True, 'rpoSeconds': 60, 'rtoSeconds': 600,
                 'concurrentUsers': 10, 'expectedTransactionRows': 1000,
                 'targetAllowlist': {'container': 'fixture-db', 'database': 'fixture_db',
                                    'systemIdentifier': '1234567890',
                                    'storageEndpoint': 'https://objects.fixture.example', 'storageBucket': 'fixture-private'}}
        value['initializationManifest'] = {'path': initial.name, 'sha256': p.recovery.hash_file(initial)}
        for field in ('recoveryEvidence', 'capacityEvidence', 'permissionReview', 'pageAcceptance', 'keyCustodyEvidence'):
            evidence = {'applicationImage': value['applicationImage'], 'reviewedBy': 'fixture-owner',
                        'targetHost': value['targetHost']}
            if field in ('recoveryEvidence', 'permissionReview', 'keyCustodyEvidence'):
                evidence['targetAllowlist'] = copy.deepcopy(value['targetAllowlist'])
            if field in ('capacityEvidence', 'pageAcceptance'):
                evidence.update(gatewayImage=value['gatewayImage'], domain=value['domain'])
            if field == 'capacityEvidence':
                evidence.update(p95Seconds=1, concurrentUsers=10, transactionRows=1000)
            if field == 'recoveryEvidence':
                evidence.update(rtoSeconds=10, rpoSeconds=0, physicalOffsiteDurabilityVerified=True,
                                sourceSecretsDirectoryRemoved=True, independentRecipientKeyUsed=True)
            if field == 'keyCustodyEvidence':
                evidence['independentCustodian'] = value['backupCustodian']
            if field == 'permissionReview':
                evidence['items'] = [{'kind': kind, 'status': 'CONFIRMED', 'reviewedBy': 'fixture-owner',
                                      'evidence': 'signed-review-reference'} for kind in
                                     ('PERMISSIONS', 'APPROVALS', 'BOOK_ACCOUNTS', 'MAPPINGS', 'FX', 'COSTING', 'FUND_ACCOUNTS', 'KEYS', 'OPENING')]
            if field == 'pageAcceptance':
                evidence['items'] = [{'id': 'A' + str(number).zfill(2),
                                      'browser': {'status': 'passed', 'operator': 'fixture-owner', 'country': 101,
                                                  'evidence': ['browser-capture-reference']}} for number in range(1, 39)]
                evidence['isolationChecks'] = [{'kind': kind, 'status': 'passed',
                                                 'evidence': ['browser-isolation-reference']}
                                                for kind in ('SECOND_COUNTRY', 'SECOND_STORE')]
            self.save_evidence(p, fixture.directory, value, field, evidence)
        release = fixture.directory / 'release.json'
        release.write_text(json.dumps(value))
        release.chmod(0o600)
        return p, release, value

    def save_evidence(self, p, directory, value, field, evidence):
        path = directory / (field + '.json')
        path.write_text(json.dumps(evidence))
        path.chmod(0o600)
        value[field] = {'path': path.name, 'sha256': p.recovery.hash_file(path)}

    def changed_evidence(self, p, release, value, field, change):
        evidence = json.loads((release.parent / value[field]['path']).read_text())
        change(evidence)
        self.save_evidence(p, release.parent, value, field, evidence)
        release.write_text(json.dumps(value))

    def local_backup_fixture(self):
        from test_recovery import RecoveryBoundaryTest
        from test_seal import SealedBackupTest, sealing
        p, release, value = self.release_fixture()
        backup = release.parent / 'local-backups'
        backup.mkdir(mode=0o700)
        value.update(backupIndependentFromSourceHost=False, backupLocation=str(backup))
        decision = {'mode': 'LOCAL_ONLY_TEMPORARY', 'reviewedBy': 'human-reviewer',
                    'decisionReference': 'human-message-2026-10-19-small-initial-team',
                    'reason': 'Human explicitly defers a separate backup host for the small initial team',
                    'targetHost': value['targetHost'], 'backupLocation': value['backupLocation']}
        self.save_evidence(p, release.parent, value, 'backupDecision', decision)
        value['backupPolicy'] = {'mode': 'LOCAL_ONLY_TEMPORARY', 'reviewedBy': decision['reviewedBy'],
                                 'decisionEvidence': value.pop('backupDecision')}
        bundle_fixture = RecoveryBoundaryTest('test_verified_bundle_accepts_exact_payload_and_pin')
        bundle_fixture.setUp()
        self.addCleanup(bundle_fixture.tearDown)
        manifest = bundle_fixture.make_bundle()
        manifest['source'] = {field: value['targetAllowlist'][field] for field in ('container', 'database')}
        bundle_fixture.write_manifest(manifest)
        envelope_fixture = SealedBackupTest('test_encrypted_backup_restores_after_source_directory_and_local_secrets_are_unavailable')
        envelope_fixture.setUp()
        self.addCleanup(envelope_fixture.tearDown)
        envelope = sealing()
        archive = backup / 'synthetic-backup.cms'
        envelope.seal(bundle_fixture.root, envelope_fixture.root / 'recipient.pem',
                      envelope.recovery.hash_file(envelope_fixture.root / 'recipient.pem'), archive)
        archive_pin = {'path': str(archive), 'sha256': p.recovery.hash_file(archive)}
        unsealed_bundle = release.parent / 'unsealed-bundle'
        unseal = envelope.unseal(archive, archive_pin['sha256'], envelope_fixture.root / 'key.pem', unsealed_bundle)
        restored = {'status': 'RESTORED', 'batchId': manifest['batchId'],
                    'manifestSha256': bundle_fixture.pin(), 'target': {'container': 'isolated-restore-db', 'database': 'restore_db'},
                    'storageTarget': {'endpoint': 'https://restore-objects.fixture.example', 'bucket': 'restore-private'},
                    'verification': {'constraintsValid': True, 'schemaMatches': True,
                                     'allTableDigestsMatch': True, 'allAttachmentHashesMatch': True,
                                     'tableCount': 2, 'rowCount': 3, 'attachmentCount': 1}}
        self.save_evidence(p, release.parent, value, 'unseal', unseal)
        self.save_evidence(p, release.parent, value, 'restore', restored)
        local = {'sealedBackup': archive_pin, 'unsealReceipt': value.pop('unseal'),
                 'restoreReceipt': value.pop('restore'),
                 'unsealedBundle': {'path': str(unsealed_bundle), 'manifestSha256': bundle_fixture.pin()}}
        self.changed_evidence(p, release, value, 'recoveryEvidence',
                              lambda record: record.update(physicalOffsiteDurabilityVerified=False,
                                                           recoveryScope='LOCAL_HOST_AVAILABLE',
                                                           backupLocation=value['backupLocation'], localBackupEvidence=local))
        return p, release, value

    def test_production_identity_requires_exact_allowlist_and_cluster_identity(self):
        p = production()
        target = {'container': 'reviewed-db', 'database': 'reviewed_db', 'storage': {'endpoint': 'https://objects.example', 'bucket': 'reviewed-private'}}
        allowed = {'container': 'reviewed-db', 'database': 'reviewed_db', 'systemIdentifier': '1234567890', 'storageEndpoint': 'https://objects.example', 'storageBucket': 'reviewed-private'}
        p.check_identity(target, allowed, {'database': 'reviewed_db', 'systemIdentifier': '1234567890'})
        for changes in ({'database': 'other'}, {'systemIdentifier': 'other'}):
            actual = {'database': 'reviewed_db', 'systemIdentifier': '1234567890', **changes}
            with self.assertRaises(p.ProductionError):
                p.check_identity(target, allowed, actual)
        with self.assertRaises(p.ProductionError):
            p.check_identity({**target, 'database': 'other'}, allowed, {'database': 'reviewed_db', 'systemIdentifier': '1234567890'})

    def test_unreviewed_images_and_missing_recovery_targets_are_blocked(self):
        p = production()
        with self.assertRaises(p.ProductionError):
            p.validate_release({'applicationImage': 'app:latest', 'gatewayImage': 'web:latest'})
        with self.assertRaises(p.ProductionError):
            p.validate_release({'applicationImage': 'app@sha256:' + 'a'*64, 'gatewayImage': 'web@sha256:' + 'b'*64})

    def test_complete_manifest_accepts_exact_docker_image_ids_and_repository_digests(self):
        for application in ('sha256:' + 'a' * 64, 'app@sha256:' + 'a' * 64):
            for gateway in ('sha256:' + 'b' * 64, 'web@sha256:' + 'b' * 64):
                with self.subTest(application=application, gateway=gateway):
                    p, release, value = self.release_fixture(application, gateway)
                    result = p.review_release(release)
                    self.assertEqual('MANIFEST_VALIDATED', result['status'])
                    self.assertFalse(result['productionReleased'])

    def test_mutable_tags_short_or_case_changed_image_hashes_are_not_immutable(self):
        p, release, value = self.release_fixture()
        invalid = ('app:latest', 'registry.example/app:reviewed', 'a' * 64,
                   'sha256:' + 'a' * 12, 'sha256:' + 'a' * 63, 'sha256:' + 'a' * 65,
                   'sha256:' + 'A' * 64, 'SHA256:' + 'a' * 64,
                   'sha256:' + 'a' * 64 + ' ', ' sha256:' + 'a' * 64,
                   'sha256:' + 'a' * 64 + '\n', 'app@SHA256:' + 'a' * 64,
                   'App@sha256:' + 'a' * 64, '', None, True)
        for field in ('applicationImage', 'gatewayImage'):
            for image in invalid:
                with self.subTest(field=field, image=image), self.assertRaisesRegex(p.ProductionError, 'immutable image'):
                    p.validate_release({**value, field:image})

    def test_docker_image_id_evidence_is_not_normalized_or_reused_across_images(self):
        scopes = [('applicationImage', field) for field in ('recoveryEvidence', 'capacityEvidence',
                  'permissionReview', 'pageAcceptance', 'keyCustodyEvidence')]
        scopes += [('gatewayImage', field) for field in ('capacityEvidence', 'pageAcceptance')]
        for image_field, evidence_field in scopes:
            for wrong in ('sha256:' + 'c' * 64, ('app' if image_field == 'applicationImage' else 'web')
                          + '@sha256:' + ('a' if image_field == 'applicationImage' else 'b') * 64):
                with self.subTest(image_field=image_field, evidence_field=evidence_field, wrong=wrong):
                    p, release, value = self.release_fixture('sha256:' + 'a' * 64, 'sha256:' + 'b' * 64)
                    self.changed_evidence(p, release, value, evidence_field,
                                          lambda record:record.update({image_field:wrong}))
                    with self.assertRaises(p.ProductionError):p.review_release(release)

    def test_docker_image_ids_keep_human_page_and_exact_restore_target_guards(self):
        for field, change in (
                ('pageAcceptance', lambda record:record['items'][0]['browser'].update(operator=False)),
                ('permissionReview', lambda record:record['items'][0].update(reviewedBy='UNKNOWN')),
                ('recoveryEvidence', lambda record:record['targetAllowlist'].update(database='different_db')),
                ('keyCustodyEvidence', lambda record:record.update(independentCustodian='UNKNOWN'))):
            with self.subTest(field=field):
                p, release, value = self.release_fixture('sha256:' + 'a' * 64, 'sha256:' + 'b' * 64)
                self.changed_evidence(p, release, value, field, change)
                with self.assertRaises(p.ProductionError):p.review_release(release)

    def test_production_support_does_not_weaken_the_existing_m5_target_guard(self):
        config = {'container': 'reviewed-db', 'database': 'reviewed_db', 'adminUser': 'postgres', 'ownerRole': 'jxc_owner', 'runtimeRole': 'jxc_app', 'storage': {'endpoint': 'https://objects.example', 'accessKey': 'redacted', 'secretKey': 'redacted', 'bucket': 'reviewed-private'}}
        with self.assertRaises(tool().RecoveryError):
            tool().validate_target(config, 'reviewed-db/reviewed_db')

    def test_complete_evidence_manifest_is_only_validated_and_never_releases_production(self):
        p, release, value = self.release_fixture()
        result=p.review_release(release)
        self.assertEqual('MANIFEST_VALIDATED',result['status'])
        self.assertFalse(result['productionReleased'])
        self.assertEqual('INDEPENDENT_OFFSITE', result['backupPolicy'])
        self.assertTrue(result['offHostDurabilityVerified'])
        self.assertEqual([], result['acceptedDeferrals'])

        # Hash-correct evidence with an unexecuted original page must still block first release.
        self.changed_evidence(p, release, value, 'pageAcceptance',
                              lambda record: record['items'][16]['browser'].update(status='not_executed'))
        with self.assertRaises(p.ProductionError):p.review_release(release)

    def test_original_pages_are_bound_to_both_images_and_exact_public_target(self):
        for field in ('applicationImage', 'gatewayImage', 'targetHost', 'domain'):
            for missing in (False, True):
                with self.subTest(field=field, missing=missing):
                    p, release, value = self.release_fixture()
                    self.changed_evidence(p, release, value, 'pageAcceptance',
                                          lambda record: record.pop(field) if missing else record.update({field: 'other-target'}))
                    with self.assertRaises(p.ProductionError):
                        p.review_release(release)

    def test_capacity_is_measured_through_the_reviewed_gateway_and_domain(self):
        for field in ('gatewayImage', 'domain'):
            for missing in (False, True):
                with self.subTest(field=field, missing=missing):
                    p, release, value = self.release_fixture()
                    self.changed_evidence(p, release, value, 'capacityEvidence',
                                          lambda record: record.pop(field) if missing else record.update({field: 'other-target'}))
                    with self.assertRaises(p.ProductionError):
                        p.review_release(release)

    def test_recovery_permissions_and_keys_require_the_reviewed_database_and_storage(self):
        for field in ('recoveryEvidence', 'permissionReview', 'keyCustodyEvidence'):
            for identity in ('container', 'database', 'systemIdentifier', 'storageEndpoint', 'storageBucket'):
                with self.subTest(field=field, identity=identity):
                    p, release, value = self.release_fixture()
                    self.changed_evidence(p, release, value, field,
                                          lambda record: record['targetAllowlist'].update({identity: 'other-target'}))
                    with self.assertRaises(p.ProductionError):
                        p.review_release(release)
            for identity in ('targetHost', 'targetAllowlist'):
                for missing in (False, True):
                    with self.subTest(field=field, identity=identity, missing=missing):
                        p, release, value = self.release_fixture()
                        self.changed_evidence(p, release, value, field,
                                              lambda record: record.pop(identity) if missing else record.update({identity: 'other-target'}))
                        with self.assertRaises(p.ProductionError):
                            p.review_release(release)

    def test_gateway_changes_only_invalidate_gateway_dependent_evidence(self):
        p, release, value = self.release_fixture()
        value['gatewayImage'] = 'web@sha256:' + 'c' * 64
        for field in ('capacityEvidence', 'pageAcceptance'):
            self.changed_evidence(p, release, value, field,
                                  lambda record: record.update(gatewayImage=value['gatewayImage']))
        self.assertEqual('MANIFEST_VALIDATED', p.review_release(release)['status'])

    def test_capacity_counts_cannot_use_infinity_booleans_or_unmeasured_values(self):
        for field in ('concurrentUsers', 'transactionRows'):
            for invalid in (float('inf'), float('nan'), True, 10.5, '1000', None):
                with self.subTest(field=field, invalid=invalid):
                    p, release, value = self.release_fixture()
                    value.update(concurrentUsers=1, expectedTransactionRows=1)
                    self.changed_evidence(p, release, value, 'capacityEvidence',
                                          lambda record: record.update({field: invalid}))
                    with self.assertRaises(p.ProductionError):
                        p.review_release(release)

    def test_page_and_isolation_references_cannot_be_truthy_placeholders(self):
        for isolation in (False, True):
            for invalid in (True, {'passed': True}, '   ', [''], ['TODO'], ['PENDING'], [True]):
                with self.subTest(isolation=isolation, invalid=invalid):
                    p, release, value = self.release_fixture()
                    def change(record):
                        item = record['isolationChecks'][0] if isolation else record['items'][0]['browser']
                        item['evidence'] = invalid
                    self.changed_evidence(p, release, value, 'pageAcceptance', change)
                    with self.assertRaises(p.ProductionError):
                        p.review_release(release)

    def test_latency_and_recovery_measurements_require_finite_nonboolean_numbers(self):
        for field, measured in (('capacityEvidence', 'p95Seconds'),
                                ('recoveryEvidence', 'rtoSeconds'), ('recoveryEvidence', 'rpoSeconds')):
            for measurement in (0.5, float('inf'), float('nan'), True, '1', None):
                with self.subTest(field=field, measured=measured, measurement=measurement):
                    p, release, value = self.release_fixture()
                    self.changed_evidence(p, release, value, field,
                                          lambda record: record.update({measured: measurement}))
                    if measurement == 0.5:
                        self.assertEqual('MANIFEST_VALIDATED', p.review_release(release)['status'])
                    else:
                        with self.assertRaises(p.ProductionError):
                            p.review_release(release)

    def test_page_operator_and_country_are_real_typed_identities(self):
        for field, invalids in (('operator', (True, ' ', 'TODO')),
                                ('country', (True, 0, -1, {}, ' '))):
            for invalid in invalids:
                with self.subTest(field=field, invalid=invalid):
                    p, release, value = self.release_fixture()
                    self.changed_evidence(p, release, value, 'pageAcceptance',
                                          lambda record: record['items'][0]['browser'].update({field: invalid}))
                    with self.assertRaises(p.ProductionError):
                        p.review_release(release)

    def test_explicit_reviewed_local_backup_reports_only_the_accepted_fault_domain_deferral(self):
        p, release, value = self.local_backup_fixture()
        before = {str(path): path.read_bytes() for path in release.parent.rglob('*') if path.is_file()}
        try:
            result = p.review_release(release)
        except p.ProductionError as error:
            self.fail('Explicit reviewed local-backup policy was blocked: ' + str(error))
        self.assertEqual('MANIFEST_VALIDATED', result['status'])
        self.assertFalse(result['productionReleased'])
        self.assertFalse(result['offHostDurabilityVerified'])
        self.assertEqual(['OFF_HOST_BACKUP_DURABILITY'], [item['kind'] for item in result['acceptedDeferrals']])
        self.assertEqual('human-reviewer', result['acceptedDeferrals'][0]['reviewedBy'])
        self.assertEqual(value['backupPolicy']['decisionEvidence']['sha256'],
                         result['acceptedDeferrals'][0]['decisionEvidenceSha256'])
        self.assertEqual(before, {str(path): path.read_bytes() for path in release.parent.rglob('*') if path.is_file()})

    def test_local_backup_cannot_be_enabled_by_a_boolean_or_without_a_pinned_human_decision(self):
        for policy in (None, True, 'LOCAL_ONLY_TEMPORARY', {'mode': 'LOCAL_ONLY_TEMPORARY'},
                       {'mode': 'LOCAL_ONLY_TEMPORARY', 'reviewedBy': 'TODO', 'decisionEvidence': True}):
            with self.subTest(policy=policy):
                p, release, value = self.local_backup_fixture()
                if policy is None:
                    value.pop('backupPolicy')
                else:
                    value['backupPolicy'] = policy
                release.write_text(json.dumps(value))
                with self.assertRaises(p.ProductionError):
                    p.review_release(release)

    def test_local_backup_decision_is_pinned_specific_and_bound_to_this_host_and_path(self):
        for field, invalid in (('reviewedBy', ' '), ('decisionReference', 'TODO'), ('reason', 'PENDING'),
                               ('targetHost', 'other-host'), ('backupLocation', '/other/backup')):
            with self.subTest(field=field):
                p, release, value = self.local_backup_fixture()
                item = value['backupPolicy']['decisionEvidence']
                path = release.parent / item['path']
                record = json.loads(path.read_text())
                record[field] = invalid
                path.write_text(json.dumps(record))
                item['sha256'] = p.recovery.hash_file(path)
                release.write_text(json.dumps(value))
                with self.assertRaises(p.ProductionError):
                    p.review_release(release)

    def test_local_backup_requires_an_absolute_local_path_and_honest_recovery_scope(self):
        for field, invalid in (('backupLocation', 'relative/backup'), ('backupLocation', '/'),
                               ('recoveryScope', 'SOURCE_HOST_LOST'), ('physicalOffsiteDurabilityVerified', True)):
            with self.subTest(field=field, invalid=invalid):
                p, release, value = self.local_backup_fixture()
                if field == 'backupLocation':
                    value[field] = invalid
                    release.write_text(json.dumps(value))
                else:
                    self.changed_evidence(p, release, value, 'recoveryEvidence',
                                          lambda record: record.update({field: invalid}))
                with self.assertRaises(p.ProductionError):
                    p.review_release(release)

    def test_local_backup_requires_the_sealed_bytes_and_successful_unseal_and_restore_receipts(self):
        for field in ('sealedBackup', 'unsealReceipt', 'restoreReceipt', 'unsealedBundle'):
            with self.subTest(field=field):
                p, release, value = self.local_backup_fixture()
                self.changed_evidence(p, release, value, 'recoveryEvidence',
                                      lambda record: record['localBackupEvidence'].pop(field))
                with self.assertRaises(p.ProductionError):
                    p.review_release(release)
        for field, key, invalid in (('unsealReceipt', 'status', 'PENDING'),
                                     ('unsealReceipt', 'sha256', 'a' * 64),
                                     ('restoreReceipt', 'status', 'BACKED_UP'),
                                     ('restoreReceipt', 'verification', {'allTableDigestsMatch': False})):
            with self.subTest(field=field, key=key):
                p, release, value = self.local_backup_fixture()
                recovered = json.loads((release.parent / value['recoveryEvidence']['path']).read_text())
                item = recovered['localBackupEvidence'][field]
                path = release.parent / item['path']
                record = json.loads(path.read_text())
                record[key] = invalid
                path.write_text(json.dumps(record))
                item['sha256'] = p.recovery.hash_file(path)
                self.save_evidence(p, release.parent, value, 'recoveryEvidence', recovered)
                release.write_text(json.dumps(value))
                with self.assertRaises(p.ProductionError):
                    p.review_release(release)

    def test_local_backup_cannot_mix_restore_or_unseal_receipts_from_another_bundle(self):
        for field, key, invalid in (('restoreReceipt', 'manifestSha256', 'f' * 64),
                                    ('restoreReceipt', 'batchId', 'de68df96-b030-49e1-b72e-d9694aa20e35'),
                                    ('unsealReceipt', 'manifestSha256', 'f' * 64),
                                    ('unsealReceipt', 'batchId', 'de68df96-b030-49e1-b72e-d9694aa20e35'),
                                    ('unsealReceipt', 'source', {'container': 'other-db', 'database': 'other_db'}),
                                    ('unsealReceipt', 'bundlePath', '/other/unsealed')):
            with self.subTest(field=field, key=key):
                p, release, value = self.local_backup_fixture()
                recovered = json.loads((release.parent / value['recoveryEvidence']['path']).read_text())
                item = recovered['localBackupEvidence'][field]
                path = release.parent / item['path']
                record = json.loads(path.read_text())
                record[key] = invalid
                path.write_text(json.dumps(record))
                item['sha256'] = p.recovery.hash_file(path)
                self.save_evidence(p, release.parent, value, 'recoveryEvidence', recovered)
                release.write_text(json.dumps(value))
                with self.assertRaises(p.ProductionError):
                    p.review_release(release)

    def test_plaintext_cannot_be_relabelled_as_the_selected_encrypted_backup(self):
        p, release, value = self.local_backup_fixture()
        recovered = json.loads((release.parent / value['recoveryEvidence']['path']).read_text())
        local = recovered['localBackupEvidence']
        archive = Path(local['sealedBackup']['path'])
        archive.write_bytes(b'This is plaintext, not a CMS envelope')
        local['sealedBackup']['sha256'] = p.recovery.hash_file(archive)
        path = release.parent / local['unsealReceipt']['path']
        receipt = json.loads(path.read_text())
        receipt['sha256'] = local['sealedBackup']['sha256']
        path.write_text(json.dumps(receipt))
        local['unsealReceipt']['sha256'] = p.recovery.hash_file(path)
        self.save_evidence(p, release.parent, value, 'recoveryEvidence', recovered)
        release.write_text(json.dumps(value))
        with self.assertRaises(p.ProductionError):
            p.review_release(release)

    def test_local_fault_domain_deferral_does_not_waive_keys_permissions_capacity_or_openings(self):
        for pending in ('keys', 'permissions', 'capacity', 'opening', 'recipientKey', 'sourceSecrets'):
            with self.subTest(pending=pending):
                p, release, value = self.local_backup_fixture()
                if pending == 'keys':
                    self.changed_evidence(p, release, value, 'keyCustodyEvidence',
                                          lambda record: record.update(independentCustodian=None))
                elif pending == 'permissions':
                    self.changed_evidence(p, release, value, 'permissionReview',
                                          lambda record: record['items'][0].update(status='UNCONFIRMED'))
                elif pending == 'capacity':
                    value['concurrentUsers'] = 100
                    release.write_text(json.dumps(value))
                elif pending == 'opening':
                    item = value['initializationManifest']
                    path = release.parent / item['path']
                    record = json.loads(path.read_text())
                    record['confirmations']['openingStatus'] = 'UNKNOWN'
                    path.write_text(json.dumps(record))
                    item['sha256'] = p.recovery.hash_file(path)
                    release.write_text(json.dumps(value))
                else:
                    field = 'independentRecipientKeyUsed' if pending == 'recipientKey' else 'sourceSecretsDirectoryRemoved'
                    self.changed_evidence(p, release, value, 'recoveryEvidence',
                                          lambda record: record.update({field: False}))
                with self.assertRaises(ValueError):
                    p.review_release(release)

    def test_each_permission_and_opening_review_requires_real_person_and_evidence_values(self):
        for field in ('reviewedBy', 'evidence'):
            for invalid in (True, ' ', 'TODO'):
                with self.subTest(field=field, invalid=invalid):
                    p, release, value = self.release_fixture()
                    self.changed_evidence(p, release, value, 'permissionReview',
                                          lambda record: record['items'][-1].update({field: invalid}))
                    with self.assertRaises(p.ProductionError):
                        p.review_release(release)
        p, release, value = self.release_fixture()
        self.changed_evidence(p, release, value, 'permissionReview', lambda record: record['items'].append(None))
        with self.assertRaises(p.ProductionError):
            p.review_release(release)

    def test_unknown_matching_custodians_or_other_production_owners_are_not_confirmation(self):
        fields = ('reviewedBy', 'targetHost', 'domain', 'backupLocation', 'backupCustodian',
                  'configurationOwner', 'maintenanceWindow')
        for field in fields:
            with self.subTest(field=field):
                p, release, value = self.release_fixture()
                value[field] = 'UNKNOWN'
                if field == 'backupCustodian':
                    self.changed_evidence(p, release, value, 'keyCustodyEvidence',
                                          lambda record: record.update(independentCustodian='UNKNOWN'))
                release.write_text(json.dumps(value))
                with self.assertRaises(p.ProductionError):
                    p.review_release(release)
