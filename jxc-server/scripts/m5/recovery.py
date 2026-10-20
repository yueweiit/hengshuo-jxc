#!/usr/bin/env python3
"""Offline M5 rehearsal: frozen PG16 snapshot + hash-verified private S3 objects.

No business rows are invented, no source writes occur, and restore never cleans a
partially populated target. Operator secrets and backup bundles live outside Git.
"""
import argparse
import datetime as dt
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
import importlib.util

_profile_spec=importlib.util.spec_from_file_location("jxc_m5_schema_profiles",Path(__file__).resolve().with_name("schema_profiles.py"))
_profiles=importlib.util.module_from_spec(_profile_spec)
_profile_spec.loader.exec_module(_profiles)
_catalog_spec=importlib.util.spec_from_file_location("jxc_m5_catalog_contract",Path(__file__).resolve().with_name("catalog_contract.py"))
_catalog=importlib.util.module_from_spec(_catalog_spec)
_catalog_spec.loader.exec_module(_catalog)


class RecoveryError(RuntimeError):
    pass


HEX = re.compile(r"[0-9a-f]{64}\Z")
IDENT = re.compile(r"[a-z_][a-z0-9_]{0,62}\Z")
CONTAINER = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\Z")
WORKSPACE = Path(__file__).resolve().parents[3]


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def private(path, directory=False):
    path = Path(path)
    if path.is_symlink():
        raise RecoveryError("symlink is forbidden")
    try:
        info = path.stat()
    except FileNotFoundError:
        raise RecoveryError("required private payload is missing") from None
    expected = 0o700 if directory else 0o600
    kind_ok = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not kind_ok or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != expected:
        raise RecoveryError(f"operator-owned {'0700 directory' if directory else '0600 regular file'} required")
    return path


def outside_workspace(path):
    path = Path(path).absolute()
    if path.is_relative_to(WORKSPACE) or path.resolve().is_relative_to(WORKSPACE):
        raise RecoveryError("secrets, backups and receipts must be outside repository")
    return path


def read_json(path):
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise RecoveryError("duplicate JSON key")
            result[key] = value
        return result
    try:
        return json.loads(private(path).read_bytes(), object_pairs_hook=unique_pairs)
    except (ValueError, UnicodeError):
        raise RecoveryError("invalid JSON") from None


def write_private(path, data):
    path = Path(path)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())


def safe_path(value):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value or any(part in ("", ".", "..") for part in value.split("/")) or value.startswith("/"):
        raise RecoveryError("unsafe manifest path")
    return value


def hash_file(path):
    result = hashlib.sha256()
    with private(path).open("rb") as input_file:
        for block in iter(lambda: input_file.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def verify_bundle(bundle, expected_manifest_hash):
    bundle = private(bundle, directory=True)
    if not isinstance(expected_manifest_hash, str) or not HEX.fullmatch(expected_manifest_hash) or hash_file(bundle / "manifest.json") != expected_manifest_hash:
        raise RecoveryError("manifest hash does not match external pin")
    manifest = read_json(bundle / "manifest.json")
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("files"), dict) or not isinstance(manifest.get("attachments"), list):
        raise RecoveryError("unsupported manifest schema")
    validate_batch(manifest.get("batchId"))
    required = {"database.dump", "snapshot.json", "freeze-proof.json"}
    if not required.issubset(manifest["files"]):
        raise RecoveryError("required backup payload missing from manifest")
    allowed = set(manifest["files"]) | {"manifest.json"}
    for relative, metadata in manifest["files"].items():
        safe_path(relative)
        if relative not in required and not re.fullmatch(r"objects/[0-9a-f]{64}\.bin", relative):
            raise RecoveryError("unexpected manifest payload")
        path = bundle / relative
        for parent in path.parents:
            if parent == bundle.parent:
                break
            if parent.is_symlink():
                raise RecoveryError("symlink is forbidden")
        if not isinstance(metadata, dict) or type(metadata.get("size")) is not int or metadata["size"] < 0 or not HEX.fullmatch(str(metadata.get("sha256", ""))):
            raise RecoveryError("invalid payload hash metadata")
        if private(path).stat().st_size != metadata["size"] or hash_file(path) != metadata["sha256"]:
            raise RecoveryError("payload hash or size mismatch")
    for path in bundle.rglob("*"):
        if path.is_symlink():
            raise RecoveryError("symlink is forbidden")
        if path.is_dir():
            private(path, directory=True)
        elif path.relative_to(bundle).as_posix() not in allowed:
            raise RecoveryError("unlisted file in bundle")
    keys = set()
    ids = set()
    referenced_files = set(required)
    for item in manifest["attachments"]:
        key = safe_path(item.get("storageKey"))
        if key in keys or item.get("id") in ids or type(item.get("id")) is not int or item["id"] <= 0:
            raise RecoveryError("duplicate or invalid attachment identity")
        keys.add(key)
        ids.add(item["id"])
        digest = item.get("sha256")
        relative = item.get("file")
        if not isinstance(digest, str) or not HEX.fullmatch(digest) or relative != f"objects/{digest}.bin" or relative not in manifest["files"]:
            raise RecoveryError("attachment reference hash mismatch")
        if {"size": item.get("size"), "sha256": digest} != manifest["files"][relative] or type(item.get("size")) is not int or item["size"] <= 0:
            raise RecoveryError("attachment reference size mismatch")
        referenced_files.add(relative)
    if referenced_files != set(manifest["files"]):
        raise RecoveryError("unreferenced object payload")
    return manifest


