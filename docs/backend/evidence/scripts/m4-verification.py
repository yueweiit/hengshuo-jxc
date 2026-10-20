#!/usr/bin/env python3
"""Build M4 evidence from current full-run XML/logs and explicit command results; no test is run.

Required --run-results JSON keys: backend, frontend, build, contracts. Each has command,
exitCode, startedAt, finishedAt (ISO timestamps). Logs default to /tmp/hengshuo-m4-final-*.
Optional --browser JSON: see acceptance-m4.md; without it overall status remains pending_browser.
"""
from pathlib import Path
import argparse
import ast
import datetime
import hashlib
import importlib.util
import json
import os
import re
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[4])
parser.add_argument('--baseline', type=Path)
parser.add_argument('--execution-root', type=Path, help='Clean exported workspace used by Maven; all compiled source bytes must equal current workspace')
parser.add_argument('--backend-log', type=Path, default=Path('/tmp/hengshuo-m4-final-pg.log'))
parser.add_argument('--web-log', type=Path, default=Path('/tmp/hengshuo-m4-final-web-tests.log'))
parser.add_argument('--build-log', type=Path, default=Path('/tmp/hengshuo-m4-final-web-build.log'))
parser.add_argument('--contract-log', type=Path, default=Path('/tmp/hengshuo-m4-final-contract-check.log'))
parser.add_argument('--run-results', type=Path, required=True)
parser.add_argument('--browser', type=Path)
parser.add_argument('--output', type=Path)
parser.add_argument('--phase', choices=('m4', 'm5', 'release'), default='m4')
parser.add_argument('--operations', type=Path, help='M5 executed rehearsal evidence; required for --phase m5')
args = parser.parse_args()
root = args.root.resolve()
execution_root = (args.execution_root or root).resolve()
artifact_jar = execution_root / 'jxc-server/jxc-app/target/jxc-app-0.1.0-SNAPSHOT.jar'
base = (args.baseline or Path(Path(f'/tmp/hengshuo-{args.phase}-baseline-path').read_text().strip())).resolve()
output_path = args.output or root / f'docs/backend/evidence/verification-{args.phase}.json'
previous_phase = {'m4':'m3','m5':'m4','release':'m5'}[args.phase]
old = json.loads((base / f'docs/backend/evidence/verification-{previous_phase}.json').read_text())
runs = json.loads(args.run_results.read_text())

def require(condition, message):
    if not condition:
        raise ValueError(message)

