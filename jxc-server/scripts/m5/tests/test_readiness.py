import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE = Path(__file__).resolve().parents[1] / "readiness.py"
readiness = None
if MODULE.exists():
    spec = importlib.util.spec_from_file_location("m5_readiness", MODULE)
    readiness = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(readiness)


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(readiness, "offline readiness verifier must be implemented")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.source = self.directory / "signed-config.json"
        self.source.write_text('{"approved":true}', encoding="utf-8")
        self.sha = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.manifest = {
            "schemaVersion": 1, "batchId": "FIRST-2026-001", "sourceSystem": "operator-config",
            "mode": "FIRST_START", "dataOrigin": "PRODUCTION_CONFIRMED",
            "files": [{"path": self.source.name, "sha256": self.sha}],
            "records": [{"sourceSystem": "operator-config", "sourceId": "config-001", "kind": "FOUNDATION",
                         "targetCountryId": 101, "targetBookId": 601, "targetId": 101,
                         "sourceFileSha256": self.sha}],
            "confirmations": {"configurationReviewed": True, "openingReviewed": True,
                              "demoExcluded": True, "openingStatus": "CONFIRMED",
                              "reviewedBy": "operator-A", "configurationEvidence": "signed-config-001",
                              "openingEvidence": "signed-opening-001"},
        }

    def save(self, manifest=None, name="manifest.json"):
        path = self.directory / name
        path.write_text(json.dumps(self.manifest if manifest is None else manifest), encoding="utf-8")
        return path

    def reject(self, manifest, code, previous=()):
        with self.assertRaises(readiness.ReadinessError) as caught:
            readiness.verify_manifest(self.save(manifest), previous)
        self.assertIn(code, str(caught.exception))

    def test_first_start_reads_real_evidence_without_importing_or_rewriting(self):
        path = self.save()
        before = {file.name: file.read_bytes() for file in self.directory.iterdir()}
        report = readiness.verify_manifest(path)
        self.assertEqual(report["status"], "READY_FOR_REVIEW")
        self.assertFalse(report["businessDataImported"])
        self.assertFalse(report["productionApproved"])
        self.assertEqual(report["recordCount"], 1)
        self.assertEqual(len(report["manifestSha256"]), 64)
        self.assertEqual(before, {file.name: file.read_bytes() for file in self.directory.iterdir()})

    def test_demo_or_unknown_origin_cannot_be_first_production(self):
        for origin in ("DEMO", "SYNTHETIC", None, "UNKNOWN"):
            with self.subTest(origin=origin):
                manifest = copy.deepcopy(self.manifest)
                manifest["dataOrigin"] = origin
                self.reject(manifest, "FIRST_START_REQUIRES_CONFIRMED_PRODUCTION")

    def test_missing_reviews_and_unknown_opening_are_blocked(self):
        for field in ("configurationReviewed", "openingReviewed", "demoExcluded"):
            with self.subTest(field=field):
                manifest = copy.deepcopy(self.manifest)
                manifest["confirmations"].pop(field)
                self.reject(manifest, "CONFIRMATION_REQUIRED")
        for value in (None, "UNKNOWN", "", 0):
            with self.subTest(openingStatus=value):
                manifest = copy.deepcopy(self.manifest)
                manifest["confirmations"]["openingStatus"] = value
                self.reject(manifest, "OPENING_CONFIRMATION_REQUIRED")

    def test_source_bytes_and_record_hash_must_match_manifest(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["records"][0]["sourceFileSha256"] = "a" * 64
        self.reject(manifest, "UNDECLARED_SOURCE_HASH")
        self.source.write_text("changed after approval", encoding="utf-8")
        self.reject(self.manifest, "SOURCE_HASH_MISMATCH")

    def test_duplicate_sources_and_null_or_zero_target_ids_are_rejected(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["records"].append(copy.deepcopy(manifest["records"][0]))
        self.reject(manifest, "DUPLICATE_SOURCE")
        for value in (None, 0, True, "101"):
            with self.subTest(targetCountryId=value):
                manifest = copy.deepcopy(self.manifest)
                manifest["records"][0]["targetCountryId"] = value
                self.reject(manifest, "POSITIVE_SAFE_ID_REQUIRED")

    def test_history_requires_separately_reviewed_scope_and_is_never_imported(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["mode"] = "HISTORY_REHEARSAL"
        self.reject(manifest, "HISTORICAL_SCOPE_REQUIRED")
        manifest["historicalScope"] = {"description": "Only reviewed October source documents", "reviewedBy": "operator-B"}
        report = readiness.verify_manifest(self.save(manifest))
        self.assertEqual(report["mode"], "HISTORY_REHEARSAL")
        self.assertFalse(report["businessDataImported"])
        manifest["mode"] = "FIRST_START"
        self.reject(manifest, "FIRST_START_HAS_HISTORICAL_SCOPE")

    def test_same_batch_same_content_repeats_but_changed_or_rebatched_source_conflicts(self):
        previous = self.save(name="reviewed-previous.json")
        report = readiness.verify_manifest(self.save(), [previous])
        self.assertEqual(report["repeatedBatchIds"], ["FIRST-2026-001"])
        changed = copy.deepcopy(self.manifest)
        changed["records"][0]["targetId"] = 102
        self.reject(changed, "BATCH_CONTENT_CONFLICT", [previous])
        changed = copy.deepcopy(self.manifest)
        changed["batchId"] = "FIRST-2026-002"
        self.reject(changed, "SOURCE_ALREADY_IN_OTHER_BATCH", [previous])


if __name__ == "__main__":
    unittest.main()