def validate_batch(batch):
    try:
        if str(uuid.UUID(batch)) != batch:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise RecoveryError("batchId must be a canonical UUID") from None


def validate_database(config):
    for name in ("database", "adminUser", "ownerRole", "runtimeRole"):
        if not IDENT.fullmatch(str(config.get(name, ""))):
            raise RecoveryError("invalid PostgreSQL database/role identifier")
    if not CONTAINER.fullmatch(str(config.get("container", ""))):
        raise RecoveryError("invalid container identifier")
    if len({config["adminUser"], config["ownerRole"], config["runtimeRole"]}) != 3:
        raise RecoveryError("admin, owner and runtime roles must be distinct")
    storage = config.get("storage", {})
    endpoint = urllib.parse.urlsplit(storage.get("endpoint", ""))
    if endpoint.scheme not in ("http", "https") or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.path not in ("", "/") or endpoint.query or endpoint.fragment:
        raise RecoveryError("explicit S3 endpoint without credentials/path required")
    if endpoint.scheme == "http" and endpoint.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise RecoveryError("unencrypted S3 endpoint must be loopback for rehearsal")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", str(storage.get("bucket", ""))) or not storage.get("accessKey") or not storage.get("secretKey"):
        raise RecoveryError("explicit private S3 bucket/credentials required")


def validate_target(target, expected):
    validate_database(target)
    if expected != target["container"] + "/" + target["database"]:
        raise RecoveryError("exact target confirmation mismatch")
    if not target["container"].startswith("hengshuo-m5-") or not re.fullmatch(r"jxc_m5_[a-z0-9_]+", target["database"]) or not target["storage"]["bucket"].startswith("jxc-m5-"):
        raise RecoveryError("restore requires isolated M5 container/database/bucket")


def validate_freeze(proof, source, batch, live):
    if proof.get("schemaVersion") != 1 or proof.get("source") != {name: source[name] for name in ("container", "database")} or proof.get("mode") != "FROZEN" or proof.get("batchId") != batch or type(proof.get("epoch")) is not int or proof["epoch"] < 1:
        raise RecoveryError("freeze proof does not identify the exact frozen source")
    if live != {"database": source["database"], "mode": "FROZEN", "batchId": batch, "epoch": proof["epoch"]}:
        raise RecoveryError("live freeze mode/batch/epoch does not match proof")


def safe_error(error, config):
    message = str(error)
    def redact(value):
        nonlocal message
        if isinstance(value, dict):
            for name, item in value.items():
                if any(token in name.lower() for token in ("secret", "password", "accesskey")) and isinstance(item, str) and item:
                    message = message.replace(item, "[redacted]")
                else:
                    redact(item)
        elif isinstance(value, list):
            for item in value:
                redact(item)
    redact(config)
    return message


def command(target, program, *arguments, interactive=False):
    return ["docker", "exec"] + (["-i"] if interactive else []) + [target["container"], program, "-U", target["adminUser"], "-d", target["database"], *arguments]


