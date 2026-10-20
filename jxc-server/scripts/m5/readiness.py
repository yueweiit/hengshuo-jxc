#!/usr/bin/env python3
"""Read-only manifest review. Never imports data, grants approval or connects to a DB."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys


class ReadinessError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise ReadinessError(code)


def text(value):
    return isinstance(value, str) and bool(value.strip()) and value == value.strip()


def object_keys(value, required, optional=()):
    require(isinstance(value, dict), "OBJECT_REQUIRED")
    require(set(required) <= value.keys() <= set(required) | set(optional), "MANIFEST_FIELDS_INVALID")


def safe_id(value):
    require(type(value) is int and 0 < value <= 9007199254740991, "POSITIVE_SAFE_ID_REQUIRED")


def sha(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value), "SHA256_REQUIRED")


def digest_file(path):
    require(path.is_file() and not path.is_symlink(), "REGULAR_SOURCE_FILE_REQUIRED")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def load_manifest(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 8 * 1024 * 1024,
            "REGULAR_MANIFEST_FILE_REQUIRED")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    except (UnicodeError, json.JSONDecodeError):
        raise ReadinessError("MANIFEST_JSON_INVALID") from None
    object_keys(manifest, ("schemaVersion", "batchId", "sourceSystem", "mode", "dataOrigin",
                           "files", "records", "confirmations"), ("historicalScope",))
    require(type(manifest["schemaVersion"]) is int and manifest["schemaVersion"] == 1,
            "SCHEMA_VERSION_UNSUPPORTED")
    for field in ("batchId", "sourceSystem"):
        require(text(manifest[field]) and len(manifest[field]) <= 128, "BATCH_AND_SOURCE_REQUIRED")
    mode = manifest["mode"]
    require(mode in ("FIRST_START", "HISTORY_REHEARSAL"), "MODE_INVALID")
    if mode == "FIRST_START":
        require(manifest["dataOrigin"] == "PRODUCTION_CONFIRMED",
                "FIRST_START_REQUIRES_CONFIRMED_PRODUCTION")
        require(not re.search(r"(?:^|[\W_])(?:demo|mock|synthetic)(?:$|[\W_])",
                              manifest["sourceSystem"], re.IGNORECASE), "DEMO_SOURCE_FORBIDDEN")
        require("historicalScope" not in manifest, "FIRST_START_HAS_HISTORICAL_SCOPE")
    else:
        require(manifest["dataOrigin"] in ("PRODUCTION_CONFIRMED", "SYNTHETIC"), "DATA_ORIGIN_INVALID")
        scope = manifest.get("historicalScope")
        require(isinstance(scope, dict) and text(scope.get("description")) and text(scope.get("reviewedBy")),
                "HISTORICAL_SCOPE_REQUIRED")
        object_keys(scope, ("description", "reviewedBy"))

    confirmation = manifest["confirmations"]
    require(isinstance(confirmation, dict), "CONFIRMATION_REQUIRED")
    for field in ("configurationReviewed", "openingReviewed", "demoExcluded"):
        require(confirmation.get(field) is True, "CONFIRMATION_REQUIRED: " + field)
    require(confirmation.get("openingStatus") in ("CONFIRMED", "NOT_APPLICABLE"),
            "OPENING_CONFIRMATION_REQUIRED")
    for field in ("reviewedBy", "configurationEvidence", "openingEvidence"):
        require(text(confirmation.get(field)), "REVIEW_EVIDENCE_REQUIRED: " + field)
    object_keys(confirmation, ("configurationReviewed", "openingReviewed", "demoExcluded", "openingStatus",
                              "reviewedBy", "configurationEvidence", "openingEvidence"))

    require(isinstance(manifest["files"], list) and manifest["files"], "SOURCE_FILES_REQUIRED")
    hashes, paths = set(), set()
    for entry in manifest["files"]:
        object_keys(entry, ("path", "sha256"))
        require(text(entry["path"]), "SOURCE_PATH_REQUIRED")
        sha(entry["sha256"])
        source = path.parent / entry["path"]
        identity = str(source.resolve())
        require(identity not in paths, "DUPLICATE_SOURCE_FILE")
        require(digest_file(source) == entry["sha256"], "SOURCE_HASH_MISMATCH")
        paths.add(identity)
        hashes.add(entry["sha256"])

    require(isinstance(manifest["records"], list), "RECORDS_REQUIRED")
    identities = set()
    for record in manifest["records"]:
        object_keys(record, ("sourceSystem", "sourceId", "kind", "targetCountryId", "targetBookId",
                             "targetId", "sourceFileSha256"))
        require(record["sourceSystem"] == manifest["sourceSystem"] and text(record["sourceId"]),
                "RECORD_SOURCE_REQUIRED")
        require(isinstance(record["kind"], str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", record["kind"]),
                "RECORD_KIND_INVALID")
        if mode == "FIRST_START":
            require(record["kind"] in ("FOUNDATION", "OPENING"), "FIRST_START_HISTORY_FORBIDDEN")
            require(not (record["kind"] == "OPENING" and confirmation["openingStatus"] == "NOT_APPLICABLE"),
                    "OPENING_STATUS_CONFLICT")
        for field in ("targetCountryId", "targetBookId", "targetId"):
            safe_id(record[field])
        sha(record["sourceFileSha256"])
        require(record["sourceFileSha256"] in hashes, "UNDECLARED_SOURCE_HASH")
        identity = (record["sourceSystem"], record["sourceId"], record["kind"])
        require(identity not in identities, "DUPLICATE_SOURCE")
        identities.add(identity)
    fingerprint = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":"),
                                           ensure_ascii=False).encode("utf-8")).hexdigest()
    return manifest, fingerprint, identities


def verify_manifest(path, previous=()):
    manifest, fingerprint, sources = load_manifest(path)
    repeated = set()
    # Every supplied prior manifest is checked, including its retained source bytes.
    # Offline files are evidence inputs, not an authoritative database batch ledger.
    batches, prior_sources = {}, {}
    for old_path in previous:
        old, old_hash, old_sources = load_manifest(old_path)
        batch = old["batchId"]
        require(batch not in batches or batches[batch] == old_hash, "BATCH_CONTENT_CONFLICT")
        for identity in old_sources:
            require(identity not in prior_sources or prior_sources[identity] == batch,
                    "SOURCE_ALREADY_IN_OTHER_BATCH")
            prior_sources[identity] = batch
        batches[batch] = old_hash
    batch = manifest["batchId"]
    if batch in batches:
        require(batches[batch] == fingerprint, "BATCH_CONTENT_CONFLICT")
        repeated.add(batch)
    for identity in sources:
        require(identity not in prior_sources or prior_sources[identity] == batch,
                "SOURCE_ALREADY_IN_OTHER_BATCH")
    return {"schemaVersion": 1, "status": "READY_FOR_REVIEW", "batchId": batch,
            "sourceSystem": manifest["sourceSystem"], "mode": manifest["mode"],
            "manifestSha256": fingerprint, "fileCount": len(manifest["files"]),
            "recordCount": len(sources), "repeatedBatchIds": sorted(repeated),
            "previousManifestCount": len(batches), "businessDataImported": False,
            "productionApproved": False, "sourceDataAuthenticityVerified": False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--previous", type=Path, action="append", default=[],
                        help="Retained prior manifest; repeat for the full reviewed evidence set")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(verify_manifest(args.manifest, args.previous), ensure_ascii=False, indent=2))
        return 0
    except (OSError, ReadinessError) as error:
        code = str(error) if isinstance(error, ReadinessError) else "EVIDENCE_FILE_UNREADABLE"
        print(json.dumps({"schemaVersion": 1, "status": "BLOCKED", "code": code,
                          "businessDataImported": False, "productionApproved": False}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