def timestamp(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

for name in ('backend', 'frontend', 'build', 'contracts'):
    run = runs[name]
    require(run.get('exitCode') == 0, f'{name}: command did not exit 0')
    require(bool(run.get('command')), f'{name}: missing exact command')
    require(timestamp(run['finishedAt']) >= timestamp(run['startedAt']), f'{name}: invalid run interval')

def unchanged_since_start(paths, run_name):
    started = timestamp(runs[run_name]['startedAt'])
    changed = [str(path.relative_to(root)) if path.is_relative_to(root) else str(path) for path in paths
               if path.is_file() and path.stat().st_mtime > started + 1]
    require(not changed, f'{run_name}: source/config was edited during or after this run; rerun against final source: {sorted(changed)}')

def source_files(folder):
    def fail(error):raise error
    for directory, children, files in os.walk(folder,onerror=fail):
        children[:] = [name for name in children if name not in {'.git','target','node_modules','dist','__pycache__'} and not re.fullmatch(r'target \d+',name)]
        yield from (Path(directory)/name for name in files)

server_sources = [path for path in source_files(root / 'jxc-server')
                  if path.is_file()
                  and ('src' in path.relative_to(root / 'jxc-server').parts or path.name == 'pom.xml'
                       or path.name in {'mvnw','mvnw.cmd'} or '.mvn' in path.relative_to(root / 'jxc-server').parts)]
if execution_root != root:
    exported_sources=[path for path in source_files(execution_root/'jxc-server') if path.is_file() and
                      ('src' in path.relative_to(execution_root/'jxc-server').parts or path.name in {'pom.xml','mvnw','mvnw.cmd'} or '.mvn' in path.relative_to(execution_root/'jxc-server').parts)]
    require({path.relative_to(root).as_posix() for path in server_sources}=={path.relative_to(execution_root).as_posix() for path in exported_sources}, 'Clean export contains missing or extra build sources')
    for source in server_sources:
        exported=execution_root/source.relative_to(root)
        require(exported.is_file() and digest(exported)==digest(source), 'Clean export differs from current source: '+str(source.relative_to(root)))
    unchanged_since_start(exported_sources,'backend')
    shared_fixture = Path('jxc-web/tests/contracts/http-scenarios.json')
    require((execution_root/shared_fixture).is_file() and digest(execution_root/shared_fixture)==digest(root/shared_fixture), 'Clean export must include the exact shared HTTP contract fixture')
    unchanged_since_start([execution_root/shared_fixture], 'backend')
web_sources = [path for folder in ('src', 'tests') for path in (root / 'jxc-web' / folder).rglob('*') if path.is_file()]
web_sources += [path for path in (root / 'jxc-web').iterdir() if path.is_file()
                and (path.name.startswith(('package', 'vite.config', 'tsconfig', '.env')))]
unchanged_since_start(server_sources, 'backend')
unchanged_since_start(web_sources, 'frontend')
unchanged_since_start(web_sources, 'build')
unchanged_since_start([root / 'jxc-web/scripts/contracts/generate.mjs',
                       *[path for path in (root / 'docs/backend/contracts').glob('*-surface.json')]], 'contracts')
require('clean' in runs['backend']['command'] and 'verify' in runs['backend']['command']
        and '-Ppg-it' in runs['backend']['command'], 'Backend evidence requires full clean verify -Ppg-it')
require(not any(flag in runs['backend']['command'] for flag in ('-Dtest=', '-Dit.test=', '-DskipTests', '-Dmaven.test.skip')),
        'Focused/skip-test Maven commands cannot be reported as a complete backend run')
logs = {'backend': args.backend_log, 'frontend': args.web_log, 'build': args.build_log,
        'contracts': args.contract_log}
texts = {key: path.read_text() for key, path in logs.items()}
require('BUILD SUCCESS' in texts['backend'] and 'BUILD FAILURE' not in texts['backend'], 'Backend success marker absent')
require(bool(re.search(r'(?:#|ℹ)\s+fail 0\b', texts['frontend'])), 'Frontend failures are not zero')
require(bool(re.search(r'(?:#|ℹ)\s+skipped 0\b', texts['frontend'])), 'Frontend skips are not zero')
require('built in' in texts['build'], 'Vite production build success marker absent')
require('stale' not in texts['contracts'].lower(), 'Contract generator reports stale output')

classes = []
backend_started = timestamp(runs['backend']['startedAt'])
modules=[execution_root/'jxc-server',*(execution_root/'jxc-server').glob('jxc-*')]
reports=sorted(path for module in modules if (module/'pom.xml').is_file() for kind in ('failsafe-reports','surefire-reports') for path in (module/'target'/kind).glob('TEST-*.xml'))
for path in reports:
    require(path.stat().st_mtime >= backend_started - 2, f'Stale XML report: {path}')
    suite = ET.parse(path).getroot()
    row = dict(report=path.relative_to(root).as_posix() if execution_root==root else str(path), name=suite.attrib['name'], report_sha256=digest(path))
    row.update({key: int(suite.attrib.get(key, 0)) for key in ('tests', 'failures', 'errors', 'skipped')})
    require(row['tests'] > 0, f'Empty test suite: {row["name"]}')
    require(all(row[key] == 0 for key in ('failures', 'errors', 'skipped')), f'Failed/skipped suite: {row["name"]}')
    classes.append(row)
require(bool(classes), 'No backend XML reports')
require(len({row['name'] for row in classes}) == len(classes), 'Duplicate backend test suite names')
require({row['name'] for row in old['backend']['classes']} <= {row['name'] for row in classes},
        'At least one M3 backend regression class is absent from the full run')
current_by_name = {row['name']: row for row in classes}
require(all(current_by_name[row['name']]['tests'] >= row['tests'] for row in old['backend']['classes']),
        'An M3 class has fewer executions; investigate removed/filtered regressions before reporting retention')
total = sum(row['tests'] for row in classes)
pure_names = {'com.hs.jxc.ContextualAmountsTest', 'com.hs.jxc.AccountingAmountsTest', 'com.hs.jxc.it.InputBoundaryIT'}
pure = sum(row['tests'] for row in classes if row['name'] in pure_names)

def method_counts(folder):
    ordinary = parameterized = 0
    for path in java_test_sources(folder):
        text = path.read_text()
        ordinary += len(re.findall(r'@Test\b', text))
        parameterized += len(re.findall(r'@ParameterizedTest\b', text))
    return ordinary, parameterized

def java_test_sources(folder):
    for path in source_files(folder/'jxc-server'):
        if path.suffix=='.java' and 'src/test/java/' in path.relative_to(folder/'jxc-server').as_posix():
            yield path

expected_classes = set()
for source in java_test_sources(root):
    text = source.read_text()
    if re.search(r'@(Test|ParameterizedTest)\b', text):
        package = re.search(r'\bpackage\s+([\w.]+)\s*;', text)
        require(package is not None, f'No package in executable test source: {source}')
        expected_classes.add(package[1] + '.' + source.stem)
require(expected_classes == set(current_by_name),
        f'Current executable test sources differ from XML suites: missing={sorted(expected_classes - set(current_by_name))}, '
        f'unexpected={sorted(set(current_by_name) - expected_classes)}')

ordinary, parameterized = method_counts(root)
old_ordinary, old_parameterized = method_counts(base)
require(ordinary >= old_ordinary,
        'Ordinary test methods unexpectedly removed; explain the change before asserting regression retention')
unchanged = []
for name in ('amounts', 'cost-inventory', 'finance', 'permissions', 'scenario'):
    rel = f'jxc-web/tests/{name}.test.mjs'
    before, after = digest(base / rel), digest(root / rel)
    require(before == after, f'Original business Mock regression changed: {rel}')
    unchanged.append(dict(path=rel, baseline_sha256=before, current_sha256=after, identical=True))

match = re.search(r'(?:#|ℹ)\s+tests (\d+)', texts['frontend'])
require(match is not None, 'Cannot find frontend execution count')
web_tests = int(match[1])
require(web_tests >= old['frontend']['tests'], 'Frontend execution count below M3 baseline')
surface_path = root / ('docs/backend/contracts/closure-surface.json' if args.phase == 'release' else 'docs/backend/contracts/m4-surface.json')
surface = json.loads(surface_path.read_text())
require(bool(surface['operations']), 'M4 surface is empty')
require(all(row.get('phase') == ('CLOSURE' if args.phase == 'release' else 'M4') and row.get('status') == 'implemented-business-foundation'
            for row in surface['operations']), 'Unimplemented or wrong-phase M4 operation declaration')

browser = None
if args.browser:
    browser = json.loads(args.browser.read_text())
    if args.phase == 'release':
        require(browser.get('productionDeployment') is False, 'Isolated browser acceptance must not claim production')
        require(browser.get('mockDisabled') is True and browser.get('mockEvidence'), 'Actual non-Mock browser evidence required')
        require(browser.get('jarSha256') == digest(artifact_jar), 'Browser used a different jar')
        country_ids=[browser.get('countries',{}).get(key,{}).get('countryId') for key in ('MX','SECOND')]
        require(all(type(value) is int and value>0 for value in country_ids) and len(set(country_ids))==2, 'Distinct actual country identities required')
        require(browser.get('preparation') is not None, 'Keep setup distinct from browser actions')
        cases=browser.get('cases',[])
        spec=importlib.util.spec_from_file_location('release_ui_actions',Path(__file__).with_name('release-ui-actions.py'))
        workload=importlib.util.module_from_spec(spec);spec.loader.exec_module(workload)
        require(sorted((r.get('country',''),r.get('id','')) for r in cases)==sorted(workload.case_assignments()), 'Exact original38 and second-country12 scopes required without duplicates')
        for case in cases:
            require(case.get('status')=='passed' and case.get('records'), 'Browser action unfinished: '+str(case.get('id')))
            last=case['records'][-1]
            require(last.get('result')=='passed' and last.get('layer')=='BROWSER_UI' and last.get('operator') and last.get('page') and last.get('evidence'), 'Actual UI record incomplete')
            try:
                workload.validate_browser_record(browser,last,digest(artifact_jar),root,country=case['country'])
            except ValueError as error:
                raise SystemExit('Invalid browser acceptance record: '+str(error))
            for evidence in last['evidence']:
                path=Path(evidence['path'])
                require(path.is_file() and digest(path)==evidence['sha256'], 'Browser capture changed or absent')
    else:
        require(browser.get('status') == 'passed', 'Browser acceptance is not passed')
        require(browser.get('mockDisabled') is True, 'Browser record does not confirm Mock disabled')
        country_rows = browser.get('countries', [])
        require({'CN', 'MX'} <= {row.get('countryCode') for row in country_rows}, 'Both CN and MX browser results required')
        for country in country_rows:
            checks = country.get('browserChecks', [])
            require(checks and all(row.get('status') == 'passed' and row.get('channel') == 'browser'
                                  and row.get('evidence') for row in checks), 'Invalid or unfinished browser checks')
            require(country.get('apiPreparation') is not None, 'Keep API preparation separate from browser operations')
        require(not re.search(r'\bPENDING\b', json.dumps(browser), re.IGNORECASE), 'Unfinished browser placeholders')

artifacts = [f'docs/backend/contracts/{name}.json' for name in
             ('route-catalog', 'openapi', 'mock-regressions', 'request-evidence', 'controller-mappings', 'm4-surface')]
artifacts += ['jxc-server/jxc-app/target/jxc-app-0.1.0-SNAPSHOT.jar']
hashes = {path: digest(artifact_jar if path=='jxc-server/jxc-app/target/jxc-app-0.1.0-SNAPSHOT.jar' else root/path) for path in artifacts}
if args.phase == 'release':
    hashes['docs/backend/contracts/closure-surface.json'] = digest(surface_path)
run_evidence = {key: {**runs[key], 'log': str(logs[key]), 'logSha256': digest(logs[key])} for key in logs}
baseline_backend = old['backend']['tests']
baseline_frontend = old['frontend']['tests']
pg_source = (root / 'jxc-server/jxc-app/src/test/java/com/hs/jxc/it/PgDatabase.java').read_text()
minio_source = (root / 'jxc-server/jxc-app/src/test/java/com/hs/jxc/it/MinioTestStorage.java').read_text()
pom = (root / 'jxc-server/pom.xml').read_text()
wrapper = (root / 'jxc-server/.mvn/wrapper/maven-wrapper.properties').read_text()
runtime = {
    'javaCompileTarget': int(re.search(r'<java.version>(\d+)</java.version>', pom)[1]),
    'mavenWrapperVersion': re.search(r'apache-maven/(\d+\.\d+\.\d+)/', wrapper)[1],
    'postgresImage': re.search(r'DockerImageName\.parse\("([^"]+)"', pg_source)[1],
    'minioTestImage': re.search(r'DockerImageName\.parse\("([^"]+)"', minio_source)[1],
    'declarationEvidence': 'Compile target, wrapper and test image pins read from current source; actual Java/Maven executable versions '
                           'are present only when supplied by current run-results.runtime.',
    **runs.get('runtime', {})}
result = {
    'verifiedAt': datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),
    'status': 'passed' if browser else 'pending_browser',
    'scope': 'M4 close/reopen and immutable generation snapshots, real financial reports and business profit, '
             'authorized outbox exports/workbench and original Vue real-backend integration; isolated synthetic data only.',
    'baseline': {'phase': previous_phase.upper(), 'backendExecutions': baseline_backend,
                 'realPostgresInvocations': old['backend']['realPostgresInvocations'],
                 'pureJavaInvocations': old['backend']['pureJavaInvocations'], 'frontendExecutions': baseline_frontend,
                 'verificationSha256': digest(base / f'docs/backend/evidence/verification-{previous_phase}.json')},
    'runtime': runtime,
    'executionRoot':str(execution_root),
    'verifiedJar':{'path':str(artifact_jar),'sha256':digest(artifact_jar)},
    'backend': {**run_evidence['backend'], 'tests': total, 'failures': 0, 'errors': 0, 'skipped': 0,
                'ordinaryTestMethods': ordinary, 'parameterizedMethods': parameterized,
                'parameterizedInvocations': total - ordinary,
                'newIndependentMethods': ordinary + parameterized - old_ordinary - old_parameterized,
                'newExecutions': total - baseline_backend, 'pureJavaInvocations': pure,
                'realPostgresInvocations': total - pure, 'classes': classes,
                'testCountingNote': 'Source @Test and @ParameterizedTest method counts are independent from XML execution counts; '
                                    'parameter expansion is not described as additional independent methods.'},
    'frontend': {**run_evidence['frontend'], 'tests': web_tests, 'baselineExecutions': baseline_frontend,
                 'newExecutions': web_tests - baseline_frontend, 'failures': 0, 'skipped': 0,
                 'originalBusinessTestCalls': old['frontend']['originalBusinessTestCalls'],
                 'originalBusinessExpandedInvocations': old['frontend']['originalBusinessExpandedInvocations'],
                 'build': run_evidence['build'], 'browserAcceptance': browser is not None},
    'contracts': {**run_evidence['contracts'], 'implementedM4Operations': len(surface['operations']),
                  'coverage': 'Controller-to-contract comparison and registered service surface; shared schemas do not constitute '
                              'a complete typed client SDK or independent HTTP/browser evidence for every DTO combination.'},
    'databaseTrustBoundary': 'Database enforces immutable/complete snapshot structure, actual posted balances/lines, generation, '
                            'period gates and controlled finalization. Derived report formulas run once in server-owned ReportApi; '
                            'the database does not independently recalculate every derived report amount or duplicate cross-module algorithms.',
    'browser': {'status': 'passed', 'record': str(args.browser), 'recordSha256': digest(args.browser), 'results': browser}
               if browser else {'status': 'pending', 'note': 'No logged-in two-country browser result supplied; HTTP or API preparation is not UI acceptance.'},
    'hashes': hashes, 'changeStatisticsFile': f'change-statistics-{args.phase}.json',
    'unchangedOriginalFrontendBusinessRegressions': unchanged,
    'notPerformed': ['remote CI', 'production deployment or existing business database upgrade',
                     'real business opening balances or production GL posting', 'external payment execution',
                     'M5 historical-data migration and backup/restore rehearsal', 'capacity/performance acceptance']
                    + ([] if browser else ['two-country logged-in browser acceptance']),
    'remainingTechnicalDebt': ['M5 existing-data migration, upgrade/cutover and backup/restore rehearsal',
                              'External AI provider is unconfigured; controlled unavailable responses, no fabricated analysis',
                              'Load validation and optimization of per-book serialization and historical precision scans',
                              'Existing Vite large-chunk warning requires a separate measured optimization if it persists']}