def restore_command(target):
    return command(target, "pg_restore", "--exit-on-error", "--single-transaction", interactive=True)


class PgSession:
    """One held database transaction; no shell and no secrets in argv."""
    def __init__(self, config):
        self.process = subprocess.Popen(command(config, "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", interactive=True), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)

    def lines(self, sql):
        marker = "M5_END_" + uuid.uuid4().hex
        self.process.stdin.write(sql.rstrip("; \n") + ";\n\\echo " + marker + "\n")
        self.process.stdin.flush()
        while True:
            line = self.process.stdout.readline()
            if not line:
                self.process.wait(timeout=20)
                raise RecoveryError("PostgreSQL command failed: " + self.process.stderr.read()[:3000])
            if line.rstrip("\n") == marker:
                return
            yield line

    def execute(self, sql):
        return "".join(self.lines(sql)).strip()

    def json(self, sql):
        output = self.execute(sql)
        return json.loads(output) if output else None

    def close(self):
        try:
            if self.process.poll() is None:
                self.process.stdin.write("ROLLBACK;\n\\q\n")
                self.process.stdin.flush()
                self.process.communicate(timeout=20)
        except (BrokenPipeError, subprocess.TimeoutExpired):
            self.process.kill()
            self.process.communicate()
        finally:
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                stream.close()

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        self.close()


def sql_literal(value):
    return "'" + value.replace("'", "''") + "'"


def quoted(value):
    return '"' + value.replace('"', '""') + '"'


def freeze_state(session, lock=False):
    return session.json("SELECT json_build_object('database',current_database(),'mode',mode,'batchId',batch_id::text,'epoch',epoch) FROM public.sys_write_control WHERE singleton=true" + (" FOR SHARE" if lock else ""))


def lock_restored_gate(session, target, batch, epoch):
    # Advisory locking coordinates restore workers only. The row SHARE lock also
    # blocks write_gate.resume and stays held through object I/O and receipt fsync.
    session.execute("BEGIN")
    live = freeze_state(session, lock=True)
    expected = {"database": target["database"], "mode": "FROZEN", "batchId": batch, "epoch": epoch}
    if live != expected:
        raise RecoveryError("restored target is not the expected FROZEN batch")
    return live


def role_audit(session, config):
    database = session.json("SELECT json_build_object('database',current_database(),'version',current_setting('server_version_num')::int,'admin',current_user,'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),'databaseOwner',pg_get_userbyid(datdba)) FROM pg_database WHERE datname=current_database()")
    if database["database"] != config["database"] or database["admin"] != config["adminUser"] or not database["superuser"] or not 160000 <= database["version"] < 170000 or database["databaseOwner"] == config["runtimeRole"]:
        raise RecoveryError("database identity/PG16/admin ownership audit failed")
    roles = session.json("SELECT coalesce(json_agg(json_build_object('name',rolname,'superuser',rolsuper,'bypassRls',rolbypassrls,'createRole',rolcreaterole,'createDb',rolcreatedb,'replication',rolreplication,'login',rolcanlogin) ORDER BY rolname),'[]') FROM pg_roles WHERE rolname IN (" + sql_literal(config["ownerRole"]) + "," + sql_literal(config["runtimeRole"]) + ")")
    if len(roles) != 2 or any(item["superuser"] or item["bypassRls"] or item["createRole"] or item["createDb"] or item["replication"] or not item["login"] for item in roles):
        raise RecoveryError("owner/runtime role attributes unsafe")
    runtime = sql_literal(config["runtimeRole"])
    owner = sql_literal(config["ownerRole"])
    unsafe = session.json("SELECT json_build_object('memberOwner',pg_has_role(" + runtime + "," + owner + ",'MEMBER'),'elevatedMembership',EXISTS(SELECT 1 FROM pg_roles WHERE pg_has_role(" + runtime + ",oid,'MEMBER') AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)),'databaseCreate',has_database_privilege(" + runtime + ",current_database(),'CREATE'),'schemaCreate',EXISTS(SELECT 1 FROM pg_namespace WHERE left(nspname,8)<>'pg_temp_' AND has_schema_privilege(" + runtime + ",oid,'CREATE')),'ownsRelation',EXISTS(SELECT 1 FROM pg_class WHERE pg_has_role(" + runtime + ",relowner,'MEMBER') AND relnamespace IN (SELECT oid FROM pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')))")
    if any(unsafe.values()):
        raise RecoveryError("runtime role has unsafe ownership/membership/CREATE privilege")
    return {"database": database, "roles": roles, "runtimeUnsafePrivileges": unsafe}


