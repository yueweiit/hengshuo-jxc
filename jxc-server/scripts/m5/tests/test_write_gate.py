"""Operator input guards; lock/transaction behavior is covered by WriteFreezeIT on PG16."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid

SCRIPT=Path(__file__).parents[1]/'write_gate.py'
class WriteGateTest(unittest.TestCase):
 def load(self):
  self.assertTrue(SCRIPT.exists(),'write_gate CLI is not implemented')
  spec=importlib.util.spec_from_file_location('write_gate',SCRIPT);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
 def config(self,p):
  p.write_text(json.dumps({'schemaVersion':1,'source':{'container':'hengshuo-m5-test','database':'jxc_m5_test','adminUser':'postgres'}}));p.chmod(0o600);return p
 def test_private_exact_target(self):
  m=self.load()
  with tempfile.TemporaryDirectory() as d:
   p=self.config(Path(d)/'c.json')
   self.assertEqual(m.connection(p,'source','hengshuo-m5-test/jxc_m5_test')['database'],'jxc_m5_test')
   with self.assertRaises(ValueError):m.connection(p,'source','hengshuo-m5-test/wrong')
 def test_public_or_symlink_config_refused(self):
  m=self.load()
  with tempfile.TemporaryDirectory() as d:
   p=self.config(Path(d)/'c.json');p.chmod(0o644)
   with self.assertRaises(ValueError):m.connection(p,'source','hengshuo-m5-test/jxc_m5_test')
   p.chmod(0o600);link=Path(d)/'link';link.symlink_to(p)
   with self.assertRaises(ValueError):m.connection(link,'source','hengshuo-m5-test/jxc_m5_test')
 def test_operator_literals_are_sql_literals(self):
  m=self.load();self.assertEqual(m.literal("name'; SELECT 9; --"),"E'name''; SELECT 9; --'")
 def test_proof_is_current_database_bound(self):
  m=self.load();c={'container':'hengshuo-m5-test','database':'jxc_m5_test'}
  with self.assertRaises(ValueError):m.proof(c,{'database':'other','mode':'FROZEN','epoch':1,'batch_id':'7fe64938-e325-430f-9ba8-486f7004c6fd','missing_gates':[]})
  with self.assertRaises(ValueError):m.proof(c,{'database':'jxc_m5_test','mode':'FROZEN','epoch':1,'batch_id':'7fe64938-e325-430f-9ba8-486f7004c6fd','missing_gates':['sys_session']})

class WriteGateCatalogTest(unittest.TestCase):
 """Real catalog shapes: a same-named trigger alone does not establish coverage."""
 @classmethod
 def setUpClass(cls):
  cls.container='hengshuo-m5-gate-proof-test-'+uuid.uuid4().hex[:10]
  subprocess.run(['docker','run','-d','--name',cls.container,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine'],check=True,capture_output=True)
  try:
   for _ in range(80):
    ready=subprocess.run(['docker','exec',cls.container,'pg_isready','-U','postgres','-h','127.0.0.1'],capture_output=True)
    if ready.returncode==0:break
    time.sleep(.1)
   else:raise AssertionError('Disposable PostgreSQL did not start')
   cls.sql("""CREATE TABLE sys_write_control(singleton boolean PRIMARY KEY,mode text,epoch bigint,batch_id uuid,changed_at timestamptz);
    INSERT INTO sys_write_control VALUES(true,'FROZEN',1,'7fe64938-e325-430f-9ba8-486f7004c6fd',clock_timestamp());
    CREATE TABLE proof_probe(id integer);
    CREATE FUNCTION public.jxc_assert_writes_open() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE FUNCTION public.proof_wrong() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;""")
  except BaseException:
   subprocess.run(['docker','rm','-f',cls.container],capture_output=True)
   raise
 @classmethod
 def tearDownClass(cls):
  subprocess.run(['docker','rm','-f',cls.container],check=True,capture_output=True)
 @classmethod
 def sql(cls,sql):
  result=subprocess.run(['docker','exec','-i',cls.container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],input=sql,text=True,capture_output=True,timeout=20)
  if result.returncode:raise AssertionError(result.stderr)
  return result.stdout.strip()
 def test_trigger_coverage_requires_exact_function_timing_level_events_and_mode(self):
  m=WriteGateTest().load()
  cases=(
   ('origin','BEFORE','INSERT OR UPDATE OR DELETE OR TRUNCATE','STATEMENT','jxc_assert_writes_open','ENABLE',True),
   ('always','BEFORE','INSERT OR UPDATE OR DELETE OR TRUNCATE','STATEMENT','jxc_assert_writes_open','ENABLE ALWAYS',True),
   ('wrong_function','BEFORE','INSERT OR UPDATE OR DELETE OR TRUNCATE','STATEMENT','proof_wrong','ENABLE',False),
   ('after','AFTER','INSERT OR UPDATE OR DELETE OR TRUNCATE','STATEMENT','jxc_assert_writes_open','ENABLE',False),
   ('row','BEFORE','INSERT OR UPDATE OR DELETE','ROW','jxc_assert_writes_open','ENABLE',False),
   ('missing_truncate','BEFORE','INSERT OR UPDATE OR DELETE','STATEMENT','jxc_assert_writes_open','ENABLE',False),
   ('missing_delete','BEFORE','INSERT OR UPDATE OR TRUNCATE','STATEMENT','jxc_assert_writes_open','ENABLE',False),
   ('disabled','BEFORE','INSERT OR UPDATE OR DELETE OR TRUNCATE','STATEMENT','jxc_assert_writes_open','DISABLE',False),
   ('replica_only','BEFORE','INSERT OR UPDATE OR DELETE OR TRUNCATE','STATEMENT','jxc_assert_writes_open','ENABLE REPLICA',False),
  )
  for name,timing,events,level,function,mode,covered in cases:
   with self.subTest(case=name):
    self.sql('DROP TRIGGER IF EXISTS jxc_write_gate ON proof_probe; CREATE TRIGGER jxc_write_gate '+timing+' '+events+' ON proof_probe FOR EACH '+level+' EXECUTE FUNCTION public.'+function+'(); ALTER TABLE proof_probe '+mode+' TRIGGER jxc_write_gate;')
    state=json.loads(self.sql('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'+m.STATE_SQL+'\nROLLBACK;'))
    self.assertEqual([] if covered else ['proof_probe'],state['missing_gates'])

 def test_operator_literal_preserves_backslashes_under_both_server_settings(self):
  m=WriteGateTest().load();value="operator\\'; SELECT 9; --\nsynthetic"
  for setting in ('on','off'):
   with self.subTest(standard_conforming_strings=setting):
    actual=json.loads(self.sql('SET standard_conforming_strings='+setting+'; SELECT to_json('+m.literal(value)+'::text);'))
    self.assertEqual(value,actual)

if __name__=='__main__':unittest.main()