if args.phase in {'m5','release'}:
    require(args.operations is not None, 'M5 requires separately executed operations evidence')
    operations = json.loads(args.operations.read_text())
    require(operations.get('status') == 'passed' and operations.get('productionPerformed') is False,
            'M5 isolated rehearsal is unfinished or incorrectly labeled production')
    required = ({'schemaAudit','logicalRecovery','physicalPitr','workerRecovery','containerRuntime'} if args.phase == 'release' else
                {'readOnlyAudit', 'provenance', 'backupRestore', 'postWriteRecovery', 'onlineDdl', 'writeRoleAudit'})
    require(required <= set(operations.get('checks', {})), 'Missing M5 rehearsal checks')
    for name, check in operations['checks'].items():
        require(check.get('status') == 'passed' and check.get('evidence'), f'M5 check incomplete: {name}')
        path = root / check['evidence']
        require(path.is_file() and digest(path) == check.get('sha256'), f'M5 evidence changed or absent: {name}')
        if args.phase=='release':
            payload=json.loads(path.read_text())
            require(payload.get('status')=='passed', 'Executed release evidence is unfinished: '+name)
            if name in {'logicalRecovery','workerRecovery','containerRuntime'}:
                require(payload.get('jarSha256')==digest(artifact_jar), 'Different runtime jar in operations evidence: '+name)
            if name=='workerRecovery':
                require(payload.get('staleAlertVerified') is True and payload.get('failedAlertVerified') is True, 'Real worker alerts remain unverified')
                require({'api-sigkill-effect-rolled-back','restart-recovered-one-effect','explicit-new-owner-session-retry-recovers-original-job'} <= {s.get('step') for s in payload.get('steps',[])}, 'Worker interruption/restart/session retry evidence incomplete')
            if name=='logicalRecovery':
                require(all(payload.get(key) is True for key in ('sourceSecretsDirectoryRemoved','sourceContainersRemoved','independentRecipientKeyUsed')), 'Logical secret-loss recovery incomplete')
                require(payload.get('replayStatus')=='VERIFIED_REPLAY', 'Logical recovery replay was not verified')
            if name=='physicalPitr':
                require(all(payload.get(key) is True for key in ('baseBackupVerified','continuousWalArchived','sourceContainerRemoved','sourceVolumesRemoved','sourceSecretsDirectoryRemoved','independentRecipientKeyUsed','beforeTargetTransactionPresent','afterTargetTransactionAbsent')), 'Physical PITR evidence incomplete')
            if name=='schemaAudit':
                contract=root/'jxc-server/scripts/m5/audit_contract_closure.json'
                require(payload.get('contractSha256')==digest(contract), 'Schema audit used another closure catalog')
                require(payload.get('migrationSha256')=={p.name:digest(p) for p in (root/'jxc-server/jxc-app/src/main/resources/db/migration').glob('V*.sql')}, 'Schema audit used different migration bytes')
                audit_log=payload.get('auditLog',{});audit_path=root/audit_log.get('path','')
                require(audit_path.is_file() and digest(audit_path)==audit_log.get('sha256'), 'Schema audit execution log absent or changed')
                audit_tests=ast.parse((root/'jxc-server/scripts/m5/tests/test_audit.py').read_text())
                expected_audit_tests=sum(isinstance(method,ast.FunctionDef) and method.name.startswith('test_')
                    for klass in audit_tests.body if isinstance(klass,ast.ClassDef) and any(ast.unparse(base)=='unittest.TestCase' for base in klass.bases)
                    for method in klass.body)
                audit_summary=re.search(r'(?m)^Ran (\d+) tests? in [0-9.]+s$',audit_path.read_text())
                require(expected_audit_tests>0 and audit_summary is not None and int(audit_summary.group(1))==expected_audit_tests
                        and payload.get('tests')==expected_audit_tests and all(payload.get(key)==0 for key in ('failures','errors','skipped')),
                        'Complete actual schema audit regression required')
                for source,pin in payload.get('auditedSourceSha256',{}).items():
                    require((root/source).is_file() and digest(root/source)==pin, 'Schema audit tools changed after execution')
            if name=='containerRuntime':
                require(all(payload.get(key) is True for key in ('httpsVerified','runtimeOnlyCredentials','flywayDisabled','nonRoot','readOnlyRootFilesystem','imageArtifactHashesMatch','oneShotMigrationVerified')), 'Container runtime proof incomplete')
    result.update(scope='M5 read-only inventory, reviewed synthetic provenance, operational write freeze, '
                        'consistent PostgreSQL and referenced-attachment backup/restore, post-write recovery, '
                        'online constraint/index rehearsal and two-country original-page acceptance; no production migration.',
                  operations={'record': str(args.operations), 'recordSha256': digest(args.operations), 'results': operations})
    result['databaseTrustBoundary'] += ' V008 statement gates drain in-flight writes and reject frozen or stale-snapshot writes; privileged DDL operators remain trusted.'
    result['notPerformed'] = ['remote CI', 'production deployment/cutover or real historical migration',
                              'real opening balance confirmation, production GL posting or payment execution',
                              'production PITR/WAL archive, capacity, RPO/RTO and production infrastructure hardening']
    result['remainingTechnicalDebt'] = ['Actual deployment target, historical scope and confirmed production configuration/openings',
                                       'Production scoped S3 credentials, encryption-key escrow and tested PITR/WAL archive',
                                       'Four synthetic ESTIMATED COGS rows retain explicit review status; production history needs separate disposition',
                                       'Existing RuntimeRoleVerifier broad schema filtering needs tightening; M5 recovery rejects extra business schemas',
                                       'External AI provider remains unconfigured', 'Existing Vite large-chunk warning']
    if args.phase == 'release':
        result['scope']='M0-M5 release closure against final source; original service reuse, complete PostgreSQL regression and explicitly recorded isolated browser/operations evidence. No production release.'
        result['productionReleased']=False
        result['contracts']['implementedClosureOperations']=len(surface['operations'])
        result['notPerformed']=['remote CI','production deployment and production opening confirmation','actual off-host durability and production-scale RPO/RTO/performance acceptance','complete history migration','external payment execution or tax/platform integration']
        result['remainingTechnicalDebt']=['Deployment domain, DNS/TLS, backup destination, capacity/recovery targets and configuration owners must be confirmed and verified for each environment','Real master/opening/uncompleted-business source review and independent ledger reconciliation','Production image dependency/security review and independent key custody','External AI provider remains unconfigured','Vite large bundle; dense legacy code; immutable legacy logistics operator/time gaps; orphan attachment review; retained isolated rehearsal artifacts']
        result['accountingCoverage']={
            'automaticPurchasePayables':'New purchase cost interpretation requires an explicit confirmed-bill association and freezes the allocated original bill principal in the original FIN transaction. Missing or incompatible basis blocks interpretation while confirmed cost remains. Historical interpretation results are not recalculated.',
            'automaticVoucherLines':'Existing base-currency ledger lines; frozen original-currency business sources remain traceable. This does not establish complete original-currency automatic voucher accounting.',
            'unreceivedProcurement':'Confirmed AP bills and destination receipt costs retain their independent source timing. Unreceived or discrepant quantities can leave AP_DIFF and block closing; no automatic transit-asset recognition or invented clearing fact is introduced.',
            'productionPolicy':'Cross-period ownership and recognition rules require explicit business confirmation before extending automatic transit accounting.'
        }
output_path.parent.mkdir(parents=True, exist_ok=True)
output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(dict(output=str(output_path), status=result['status'], backendTests=total,
                      pg=total - pure, pure=pure, ordinary=ordinary, parameterizedMethods=parameterized,
                      parameterizedInvocations=total - ordinary, frontend=web_tests,
                      m4Operations=len(surface['operations'])), ensure_ascii=False))