def assert_empty(session):
    found = session.json("SELECT json_build_object('relations',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'),'functions',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'),'types',(SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'),'extraSchemas',(SELECT count(*) FROM pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname NOT IN ('public','information_schema')),'extensions',(SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql'),'sessions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()))")
    if any(found.values()):
        raise RecoveryError("restore target is not an empty isolated database")


# Keep the public recovery helper while sharing the exact narrow PG16 rule.
canonical_constraint = _catalog.canonical_constraint


def normalize_schema(schema):
    result = json.loads(json.dumps(schema))
    for relation in result["relations"]:
        relation["acl"] = relation.pop("effective_acl")
    for constraint in result["constraints"]:
        constraint["definition"] = canonical_constraint(constraint["definition"])
    for column in result.get('columns',[]):
        if column.get('default_expression') is not None:
            column['default_expression']=canonical_constraint(column['default_expression'])
    return result


def inventory(session):
    extra_schemas = session.json("SELECT coalesce(json_agg(nspname),'[]') FROM pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname NOT IN ('public','information_schema')")
    if extra_schemas:
        raise RecoveryError("unsupported non-public schema; cannot claim complete JXC inventory")
    invalid_indexes = session.json("SELECT coalesce(json_agg(c.relname),'[]') FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT(i.indisvalid AND i.indisready AND i.indislive)")
    if invalid_indexes:
        raise RecoveryError("invalid/not-ready PostgreSQL index")
    tables = session.json("SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]') FROM pg_tables WHERE schemaname='public'")
    result = {"inventoryVersion": 2, "tables": {}}
    for table in tables:
        count = 0
        digest = hashlib.sha256()
        for line in session.lines("COPY (SELECT to_jsonb(t)::text FROM public." + quoted(table) + " t ORDER BY to_jsonb(t)::text COLLATE \"C\") TO STDOUT"):
            count += 1
            digest.update(line.encode("utf-8"))
        result["tables"][table] = {"rows": count, "sha256": digest.hexdigest()}
    result["schema"] = session.json("""SELECT json_build_object(
      'relations',(SELECT coalesce(json_agg(x ORDER BY x.name),'[]') FROM (SELECT c.relname AS name,c.relkind AS kind,pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,c.relacl::text AS acl,(SELECT coalesce(json_agg(json_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable),'[]') FROM aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::\"char\" ELSE 'r'::\"char\" END,c.relowner))) a) AS effective_acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') x),
      'columns',(SELECT coalesce(json_agg(x ORDER BY x.table_name,x.position),'[]') FROM (SELECT c.relname AS table_name,a.attnum AS position,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,a.attidentity AS identity,a.attgenerated AS generated,pg_get_expr(d.adbin,d.adrelid) AS default_expression,(SELECT coalesce(json_agg(json_build_object('grantee',CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END,'grantor',pg_get_userbyid(ac.grantor),'privilege',ac.privilege_type,'grantable',ac.is_grantable) ORDER BY CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END,pg_get_userbyid(ac.grantor),ac.privilege_type,ac.is_grantable),'[]') FROM aclexplode(CASE WHEN cardinality(a.attacl)>0 THEN a.attacl ELSE NULL::aclitem[] END) ac) AS acl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped) x),
      'constraints',(SELECT coalesce(json_agg(x ORDER BY x.table_name,x.name),'[]') FROM (SELECT coalesce(c.relname,t.typname) AS table_name,p.conname AS name,p.contype AS type,p.convalidated AS validated,pg_get_constraintdef(p.oid,true) AS definition FROM pg_constraint p LEFT JOIN pg_class c ON c.oid=p.conrelid LEFT JOIN pg_type t ON t.oid=p.contypid JOIN pg_namespace n ON n.oid=p.connamespace WHERE n.nspname='public') x),
      'triggers',(SELECT coalesce(json_agg(x ORDER BY x.table_name,x.name),'[]') FROM (SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled AS enabled,pg_get_triggerdef(t.oid,true) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal) x),
      'policies',(SELECT coalesce(json_agg(x ORDER BY x.tablename,x.policyname),'[]') FROM (SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public') x),
      'functions',(SELECT coalesce(json_agg(x ORDER BY x.name,x.arguments),'[]') FROM (SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition,pg_get_userbyid(p.proowner) AS owner,p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') x),
      'indexes',(SELECT coalesce(json_agg(x ORDER BY x.tablename,x.indexname),'[]') FROM (SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public') x),
      'schemas',(SELECT coalesce(json_agg(x ORDER BY x.name),'[]') FROM (SELECT nspname AS name,pg_get_userbyid(nspowner) AS owner,nspacl::text AS acl FROM pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema') x),
      'defaultPrivileges',(SELECT coalesce(json_agg(x ORDER BY x.owner,x.schema_name,x.type),'[]') FROM (SELECT pg_get_userbyid(d.defaclrole) AS owner,coalesce(n.nspname,'') AS schema_name,d.defaclobjtype AS type,d.defaclacl::text AS acl FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace) x),
      'sequenceDefinitions',(SELECT coalesce(json_agg(x ORDER BY x.sequencename),'[]') FROM (SELECT schemaname,sequencename,sequenceowner,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value FROM pg_sequences WHERE schemaname='public') x))""")
    result["schemaRaw"] = result["schema"]
    result["schema"] = normalize_schema(result["schemaRaw"])
    constraints = result["schema"]["constraints"]
    if any(not item["validated"] for item in constraints):
        raise RecoveryError("unvalidated PostgreSQL constraint")
    unsafe_rls = session.json("SELECT coalesce(json_agg(c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='country_id' AND NOT a.attisdropped) AND NOT(c.relrowsecurity AND c.relforcerowsecurity)")
    if unsafe_rls:
        raise RecoveryError("country table does not FORCE RLS")
    if any(item["enabled"] == "D" for item in result["schema"]["triggers"]):
        raise RecoveryError("disabled business trigger")
    result["attachments"] = session.json("SELECT coalesce(json_agg(json_build_object('id',id,'storageKey',storage_key,'sha256',sha256,'size',size,'status',status,'objectStatus',object_status) ORDER BY id),'[]') FROM public.sys_attachment")
    if any(item["objectStatus"] != "AVAILABLE" for item in result["attachments"]):
        raise RecoveryError("attachment metadata references unavailable object")
    return result


