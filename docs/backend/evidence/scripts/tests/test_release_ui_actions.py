import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT=Path(__file__).resolve().parents[1]/'release-ui-actions.py'

class ReleaseUiActionsTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.directory=Path(self.tmp.name)
  self.runtime=self.directory/'runtime.json';self.runtime.write_text(json.dumps({'jarSha256':'a'*64}))
  self.run=self.directory/'run.json';self.run.write_text(json.dumps({'runtimeEvidence':str(self.runtime),'jarSha256':'a'*64,'browserBaseUrl':'http://127.0.0.1:18173','countries':{'MX':{'countryId':101,'currency':'MXN','timezone':'America/Mexico_City'}},'cases':[{'country':'MX','id':'A13','status':'not_executed','records':[]}],'preparation':[]}))
  self.capture=self.directory/'page.png'
  self.capture.write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII='))
 def record(self,evidence=None,**overrides):
  values={'operator':'synthetic-user-364','page':'http://localhost:18173/inventory/stocks','documents':'N/A (scope configuration)','vouchers':'N/A (no accounting action)','closing-quantity':'0 visible after revoke','closing-amount':'N/A (amount fields hidden)','notes':'Actual page action and screenshot; API preparation is separate.',**overrides}
  command=[sys.executable,str(SCRIPT),'record','--run',str(self.run),'--country','MX','--case','A13','--result','passed']
  for key,value in values.items():command+=['--'+key,value]
  command+=['--evidence',str(evidence or self.capture)]
  return subprocess.run(command,capture_output=True,text=True)
 def test_api_preparation_json_alone_cannot_pass_browser_case(self):
  path=self.directory/'api-preparation.json';path.write_text('{"browserAcceptance":false}')
  self.assertNotEqual(0,self.record(path).returncode)
  self.assertEqual('not_executed',json.loads(self.run.read_text())['cases'][0]['status'])
 def test_sql_log_or_renamed_nonimage_cannot_pass_browser_case(self):
  for name in ('sql.log','forged.png'):
   with self.subTest(name=name):
    path=self.directory/name;path.write_text('SELECT 1; passed')
    self.assertNotEqual(0,self.record(path).returncode)
 def test_empty_business_results_or_operator_cannot_pass(self):
  for key in ('operator','documents','vouchers','closing-quantity','closing-amount','notes'):
   with self.subTest(key=key):self.assertNotEqual(0,self.record(**{key:'  '}).returncode)
 def test_nonbrowser_or_unrelated_page_cannot_pass(self):
  for page in ('file:///api-preparation.json','http://example.com/inventory/stocks',''):
   with self.subTest(page=page):self.assertNotEqual(0,self.record(page=page).returncode)
 def test_runtime_changed_requires_current_candidate_before_pass(self):
  self.runtime.write_text(json.dumps({'jarSha256':'b'*64}))
  self.assertNotEqual(0,self.record().returncode)
 def test_actual_capture_and_explicit_results_record_runtime_identity(self):
  result=self.record();self.assertEqual(0,result.returncode,result.stderr)
  row=json.loads(self.run.read_text())['cases'][0]
  self.assertEqual('passed',row['status']);self.assertEqual('BROWSER_UI',row['records'][-1]['layer'])
  self.assertEqual('a'*64,row['records'][-1]['executionJarSha256'])
  self.assertEqual(64,len(row['records'][-1]['frontendSourceSha256']))
 def test_verifier_rejects_an_old_frontend_record(self):
  self.assertEqual(0,self.record().returncode)
  run=json.loads(self.run.read_text());record=run['cases'][0]['records'][-1];record['frontendSourceSha256']='0'*64
  spec=importlib.util.spec_from_file_location('ui_actions',SCRIPT);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  with self.assertRaisesRegex(ValueError,'Frontend source changed'):module.validate_browser_record(run,record,'a'*64,country='MX')
 def test_verifier_uses_explicit_workspace_source(self):
  self.assertEqual(0,self.record().returncode)
  run=json.loads(self.run.read_text());record=run['cases'][0]['records'][-1]
  alternative=self.directory/'other-workspace';(alternative/'jxc-web/src').mkdir(parents=True);(alternative/'jxc-web/src/index.ts').write_text('different source')
  spec=importlib.util.spec_from_file_location('ui_actions',SCRIPT);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  with self.assertRaisesRegex(ValueError,'Frontend source changed'):module.validate_browser_record(run,record,'a'*64,alternative,country='MX')
 def test_env_only_change_invalidates_an_existing_frontend_record(self):
  self.assertEqual(0,self.record().returncode)
  run=json.loads(self.run.read_text());record=run['cases'][0]['records'][-1]
  alternative=self.directory/'env-workspace';web=alternative/'jxc-web';(web/'src').mkdir(parents=True);(web/'src/index.ts').write_text('same source')
  spec=importlib.util.spec_from_file_location('ui_actions_env',SCRIPT);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  record['frontendSourceSha256']=module.frontend_source_sha(alternative)
  (web/'.env.development').write_text('VITE_USE_MOCK=false\nVITE_API_TARGET=http://localhost:9999\n')
  with self.assertRaisesRegex(ValueError,'Frontend source changed'):module.validate_browser_record(run,record,'a'*64,alternative,country='MX')
 def test_new_records_bind_the_execution_country_and_cannot_be_reused_for_another_country(self):
  self.assertEqual(0,self.record().returncode)
  run=json.loads(self.run.read_text());record=run['cases'][0]['records'][-1]
  self.assertEqual(101,record.get('executionCountryId'))
  run['countries']['MX']['countryId']=102
  spec=importlib.util.spec_from_file_location('ui_actions_country',SCRIPT);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  with self.assertRaisesRegex(ValueError,'country'):module.validate_browser_record(run,record,'a'*64,country='MX')
 def test_country_rebind_preserves_same_identity_and_rejects_changes_after_any_record(self):
  self.assertEqual(0,self.record().returncode)
  before=self.run.read_text()
  for country_id,currency,timezone in [(102,'MXN','America/Mexico_City'),(101,'USD','America/Mexico_City'),(101,'MXN','UTC')]:
   with self.subTest(identity=(country_id,currency,timezone)):
    self.run.write_text(before)
    command=[sys.executable,str(SCRIPT),'bind-country','--run',str(self.run),'--country','MX','--id',str(country_id),'--currency',currency,'--timezone',timezone]
    self.assertNotEqual(0,subprocess.run(command,capture_output=True,text=True).returncode)
    self.assertEqual(before,self.run.read_text())
  self.run.write_text(before)
  command=[sys.executable,str(SCRIPT),'bind-country','--run',str(self.run),'--country','MX','--id','101','--currency','MXN','--timezone','America/Mexico_City']
  self.assertEqual(0,subprocess.run(command,capture_output=True,text=True).returncode)
  self.assertEqual(before,self.run.read_text())
 def test_preparation_does_not_change_browser_status(self):
  result=subprocess.run([sys.executable,str(SCRIPT),'prepare','--run',str(self.run),'--layer','API_PREPARATION','--description','Synthetic configuration only'],capture_output=True,text=True)
  self.assertEqual(0,result.returncode,result.stderr)
  run=json.loads(self.run.read_text());self.assertEqual('not_executed',run['cases'][0]['status']);self.assertFalse(run['preparation'][-1]['browserAcceptance'])

if __name__=='__main__':unittest.main()
