#!/usr/bin/env python3
"""Read-only M5 PostgreSQL inventory, using the existing migration contract.

No application commands, DDL, imports, repairs, posting or financial calculation.
Exit 0: completed without blockers; 2: findings/unverified checks; 1: execution error.
Connection uses libpq PG* environment/.pgpass, or Docker exec. Never pass a URI or
password as a CLI option. Database diagnostics are withheld to avoid secret leaks.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid
from schema_profiles import select_contract
from catalog_contract import catalog_gaps_query, literal

HERE = Path(__file__).resolve().parent
CONTRACT = HERE / 'audit_contract.json'
CHECK_CODES = ('SCHEMA_CONSTRAINTS', 'DUPLICATE_SOURCE', 'NEGATIVE_BALANCE',
               'OVER_OCCUPATION', 'SCOPE_REFERENCE', 'HISTORICAL_RATE',
               'HISTORICAL_COST', 'EVENT_VOUCHER', 'ATTACHMENT_METADATA',
               'ATTACHMENT_OBJECTS', 'WRITE_GATE')


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def relation(table):
    return 'public.' + identifier(table)


def json_fields(fields, alias='t'):
    return 'jsonb_build_object(' + ','.join(
        literal(c) + ',' + alias + '.' + identifier(c) for c in fields) + ')'


def identity(contract, table, alias='t'):
    columns = contract['tables'][table]
    fields = [c for c in ('id', 'country_id', 'book_id') if c in columns]
    if 'id' not in fields:
        fields.extend(c for c in columns if c.endswith('_id') and c not in fields)
    return json_fields(fields, alias)


def finding(contract, code, table, predicate, observed="'{}'::jsonb", *,
            reason, severity='ERROR', joins='', rule=None):
    return ("SELECT jsonb_build_object('kind','finding','check_code'," + literal(code)
            + ",'table'," + literal(table) + ",'row'," + identity(contract, table)
            + ",'observed'," + observed + ",'reason'," + literal(reason)
            + ",'severity'," + literal(severity) + ",'rule'," + literal(rule or code)
            + ') FROM ' + relation(table) + ' t ' + joins + ' WHERE ' + predicate + ';')


def preflight(contract):
    tables = dict(contract['tables'])
    tables['flyway_schema_history'] = {'version': 'character varying(50)',
                                      'script': 'character varying(1000)', 'success': 'boolean'}
    values = ','.join('(' + ','.join(map(literal, (t, c, ty))) + ')'
                      for t, cols in tables.items() for c, ty in cols.items())
    missing = ("WITH expected(t,c,ty) AS (VALUES " + values + ") SELECT e.t,e.c,e.ty "
               "FROM expected e LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public' "
               "LEFT JOIN pg_catalog.pg_class r ON r.relnamespace=n.oid AND r.relname=e.t "
               "AND r.relkind='r' LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid "
               "AND a.attname=e.c AND a.attnum>0 AND NOT a.attisdropped "
               "WHERE a.attname IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod)<>e.ty")
    if contract.get('exact_columns'):
        missing += (" UNION ALL SELECT r.relname,a.attname,'UNSUPPORTED_COLUMN' FROM pg_catalog.pg_class r JOIN pg_catalog.pg_namespace n ON n.oid=r.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname='public' AND r.relkind='r' AND r.relname<>'flyway_schema_history' AND NOT EXISTS(SELECT 1 FROM expected e WHERE e.t=r.relname AND e.c=a.attname)")
    known_tables = contract['table_names'] + ['flyway_schema_history'] + contract['allowed_additions']['tables']
    table_values = ','.join('(' + literal(t) + ')' for t in contract['table_names'])
    missing += (" UNION ALL SELECT r.relname,'<table>','UNSUPPORTED_TABLE' FROM pg_catalog.pg_class r "
                "WHERE r.relnamespace='public'::regnamespace AND r.relkind IN ('r','p') AND r.relname NOT IN ("
                + ','.join(map(literal, known_tables)) + ") UNION ALL SELECT e.t,'<table>','MISSING_TABLE' "
                "FROM (VALUES " + table_values + ") e(t) WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class r "
                "WHERE r.relnamespace='public'::regnamespace AND r.relkind='r' AND r.relname=e.t)")
    sql = ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
           "SET LOCAL client_min_messages='warning'; SET LOCAL row_security=off;",
           "SET LOCAL search_path=pg_catalog,public; SET LOCAL statement_timeout='60s';",
           "SET LOCAL lock_timeout='5s';",
           "SELECT jsonb_build_object('kind','shape','missing',coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb)) FROM (" + missing + ") x;",
           'SELECT NOT EXISTS(' + missing + ') AS shape_ok \\gset',
           '\\if :shape_ok', '\\else', '\\quit 31', '\\endif']
    expected = ','.join('(' + literal(x['version']) + ',' + literal(x['script']) + ')'
                        for x in contract['migrations'])
    same_version="string_to_array(h.version,'.')::int[]=string_to_array(e.v,'.')::int[]"
    allowed=' OR '.join("(string_to_array(h.version,'.')::int[]=string_to_array("+literal(m['version'])+",'.')::int[] AND h.script="+literal(m['script'])+")" for m in contract['allowed_additions']['migrations']) or 'false'
    migration_problem = ("WITH expected(v,s) AS (VALUES " + expected + ") "
                         "SELECT e.v AS version,e.s AS script FROM expected e WHERE NOT EXISTS "
                         "(SELECT 1 FROM public.flyway_schema_history h WHERE "+same_version+" AND h.script=e.s AND h.success) "
                         "UNION ALL SELECT coalesce(h.version,'<null>'),h.script FROM public.flyway_schema_history h "
                         "WHERE NOT h.success OR (NOT EXISTS(SELECT 1 FROM expected e WHERE "+same_version+" AND e.s=h.script) AND NOT ("+allowed+"))")
    sql.extend(["SELECT jsonb_build_object('kind','migrations','problems',coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb)) FROM (" + migration_problem + ") x;",
                'SELECT NOT EXISTS(' + migration_problem + ') AS migrations_ok \\gset',
                '\\if :migrations_ok', '\\else', '\\quit 32', '\\endif'])
    visible = ("(SELECT rolsuper OR rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user) "
               "OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
               "WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity)")
    sql.extend(["SELECT jsonb_build_object('kind','visibility','full',(" + visible + '));',
                'SELECT (' + visible + ') AS visibility_ok \\gset',
                '\\if :visibility_ok', '\\else', '\\quit 33', '\\endif',
                "SELECT jsonb_build_object('kind','snapshot','database',current_database(),"
                "'database_user',current_user,'isolation',current_setting('transaction_isolation'),"
                "'read_only',current_setting('transaction_read_only')='on','snapshot_id',pg_current_snapshot()::text,"
                "'started_at',transaction_timestamp());"])
    return sql


def audit_queries(contract, runtime_role='jxc_app'):
    sql = preflight(contract)
    missing = catalog_gaps_query(contract,runtime_role)
    sql.append("SELECT jsonb_build_object('kind','constraints','missing',coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb)) FROM (" + missing + ') x;')
    for table in contract['tables']:
        sql.append("SELECT jsonb_build_object('kind','count','table'," + literal(table)
                   + ",'count',count(*)) FROM " + relation(table) + ';')
    for key in contract['source_keys']:
        table, cols = key['table'], key['columns']
        pred = key['predicate'] or 'true'
        group = ','.join(identifier(c) for c in cols)
        nonnull = ' AND '.join(identifier(c) + ' IS NOT NULL' for c in cols)
        match = ' AND '.join('d.' + identifier(c) + '=t.' + identifier(c) for c in cols)
        sql.append(finding(contract, 'DUPLICATE_SOURCE', table,
                           '(' + pred + ') AND EXISTS(SELECT 1 FROM ' + relation(table)
                           + ' d WHERE ' + match + ' AND (' + pred + ') GROUP BY ' + group + ' HAVING count(*)>1)'
                           + ' AND ' + nonnull,
                           json_fields(cols), reason='Existing migration source uniqueness is violated; each conflicting row is listed.', rule=key['name']))
    negatives = {
        'inv_stock_summary': 'on_hand_qty reserved_qty frozen_qty',
        'inv_batch_balance': 'on_hand_qty frozen_qty',
        'inv_reservation': 'qty consumed_qty released_qty', 'inv_freeze': 'qty released_qty',
        'ap_source_capacity': 'current_max_qty current_max_amount claimed_qty claimed_amount',
        'ap_bill': 'amount paid_amount', 'ap_payment': 'amount used_amount',
        'ap_prepayment': 'amount used_amount', 'ap_credit_note': 'amount used_amount',
        'ar_receivable': 'amount written_off_amount open_amount', 'ar_receipt': 'amount written_off_amount',
        'ar_credit_note': 'amount used_amount reserved_amount',
        'ar_credit_occupation': 'amount released_amount',
        'ar_refund_reservation': 'amount consumed_amount released_amount',
        'fin_account_balance': 'opening_debit opening_credit closing_debit closing_credit'}
    for table, names in negatives.items():
        cols = names.split()
        sql.append(finding(contract, 'NEGATIVE_BALANCE', table,
                           ' OR '.join('t.' + identifier(c) + '<0' for c in cols),
                           json_fields(cols), reason='A balance component constrained nonnegative by the existing schema is negative.'))
        sql.append(finding(contract, 'NEGATIVE_BALANCE', table,
                           ' OR '.join('t.' + identifier(c) + ' IS NULL' for c in cols),
                           json_fields(cols), reason='Required balance components are missing; nonnegative/capacity checks cannot be concluded.',
                           severity='REVIEW', rule='MISSING_BALANCE_COMPONENT'))
    occupations = {
        'inv_stock_summary': ('reserved_qty+frozen_qty>on_hand_qty', 'on_hand_qty reserved_qty frozen_qty'),
        'inv_batch_balance': ('frozen_qty>on_hand_qty', 'on_hand_qty frozen_qty'),
        'inv_reservation': ('consumed_qty+released_qty>qty', 'qty consumed_qty released_qty'),
        'inv_freeze': ('released_qty>qty', 'qty released_qty'),
        'ap_source_capacity': ('claimed_qty>current_max_qty OR claimed_amount>current_max_amount', 'claimed_qty current_max_qty claimed_amount current_max_amount'),
        'ap_bill': ('paid_amount>amount', 'amount paid_amount'),
        'ap_payment': ('used_amount>amount', 'amount used_amount'),
        'ap_prepayment': ('used_amount>amount', 'amount used_amount'),
        'ap_credit_note': ('used_amount>amount', 'amount used_amount'),
        'ar_receivable': ('written_off_amount>amount', 'amount written_off_amount'),
        'ar_receipt': ('written_off_amount>amount', 'amount written_off_amount'),
        'ar_credit_note': ('used_amount+reserved_amount>amount', 'amount used_amount reserved_amount'),
        'ar_credit_occupation': ('released_amount>amount', 'amount released_amount'),
        'ar_refund_reservation': ('consumed_amount+released_amount>amount', 'amount consumed_amount released_amount')}
    for table, (predicate, cols) in occupations.items():
        sql.append(finding(contract, 'OVER_OCCUPATION', table, predicate, json_fields(cols.split()),
                           reason='Consumed/reserved/frozen quantities or amounts exceed the existing source capacity.'))
    for fk in contract['foreign_keys']:
        table, target = fk['table'], fk['target']
        cols, refs = fk['columns'], fk['target_columns']
        nonnull = ' AND '.join('t.' + identifier(c) + ' IS NOT NULL' for c in cols)
        equals = ' AND '.join('p.' + identifier(r) + '=t.' + identifier(c) for c, r in zip(cols, refs))
        # Several original FKs carry country but omit book: report this additional
        # scope discrepancy separately as REVIEW rather than inventing a DB constraint.
        book_omitted = ('book_id' in contract['tables'][table]
                        and 'book_id' in contract['tables'][target] and 'book_id' not in cols)
        sql.append(finding(contract, 'SCOPE_REFERENCE', table,
                           nonnull + ' AND NOT EXISTS(SELECT 1 FROM ' + relation(target) + ' p WHERE ' + equals + ')',
                           json_fields(cols), reason='Referenced row is missing in the exact country/book/composite scope required by the existing foreign key.', rule=fk['name']))
        if book_omitted:
            sql.append(finding(contract, 'SCOPE_REFERENCE', table,
                               nonnull + ' AND EXISTS(SELECT 1 FROM ' + relation(target)
                               + ' p WHERE ' + equals + ' AND p.book_id IS DISTINCT FROM t.book_id)',
                               json_fields(cols + ['book_id']), severity='REVIEW',
                               reason='Related facts use different books; original FK only enforces country. Review the source relationship.', rule=fk['name'] + ':book_review'))
    for table, cols in contract['tables'].items():
        if 'country_id' in cols:
            sql.append(finding(contract, 'SCOPE_REFERENCE', table,
                               ('t.country_id<>0 AND ' if table == 'sys_authz_epoch' else '')
                               + 'NOT EXISTS(SELECT 1 FROM public.sys_country p WHERE p.id=t.country_id)',
                               json_fields(['country_id']), reason='Country reference is absent.', rule='country_exists'))
    joined_cost = ('LEFT JOIN public.cst_cost_confirmation cc ON cc.country_id=t.country_id '
                   'AND cc.book_id=t.book_id AND cc.cost_id=t.id')
    sql.append(finding(contract, 'HISTORICAL_RATE', 'cst_inbound_cost',
                       't.src_currency<>t.base_currency AND (coalesce(cc.rate,t.rate) IS NULL '
                       'OR coalesce(cc.rate,t.rate)<=0 OR coalesce(cc.rate_date,t.rate_date) IS NULL)',
                       "jsonb_build_object('status',t.status,'rate',coalesce(cc.rate,t.rate),'rate_date',"
                       "coalesce(cc.rate_date,t.rate_date),'src_currency',t.src_currency,'base_currency',t.base_currency)",
                       reason='Foreign currency historical rate snapshot remains incomplete; pending state requires review, not a zero substitute.',
                       severity='REVIEW', joins=joined_cost))
    for table in ('ap_bill', 'ap_payment', 'ap_prepayment', 'ap_credit_note'):
        sql.append(finding(contract, 'HISTORICAL_RATE', table,
                           "t.status<>'VOIDED' AND (t.valuation_status='PENDING_RATE' OR t.rate IS NULL "
                           "OR t.base_currency IS NULL OR t.base_amount IS NULL "
                           "OR (t.currency<>t.base_currency AND t.rate_date IS NULL))",
                           json_fields(['status', 'valuation_status', 'currency', 'base_currency', 'rate', 'rate_date', 'base_amount']),
                           reason='Historical valuation is pending/incomplete; retain the original missing values.', severity='REVIEW'))
    sql.append(finding(contract, 'HISTORICAL_COST', 'cst_inbound_cost',
                       'coalesce(cc.unit_cost,t.unit_cost) IS NULL OR (cc.cost_id IS NULL AND t.status=\'ESTIMATED\')',
                       "jsonb_build_object('status',t.status,'unit_cost',coalesce(cc.unit_cost,t.unit_cost),'confirmation_present',cc.cost_id IS NOT NULL)",
                       reason='Inbound cost is missing or estimated without a confirmation fact.', severity='REVIEW', joins=joined_cost))
    sql.append(finding(contract, 'HISTORICAL_COST', 'inv_batch',
                       'NOT EXISTS(SELECT 1 FROM public.cst_inbound_cost c WHERE c.country_id=t.country_id AND c.book_id=t.book_id AND c.batch_id=t.id)',
                       json_fields(['cost_snapshot_id', 'first_inbound_date']),
                       reason='Inventory batch has no inbound cost source in its country/book.', severity='REVIEW'))
    sql.append(finding(contract, 'HISTORICAL_COST', 'cst_cogs',
                       "coalesce(cc.amount,t.amount) IS NULL OR coalesce(cc.unit_cost,t.unit_cost) IS NULL "
                       "OR (cc.cogs_id IS NULL AND t.status='ESTIMATED')",
                       "jsonb_build_object('status',t.status,'amount',coalesce(cc.amount,t.amount),'unit_cost',coalesce(cc.unit_cost,t.unit_cost))",
                       reason='COGS amount or unit cost is missing/estimated; no cost is fabricated.', severity='REVIEW',
                       joins='LEFT JOIN public.cst_cogs_completion cc ON cc.country_id=t.country_id AND cc.book_id=t.book_id AND cc.cogs_id=t.id'))
    valid_result = ("EXISTS(SELECT 1 FROM public.fin_event_result r JOIN public.fin_mapping_template m "
                    "ON m.country_id=r.country_id AND m.book_id=r.book_id AND m.id=r.mapping_template_id AND m.version_no=r.mapping_version "
                    "LEFT JOIN public.fin_voucher v ON v.country_id=r.country_id AND v.book_id=r.book_id AND v.id=r.voucher_id "
                    "WHERE r.country_id=t.country_id AND r.book_id=t.book_id AND r.event_id=t.id AND r.source_event_version=t.event_seq "
                    "AND m.reviewed_by IS NOT NULL AND m.reviewed_at IS NOT NULL AND "
                    "((r.status='NO_VOUCHER' AND m.accounting_mode='NO_VOUCHER' AND r.voucher_id IS NULL "
                    "AND length(btrim(r.reason))>0 AND length(btrim(m.no_voucher_reason))>0) OR "
                    "(r.status='GENERATED' AND m.accounting_mode='VOUCHER' AND v.source_event_id=t.id "
                    "AND v.mapping_template_id=r.mapping_template_id AND v.mapping_version=r.mapping_version)))")
    sql.append(finding(contract, 'EVENT_VOUCHER', 'sys_biz_event',
                       "t.event_type NOT LIKE 'SYS\\_%' ESCAPE '\\' AND coalesce(t.payload->>'accountingImpact','') NOT IN ('NONE','SOURCE_CONFIRMATION') AND NOT " + valid_result,
                       json_fields(['event_type', 'event_seq', 'biz_date']),
                       reason='No matching reviewed interpretation/voucher found. Accounting impact must be verified through existing source providers; this audit does not infer posting authority.', severity='REVIEW'))
    sql.append(finding(contract, 'ATTACHMENT_METADATA', 'sys_attachment',
                       "t.object_status<>'AVAILABLE' OR t.status<>'VALID' OR t.size<=0 OR btrim(t.storage_key)='' OR t.sha256!~'^[0-9a-f]{64}$'",
                       json_fields(['size', 'sha256', 'object_status', 'status']),
                       reason='Attachment database metadata indicates missing/unavailable/invalid evidence. Object bytes are not checked here.'))
    sql.append(finding(contract, 'ATTACHMENT_METADATA', 'sys_attachment_link',
                       't.unlinked_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.sys_attachment a WHERE a.country_id=t.country_id AND a.id=t.attachment_id '
                       "AND a.object_status='AVAILABLE' AND a.status='VALID')", json_fields(['attachment_id']),
                       reason='Active attachment link has no available valid attachment metadata in the same country.'))
    for table, predicate in (('ap_payment', "t.status NOT IN ('PENDING_CONFIRM','VOIDED')"),
                             ('ap_prepayment', "t.status NOT IN ('PENDING_CONFIRM','VOIDED')"),
                             ('rtn_refund', "t.status='PAID'")):
        sql.append(finding(contract, 'ATTACHMENT_METADATA', table,
                           '(' + predicate + ') AND NOT EXISTS(SELECT 1 FROM public.sys_attachment a WHERE a.country_id=t.country_id '
                           "AND a.id=t.proof_attachment_id AND a.object_status='AVAILABLE' AND a.status='VALID')",
                           json_fields(['status', 'proof_attachment_id']), reason='Confirmed payment/refund lacks available same-country proof metadata required by existing schema.'))
    sql.extend(["SELECT (to_regclass('public.sys_write_control') IS NOT NULL) AS gate_exists \\gset",
                '\\if :gate_exists',
                "SELECT jsonb_build_object('kind','gate','rows',(SELECT count(*) FROM public.sys_write_control),"
                "'mode',(SELECT mode FROM public.sys_write_control WHERE singleton),"
                "'epoch',(SELECT epoch FROM public.sys_write_control WHERE singleton),"
                "'batch_id',(SELECT batch_id FROM public.sys_write_control WHERE singleton),"
                "'missing_trigger_tables',(SELECT coalesce(jsonb_agg(c.relname ORDER BY c.relname),'[]'::jsonb) "
                "FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' "
                "AND c.relname NOT IN ('flyway_schema_history','sys_write_control','sys_write_control_log') "
                "AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger tr JOIN pg_catalog.pg_proc p ON p.oid=tr.tgfoid "
                "WHERE tr.tgrelid=c.oid AND tr.tgname='jxc_write_gate' AND p.oid=to_regprocedure('public.jxc_assert_writes_open()') AND tr.tgenabled IN ('O','A') "
                "AND (tr.tgtype::int & 1)=0 AND (tr.tgtype::int & 2)=2 AND (tr.tgtype::int & 60)=60)));",
                '\\else', "SELECT jsonb_build_object('kind','gate','available',false);", '\\endif',
                "SELECT jsonb_build_object('kind','complete','read_only',current_setting('transaction_read_only')='on');",
                'ROLLBACK;'])
    return '\n'.join(sql) + '\n'


def error_report(code, message):
    return {'format_version': 1, 'status': 'ERROR', 'error': {'code': code, 'message': message},
            'findings': None, 'finding_count': None, 'checks': []}


def run(args):
    psql = ['psql', '-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1']
    if args.database:
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_$-]{0,62}', args.database):
            return 1, error_report('INVALID_CONNECTION', 'Use a plain database name; configure credentials through libpq environment or a protected passfile.')
        psql.extend(['--dbname', args.database])
    if args.db_user:
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_$-]{0,62}', args.db_user):
            return 1, error_report('INVALID_CONNECTION', 'Use a plain database user name.')
        psql.extend(['--username', args.db_user])
    if args.docker_container:
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', args.docker_container):
            return 1, error_report('INVALID_CONNECTION', 'Invalid Docker container name.')
        psql = ['docker', 'exec', '-i', args.docker_container] + psql
    env = {**os.environ, 'PGAPPNAME': 'jxc-m5-readonly-audit'}
    try:
        provenance=subprocess.run(psql,input="SELECT coalesce(json_agg(json_build_object('version',version,'script',script,'success',success) ORDER BY installed_rank),'[]') FROM public.flyway_schema_history;",text=True,capture_output=True,env=env,timeout=args.timeout)
        if provenance.returncode:return 1,error_report('DATABASE_ERROR','Database provenance could not be read; diagnostics withheld.')
        selected=select_contract(json.loads(provenance.stdout))
        if selected is None:return 1,error_report('SCHEMA_MISMATCH','Migration provenance does not match a pinned supported legacy or release closure profile.')
        contract_path,contract=selected;contract_bytes=contract_path.read_bytes()
        result = subprocess.run(psql, input=audit_queries(contract,args.runtime_role), text=True,
                                capture_output=True, env=env, timeout=args.timeout)
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
        return 1, error_report('DATABASE_ERROR', 'Database command failed or timed out; connection diagnostics withheld.')
    records = []
    try:
        # Keep PostgreSQL numeric decimals exact; JSON evidence must not round via binary float.
        records = [json.loads(line, parse_float=str) for line in result.stdout.splitlines() if line.strip()]
    except (ValueError, TypeError):
        return 1, error_report('DATABASE_ERROR', 'Unexpected database output; diagnostics withheld.')
    by_kind = {r['kind']: r for r in records if r.get('kind') not in ('finding', 'count')}
    if by_kind.get('shape', {}).get('missing'):
        report = error_report('SCHEMA_MISMATCH', 'Required migration tables/columns/types are absent or incompatible; no audit pass is asserted.')
        report['error']['schema_differences'] = by_kind['shape']['missing']
        return 1, report
    if by_kind.get('migrations', {}).get('problems'):
        report = error_report('SCHEMA_MISMATCH', 'Migration provenance is incomplete or outside the supported M4/M5 profile.')
        report['error']['migration_differences'] = by_kind['migrations']['problems']
        return 1, report
    if by_kind.get('visibility', {}).get('full') is False:
        return 1, error_report('INSUFFICIENT_VISIBILITY', 'Cross-country audit requires unfiltered table visibility; RLS-filtered results are not accepted.')
    if result.returncode or not by_kind.get('complete', {}).get('read_only'):
        return 1, error_report('DATABASE_ERROR', 'Database audit did not complete in its read-only transaction; diagnostics withheld.')
    findings = [r for r in records if r.get('kind') == 'finding']
    for row in findings:
        del row['kind']
    findings.sort(key=lambda f: (f['check_code'], f['table'], json.dumps(f['row'], sort_keys=True), f['rule']))
    counts = Counter(f['check_code'] for f in findings)
    missing = by_kind['constraints']['missing']
    gate = by_kind['gate']
    gate_available = gate.get('available', True)
    checks = [{'code': code, 'status': 'FINDINGS' if counts[code] else 'PASS',
               'finding_count': counts[code]} for code in CHECK_CODES]
    for check in checks:
        if check['code'] == 'SCHEMA_CONSTRAINTS':
            check.update(status='GAPS' if missing else 'PASS', finding_count=len(missing))
        elif check['code'] == 'ATTACHMENT_OBJECTS':
            check.update(status='UNSUPPORTED', finding_count=None,
                         evidence_required='recovery.py object content hash verification for the same frozen batch')
        elif check['code'] == 'WRITE_GATE':
            ready = (gate_available and gate.get('rows') == 1 and gate.get('mode') in ('OPEN', 'FROZEN')
                     and not gate.get('missing_trigger_tables'))
            check.update(status=('PASS' if ready else 'GAPS') if gate_available else 'UNAVAILABLE',
                         finding_count=0 if ready else None, observed={k: v for k, v in gate.items() if k != 'kind'})
    limitations = [
        {'code': 'ATTACHMENT_OBJECT_BYTES_UNVERIFIED', 'check_code': 'ATTACHMENT_OBJECTS',
         'message': 'SQL metadata cannot prove object existence, size or content hash. Reconcile recovery.py evidence using the same frozen batch.'},
        {'code': 'ACCOUNTING_SOURCE_NOT_REEXECUTED', 'check_code': 'EVENT_VOUCHER',
         'message': 'Missing interpretations are review items. Original source providers and reviewed mapping remain authoritative; this tool neither recalculates nor posts.'},
        {'code': 'ATTACHMENT_POLICY_NOT_INFERRED', 'check_code': 'ATTACHMENT_METADATA',
         'message': 'Checks cover explicit required proof references and existing links. Undeclared document-specific evidence requirements are not inferred.'}]
    blocked = bool(findings or missing or any(c['status'] != 'PASS' for c in checks))
    return (2 if blocked else 0), {
        'format_version': 1, 'run_id': str(uuid.uuid4()),
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'status': 'REVIEW_REQUIRED' if blocked else 'PASS',
        'schema_profile': {'name': contract['profile'],
                           'contract_sha256': hashlib.sha256(contract_bytes).hexdigest(),
                           'missing_constraints': missing},
        'snapshot': {k: v for k, v in by_kind['snapshot'].items() if k != 'kind'},
        'table_counts': {r['table']: r['count'] for r in records if r.get('kind') == 'count'},
        'checks': checks, 'findings': findings, 'finding_count': len(findings),
        'limitations': limitations}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--docker-container', help='Execute psql in this container; credentials remain inside it')
    parser.add_argument('--database', help='Plain DB name; default libpq PGDATABASE')
    parser.add_argument('--db-user', help='Plain user name; default libpq PGUSER')
    parser.add_argument('--runtime-role', default='jxc_app', help='Expected explicit application runtime role (default jxc_app)')
    parser.add_argument('--output', type=Path, help='Also atomically write the JSON report with mode 0600')
    parser.add_argument('--timeout', type=int, default=300, help='Whole audit timeout in seconds (default 300)')
    args = parser.parse_args()
    try:
        code, report = run(args)
    except (OSError, KeyError, TypeError, ValueError):
        code, report = 1, error_report('AUDIT_ERROR', 'Audit configuration or report operation failed; diagnostics withheld.')
    body = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + '\n'
    if args.output:
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', prefix='.audit-',
                                             dir=args.output.parent, delete=False) as stream:
                temporary = stream.name
                os.chmod(temporary, 0o600)
                stream.write(body)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, args.output)
        except OSError:
            if temporary:
                Path(temporary).unlink(missing_ok=True)
            code, report = 1, error_report('OUTPUT_ERROR', 'Audit report could not be written.')
            body = json.dumps(report, sort_keys=True, indent=2) + '\n'
    sys.stdout.write(body)
    return code


if __name__ == '__main__':
    sys.exit(main())