class S3:
    """Small path-style SigV4 adapter; secrets stay in process memory."""
    def __init__(self, config):
        self.config = config
        self.endpoint = config["endpoint"].rstrip("/")
        self.bucket = config["bucket"]

    def request(self, method, key="", data=b"", query=None, allow_missing=False, if_absent=False):
        if key:
            safe_path(key)
        path = "/" + urllib.parse.quote(self.bucket, safe="") + ("/" + urllib.parse.quote(key, safe="/~") if key else "")
        query_string = urllib.parse.urlencode(sorted((query or {}).items()), quote_via=urllib.parse.quote, safe="~")
        now = dt.datetime.now(dt.timezone.utc)
        amzdate, datestamp = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
        host = urllib.parse.urlsplit(self.endpoint).netloc
        payload = sha256(data)
        headers = {"host": host, "x-amz-content-sha256": payload, "x-amz-date": amzdate}
        if if_absent:
            headers["if-none-match"] = "*"
        canonical_headers = "".join(name + ":" + value + "\n" for name, value in sorted(headers.items()))
        signed = ";".join(sorted(headers))
        request = "\n".join((method, path, query_string, canonical_headers, signed, payload))
        scope = datestamp + "/us-east-1/s3/aws4_request"
        string = "AWS4-HMAC-SHA256\n" + amzdate + "\n" + scope + "\n" + sha256(request.encode())
        signing = ("AWS4" + self.config["secretKey"]).encode()
        for component in (datestamp, "us-east-1", "s3", "aws4_request"):
            signing = hmac.new(signing, component.encode(), hashlib.sha256).digest()
        signature = hmac.new(signing, string.encode(), hashlib.sha256).hexdigest()
        headers["Authorization"] = "AWS4-HMAC-SHA256 Credential=" + self.config["accessKey"] + "/" + scope + ", SignedHeaders=" + signed + ", Signature=" + signature
        url = self.endpoint + path + ("?" + query_string if query_string else "")
        # No redirects, environment proxies or implicit credentials on private S3.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *unused, **keywords):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(urllib.request.Request(url, data=data if method in ("PUT", "POST") else None, headers=headers, method=method), timeout=30) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code == 404 and allow_missing:
                return None
            raise RecoveryError("S3 request failed with HTTP " + str(error.code)) from None
        except urllib.error.URLError:
            raise RecoveryError("S3 endpoint unavailable") from None

    def empty(self):
        xml = self.request("GET", query={"list-type": "2", "max-keys": "1"})
        root = ET.fromstring(xml)
        return not any(element.tag.rsplit("}", 1)[-1] == "Contents" for element in root.iter())


def load_config(path):
    config = read_json(outside_workspace(path))
    if config.get("schemaVersion") != 1:
        raise RecoveryError("unsupported recovery configuration")
    validate_batch(config.get("batchId"))
    validate_database(config.get("source", {}))
    return config


def supported_schema(session, facts, runtime_role='jxc_app'):
    migrations=session.json("SELECT coalesce(json_agg(json_build_object('version',version,'script',script,'success',success) ORDER BY installed_rank),'[]') FROM public.flyway_schema_history")
    selected=_profiles.select_contract(migrations)
    if selected is None:raise RecoveryError("unsupported migration provenance; refusing unknown schema backup or recovery")
    path,contract=selected
    known=set(contract['table_names'])|set(contract['allowed_additions']['tables'])|{'flyway_schema_history'}
    if set(facts['tables'])-known or set(contract['table_names'])-set(facts['tables']):raise RecoveryError("unsupported table set; refusing incomplete schema inventory")
    if contract.get('exact_columns'):
        columns={}
        for column in facts['schema']['columns']:
            if column['table_name'] in contract['tables']:columns.setdefault(column['table_name'],{})[column['name']]=column['type']
        if columns!=contract['tables']:raise RecoveryError("unsupported column shape in pinned closure schema")
        gaps=session.json("SELECT coalesce(json_agg(x),'[]') FROM ("+_catalog.catalog_gaps_query(contract,runtime_role)+") x")
        if gaps:raise RecoveryError("required closure catalog weakened or missing")
    return {'name':contract['profile'],'contractSha256':sha256(path.read_bytes()),'migrationCount':len(migrations)}


def backup(config, proof_path, output, expected_source):
    source = config["source"]
    if expected_source != source["container"] + "/" + source["database"]:
        raise RecoveryError("exact source confirmation mismatch")
    proof = read_json(outside_workspace(proof_path))
    output = outside_workspace(output)
    if output.exists() or output.is_symlink():
        raise RecoveryError("backup output must not exist")
    output.mkdir(mode=0o700)
    # Incomplete backup has no manifest; verification/restore will refuse it.
    with PgSession(source) as guard, PgSession(source) as snapshot:
        guard.execute("BEGIN")
        live = freeze_state(guard, lock=True)
        validate_freeze(proof, source, config["batchId"], live)
        role_audit(guard, source)
        snapshot.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL timezone='UTC'; SET LOCAL extra_float_digits=3")
        snapshot_id = snapshot.execute("SELECT pg_export_snapshot()")
        validate_freeze(proof, source, config["batchId"], freeze_state(snapshot))
        facts = inventory(snapshot)
        facts["schemaProfile"] = supported_schema(snapshot,facts,source['runtimeRole'])
        facts["roleAudit"] = role_audit(snapshot, source)
        facts["source"] = {key: source[key] for key in ("container", "database", "ownerRole", "runtimeRole")}
        facts["snapshotId"] = snapshot_id
        facts["batchId"] = config["batchId"]
        dump = output / "database.dump"
        descriptor = os.open(dump, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as destination:
            result = subprocess.run(command(source, "pg_dump", "--format=custom", "--snapshot=" + snapshot_id, "--strict-names"), stdout=destination, stderr=subprocess.PIPE, timeout=300)
        if result.returncode:
            raise RecoveryError("pg_dump failed: " + result.stderr.decode(errors="replace")[:3000])
        attachments = []
        store = S3(source["storage"])
        objects = output / "objects"
        objects.mkdir(mode=0o700)
        for item in facts["attachments"]:
            content = store.request("GET", item["storageKey"])
            if len(content) != item["size"] or sha256(content) != item["sha256"]:
                raise RecoveryError("source attachment hash/size mismatch")
            relative = "objects/" + item["sha256"] + ".bin"
            if not (output / relative).exists():
                write_private(output / relative, content)
            attachments.append({key: item[key] for key in ("id", "storageKey", "sha256", "size")} | {"file": relative})
        validate_freeze(proof, source, config["batchId"], freeze_state(guard))
        write_private(output / "snapshot.json", canonical(facts))
        write_private(output / "freeze-proof.json", canonical(proof))
        files = {path.relative_to(output).as_posix(): {"sha256": hash_file(path), "size": path.stat().st_size} for path in output.rglob("*") if path.is_file()}
        manifest = {"schemaVersion": 1, "batchId": config["batchId"], "source": {key: source[key] for key in ("container", "database")}, "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(), "files": files, "attachments": attachments}
        write_private(output / "manifest.json", canonical(manifest))
    pin = hash_file(output / "manifest.json")
    verify_bundle(output, pin)
    return {"status": "BACKED_UP", "batchId": config["batchId"], "manifestSha256": pin, "tableCount": len(facts["tables"]), "attachmentCount": len(attachments), "constraintCount": len(facts["schema"]["constraints"]), "snapshotId": snapshot_id}


def verify_restored(target, bundle, manifest):
    with PgSession(target) as session:
        session.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL timezone='UTC'; SET LOCAL extra_float_digits=3")
        roles = role_audit(session, target)
        current = inventory(session)
        current["schemaProfile"] = supported_schema(session,current,target['runtimeRole'])
        proof = read_json(Path(bundle) / "freeze-proof.json")
        live = freeze_state(session)
        expected_live = {"database": target["database"], "mode": "FROZEN", "batchId": manifest["batchId"], "epoch": proof["epoch"]}
        if live != expected_live:
            raise RecoveryError("restored target is not the expected FROZEN batch")
    expected = read_json(Path(bundle) / "snapshot.json")
    if expected.get("inventoryVersion") != 2:
        raise RecoveryError("legacy inventory lacks column ACL and current catalog safety checks; create new frozen backup")
    for section in ("tables", "schema", "attachments"):
        if current[section] != expected[section]:
            if section == "tables":
                differing = sorted(name for name in set(current[section]) | set(expected[section]) if current[section].get(name) != expected[section].get(name))
                raise RecoveryError("restored table digest mismatch: " + ",".join(differing))
            raise RecoveryError("restored " + section + " mismatch")
    raw_differences = []
    for section, expected_rows in expected["schemaRaw"].items():
        actual_rows = current["schemaRaw"][section]
        if expected_rows != actual_rows:
            for before, after in zip(expected_rows, actual_rows):
                if before != after:
                    raw_differences.append({"section": section, "source": before, "restored": after})
    store = S3(target["storage"])
    for item in manifest["attachments"]:
        content = store.request("GET", item["storageKey"])
        if len(content) != item["size"] or sha256(content) != item["sha256"]:
            raise RecoveryError("restored attachment hash/size mismatch")
    return {"tableCount": len(current["tables"]), "rowCount": sum(item["rows"] for item in current["tables"].values()), "attachmentCount": len(current["attachments"]), "constraintCount": len(current["schema"]["constraints"]), "constraintsValid": True, "schemaMatches": True, "rawSchemaRepresentationDifferences": raw_differences, "allTableDigestsMatch": True, "allAttachmentHashesMatch": True, "frozen": live, "roleAudit": roles}


def restore(config, bundle, pin, expected_target, receipt):
    target = config.get("target", {})
    validate_target(target, expected_target)
    return restore_validated_target(config, bundle, pin, receipt,
                                    lambda session, current: validate_target(current, expected_target))


def restore_validated_target(config, bundle, pin, receipt, target_guard):
    """Shared restore effect. The caller must validate its explicit target before and under this held guard."""
    target = config.get("target", {})
    validate_database(target)
    source = config["source"]
    if (source["container"], source["database"]) == (target["container"], target["database"]) or (source["storage"]["endpoint"].rstrip("/"), source["storage"]["bucket"]) == (target["storage"]["endpoint"].rstrip("/"), target["storage"]["bucket"]):
        raise RecoveryError("restore target must differ from source database and bucket")
    bundle = outside_workspace(bundle)
    manifest = verify_bundle(bundle, pin)
    if manifest["batchId"] != config["batchId"] or manifest["source"] != {name: source[name] for name in ("container", "database")}:
        raise RecoveryError("bundle source/batch does not match configuration")
    receipt = outside_workspace(receipt)
    proof = read_json(bundle / "freeze-proof.json")
    identity = {"batchId": config["batchId"], "manifestSha256": pin, "target": {key: target[key] for key in ("container", "database")}, "storageTarget": {key: target["storage"][key] for key in ("endpoint", "bucket")}}
    with PgSession(target) as guard:
        guard.execute("SELECT pg_advisory_lock(5221061605)")
        target_guard(guard, target)
        role_audit(guard, target)
        if receipt.exists():
            previous = read_json(receipt)
            if any(previous.get(key) != value for key, value in identity.items()) or previous.get("status") != "RESTORED":
                raise RecoveryError("restore receipt does not identify this exact batch/target")
            lock_restored_gate(guard, target, manifest["batchId"], proof["epoch"])
            evidence = verify_restored(target, bundle, manifest)
            return {"status": "VERIFIED_REPLAY", **identity, "verification": evidence}
        assert_empty(guard)
        store = S3(target["storage"])
        if not store.empty():
            raise RecoveryError("restore target S3 bucket is not empty")
        with private(bundle / "database.dump").open("rb") as dump:
            result = subprocess.run(restore_command(target), stdin=dump, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
        if result.returncode:
            raise RecoveryError("pg_restore failed: " + result.stderr.decode(errors="replace")[:3000])
        lock_restored_gate(guard, target, manifest["batchId"], proof["epoch"])
        for item in manifest["attachments"]:
            if store.request("GET", item["storageKey"], allow_missing=True) is not None:
                raise RecoveryError("restore object already exists; refusing overwrite")
            store.request("PUT", item["storageKey"], (bundle / item["file"]).read_bytes(), if_absent=True)
        evidence = verify_restored(target, bundle, manifest)
        result = {"status": "RESTORED", **identity, "verification": evidence}
        write_private(receipt, canonical(result))
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    backup_parser = sub.add_parser("backup")
    backup_parser.add_argument("--config", required=True)
    backup_parser.add_argument("--freeze-proof", required=True)
    backup_parser.add_argument("--output", required=True)
    backup_parser.add_argument("--expect-source", required=True)
    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("--bundle", required=True)
    verify_parser.add_argument("--manifest-sha256", required=True)
    restore_parser = sub.add_parser("restore")
    restore_parser.add_argument("--config", required=True)
    restore_parser.add_argument("--bundle", required=True)
    restore_parser.add_argument("--manifest-sha256", required=True)
    restore_parser.add_argument("--expect-target", required=True)
    restore_parser.add_argument("--receipt", required=True)
    args = parser.parse_args()
    config = {}
    os.umask(0o077)
    try:
        if args.action == "verify":
            manifest = verify_bundle(outside_workspace(args.bundle), args.manifest_sha256)
            result = {"status": "VERIFIED", "batchId": manifest["batchId"], "attachmentCount": len(manifest["attachments"])}
        else:
            config = load_config(args.config)
            if args.action == "backup":
                result = backup(config, args.freeze_proof, args.output, args.expect_source)
            else:
                result = restore(config, args.bundle, args.manifest_sha256, args.expect_target, args.receipt)
        print(json.dumps(result, sort_keys=True, ensure_ascii=False))
    except (RecoveryError, OSError, subprocess.SubprocessError, KeyError, TypeError, ValueError) as error:
        print(json.dumps({"status": "REFUSED", "reason": safe_error(error, config)}, ensure_ascii=False), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
