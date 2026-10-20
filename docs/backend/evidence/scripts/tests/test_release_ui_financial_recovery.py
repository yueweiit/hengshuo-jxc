"""Safety boundaries for the thin existing-UI financial restore adapter; no Docker."""
import copy
import importlib.util
from pathlib import Path
import unittest

SCRIPT=Path(__file__).resolve().parents[1]/'release-ui-financial-recovery.py'

class UiFinancialRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(),'Nonempty native UI financial restore adapter is missing')
        spec=importlib.util.spec_from_file_location('ui_financial_restore_test',SCRIPT)
        self.tool=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.tool)

    def test_financial_precondition_requires_actual_nonempty_generated_chain(self):
        good={'frozenAssignmentCount':1,'frozenLineCount':2,'generatedAssignmentCount':1,'linkedVoucherLineCount':2,'brokenLinkCount':0,'graphSha256':'a'*64}
        self.assertEqual(good,self.tool.require_financial_chain(good))
        for key in ['frozenAssignmentCount','frozenLineCount','generatedAssignmentCount','linkedVoucherLineCount']:
            with self.subTest(key=key),self.assertRaises(ValueError):self.tool.require_financial_chain({**good,key:0})
        with self.assertRaises(ValueError):self.tool.require_financial_chain({**good,'brokenLinkCount':1})
        with self.assertRaises(ValueError):self.tool.require_financial_chain({**good,'graphSha256':'not-a-hash'})

    def test_source_comparison_ignores_only_explicit_write_control_metadata(self):
        rows=[{'kind':'table','name':n,'rowsSha256':'a'} for n in ['ap_cost_assignment','sys_worker_runtime','flyway_schema_history','sys_write_control','sys_write_control_log']]+[{'kind':'sequence','name':n,'lastValue':3} for n in ['jxc_id_seq','sys_write_control_log_id_seq']]
        changed=copy.deepcopy(rows)
        for row in changed:
            if row['name'] in ['sys_write_control','sys_write_control_log']:row['rowsSha256']='new-gate'
            if row['name']=='sys_write_control_log_id_seq':row['lastValue']=5
        self.assertEqual(self.tool.business_projection(rows),self.tool.business_projection(changed))
        for target in ['ap_cost_assignment','sys_worker_runtime','flyway_schema_history','jxc_id_seq']:
            with self.subTest(target=target):
                drift=copy.deepcopy(changed);next(x for x in drift if x['name']==target)['unexpected']='drift'
                self.assertNotEqual(self.tool.business_projection(rows),self.tool.business_projection(drift))
        with self.assertRaises(ValueError):self.tool.business_projection(rows+[rows[0]])

    def test_success_cleans_target_before_source_resume_and_keeps_same_runtime(self):
        ops=FakeOps();self.tool.run_sequence(ops)
        self.assertEqual(['stop','freeze','backup-restore-verify','verify-source','cleanup-target','resume','start-same-runtime'],ops.calls)
        self.assertEqual('OPEN',ops.mode);self.assertTrue(ops.running)

    def test_backup_restore_or_target_cleanup_failure_never_resumes_source(self):
        for stage in ['backup-restore-verify','verify-source','cleanup-target']:
            with self.subTest(stage=stage):
                ops=FakeOps(stage)
                with self.assertRaises(RuntimeError):self.tool.run_sequence(ops)
                self.assertNotIn('resume',ops.calls);self.assertFalse(ops.running)
                self.assertEqual('FROZEN',ops.mode)

    def test_source_cas_resume_rejects_a_different_batch_or_epoch_before_any_write(self):
        for changed in [{'mode':'FROZEN','epoch':5,'batch_id':'someone-else'},
                        {'mode':'FROZEN','epoch':6,'batch_id':'our-batch'},
                        {'mode':'OPEN','epoch':5,'batch_id':'our-batch'}]:
            with self.subTest(changed=changed):
                ops=object.__new__(self.tool.Rehearsal);ops.batch='our-batch';ops.source={};ops.frozen={'epoch':5}
                states=iter([changed,{'mode':'OPEN','epoch':changed['epoch']+1,'batch_id':'our-batch'}]);ops.gate_state=lambda:next(states)
                writes=[]
                class Gate:
                    @staticmethod
                    def query(*args):writes.append(args)
                ops.gate=Gate()
                with self.assertRaises(ValueError):ops.transition('OPEN')
                self.assertEqual([],writes)

    def test_resume_attempt_is_fenced_even_when_post_commit_observation_fails(self):
        ops=object.__new__(self.tool.Rehearsal);ops.batch='our-batch';ops.source={};ops.frozen={'epoch':5};ops.source_opened=False
        states=iter([{'mode':'FROZEN','epoch':5,'batch_id':'our-batch'}])
        def state():
            try:return next(states)
            except StopIteration:raise RuntimeError('read after possible commit failed')
        ops.gate_state=state
        class Gate:
            @staticmethod
            def query(*args):pass
        ops.gate=Gate()
        with self.assertRaises(RuntimeError):ops.transition('OPEN')
        self.assertTrue(ops.source_opened,'Caller must refreeze after an ambiguous resume result')

    def test_failed_new_runtime_refreezes_source_and_never_uses_old_runtime(self):
        ops=FakeOps('start-same-runtime')
        with self.assertRaises(RuntimeError):self.tool.run_sequence(ops)
        self.assertEqual(['stop-started-runtime','refreeze'],ops.calls[-2:])
        self.assertEqual('FROZEN',ops.mode);self.assertFalse(ops.running)

    def test_failed_stop_still_attempts_exact_refreeze(self):
        class StopFailed(FakeOps):
            def stop_started_source(self):
                self.calls.append('stop-started-runtime');raise RuntimeError('owned stop failed')
        ops=StopFailed('start-same-runtime')
        with self.assertRaises(RuntimeError):self.tool.run_sequence(ops)
        self.assertEqual(['stop-started-runtime','refreeze'],ops.calls[-2:])
        self.assertEqual('FROZEN',ops.mode)

    def test_failure_record_refreezes_after_stop_error_and_reports_live_process(self):
        from types import SimpleNamespace
        ops=object.__new__(self.tool.Rehearsal);ops.evidence={};ops.source_stopped=True;ops.source_opened=True
        ops.args=SimpleNamespace(output='failure.json');ops.pub={'status':'running','apiPid':123};calls=[]
        def stop():calls.append('stop');raise RuntimeError('stop failed')
        ops.stop_started_source=stop;ops.refreeze_source=lambda:calls.append('refreeze')
        ops.gate_state=lambda:{'mode':'FROZEN','epoch':9,'batch_id':'own-batch'}
        ops.observe_process=lambda:{'state':'running','pid':123}
        ops.runtime=SimpleNamespace(write=lambda *args:None)
        with self.assertRaises(RuntimeError):ops.record_failure()
        self.assertEqual(['stop','refreeze'],calls)
        self.assertEqual('failed',ops.pub['status']);self.assertEqual(123,ops.pub['apiPid'])
        self.assertEqual({'state':'running','pid':123},ops.evidence['sourceProcessAfterFailure'])

    def test_failure_record_keeps_unknown_process_and_gate_explicit(self):
        from types import SimpleNamespace
        ops=object.__new__(self.tool.Rehearsal);ops.evidence={};ops.source_stopped=True;ops.source_opened=False
        ops.args=SimpleNamespace(output='failure.json');ops.pub={'status':'running','apiPid':123}
        def unavailable():raise RuntimeError('observation unavailable')
        ops.gate_state=unavailable;ops.observe_process=lambda:{'state':'unknown','pid':123}
        ops.runtime=SimpleNamespace(write=lambda *args:None)
        ops.record_failure()
        self.assertEqual('failed',ops.pub['status']);self.assertIsNone(ops.pub['apiPid'])
        self.assertEqual('UNKNOWN',ops.evidence['sourceFinalWriteMode'])

    def test_process_probe_error_is_unknown_rather_than_proof_of_stop(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        ops=object.__new__(self.tool.Rehearsal);ops.active=None;ops.args=SimpleNamespace(expected_pid=123)
        with patch.object(self.tool.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout='',stderr='process inspection failed')):
            self.assertEqual({'state':'unknown','pid':123},ops.observe_process())

    def test_actual_technical_snapshots_and_cas_states_survive_public_json(self):
        import json
        from types import SimpleNamespace
        before=[{'kind':'table','name':n,'rowCount':0,'rowsSha256':'a'} for n in ['sys_write_control','sys_write_control_log']]+[{'kind':'sequence','name':'sys_write_control_log_id_seq','lastValue':1,'isCalled':False}]
        frozen=copy.deepcopy(before);frozen[0]['rowsSha256']='b';frozen[1]['rowCount']=1;frozen[2]['isCalled']=True
        resumed=copy.deepcopy(frozen);resumed[0]['rowsSha256']='c';resumed[1]['rowCount']=2;resumed[2]['lastValue']=2
        states={'FROZEN':{'mode':'FROZEN','epoch':1,'batch_id':'our-batch'},'OPEN':{'mode':'OPEN','epoch':2,'batch_id':'our-batch'}}
        ops=object.__new__(self.tool.Rehearsal);ops.evidence={};ops.source={};ops.cfg={'jar':'same.jar'};ops.args=SimpleNamespace(expected_pid=123);ops.open_state={'mode':'OPEN','epoch':0,'batch_id':None}
        ops.preflight=lambda:None;ops.stop_pid=lambda *args:None
        snapshots=iter([before,frozen,resumed]);ops.snapshot=lambda *args:next(snapshots)
        ops.transition=lambda mode:states[mode];ops.financial=lambda *args:{'graphSha256':'a'*64}
        ops.gate=SimpleNamespace(proof=lambda *args:states['FROZEN']);ops.recovery=SimpleNamespace(write_private=lambda *args:None,canonical=lambda obj:json.dumps(obj).encode());ops.private=Path('/unused-test-private')
        ops.stop_source();ops.freeze_source();ops.resume_source()
        persisted=json.loads(json.dumps(ops.evidence))
        self.assertIn('sourceTechnicalSnapshots',persisted)
        self.assertEqual({'before','frozen','resumed'},set(persisted['sourceTechnicalSnapshots']))
        for phase,rows in [('before',before),('frozen',frozen),('resumed',resumed)]:self.assertCountEqual(rows,persisted['sourceTechnicalSnapshots'][phase]['objects'])
        self.assertEqual(states['FROZEN'],persisted['sourceTechnicalSnapshots']['frozen']['gate'])
        self.assertEqual(states['OPEN'],persisted['sourceTechnicalSnapshots']['resumed']['gate'])
        self.assertTrue(persisted['sourceTechnicalChanges']['beforeToFrozen']);self.assertTrue(persisted['sourceTechnicalChanges']['frozenToResumed'])

    def test_failed_start_can_stop_its_exact_child_before_the_port_is_listening(self):
        ops=object.__new__(self.tool.Rehearsal);ops.cfg={'jar':'same-runtime.jar'};calls=[]
        class Child:
            pid=123
            def poll(self):return None
            def wait(self,timeout):calls.append(('wait',timeout))
        ops.active=Child();ops.stop_pid=lambda *args,**kwargs:calls.append((args,kwargs))
        ops.stop_started_source()
        self.assertEqual(((123,'same-runtime.jar'),{'must_listen':False}),calls[0])

    def test_stop_failure_does_not_freeze_or_create_target(self):
        ops=FakeOps('stop')
        with self.assertRaises(RuntimeError):self.tool.run_sequence(ops)
        self.assertEqual(['stop'],ops.calls);self.assertEqual('OPEN',ops.mode)

    def test_failed_refreeze_marks_public_stopped_only_when_observed_stopped(self):
        from types import SimpleNamespace
        ops=object.__new__(self.tool.Rehearsal);ops.evidence={};ops.source_stopped=True;ops.source_opened=True
        ops.args=SimpleNamespace(output='failure.json');ops.pub={'status':'running','apiPid':123};writes=[]
        ops.stop_started_source=lambda:None
        def fail():raise RuntimeError('CAS no longer ours')
        ops.refreeze_source=fail;ops.gate_state=lambda:{'mode':'UNKNOWN'}
        ops.observe_process=lambda:{'state':'stopped','pid':123}
        ops.runtime=SimpleNamespace(write=lambda *args:writes.append(args))
        with self.assertRaises(RuntimeError):ops.record_failure()
        self.assertEqual('stopped',ops.pub['status']);self.assertIsNone(ops.pub['apiPid']);self.assertTrue(writes)

class FakeOps:
    def __init__(self,fail=None):self.fail=fail;self.calls=[];self.mode='OPEN';self.running=True;self.source_opened=False
    def step(self,name):
        self.calls.append(name)
        if name==self.fail:raise RuntimeError('controlled failure')
    def stop_source(self):self.step('stop');self.running=False
    def freeze_source(self):self.mode='FROZEN';self.step('freeze')
    def backup_restore_verify(self):self.step('backup-restore-verify')
    def verify_source(self):self.step('verify-source')
    def cleanup_target(self):self.step('cleanup-target')
    def resume_source(self):self.step('resume');self.mode='OPEN';self.source_opened=True
    def start_source(self):self.running=True;self.step('start-same-runtime')
    def stop_started_source(self):self.step('stop-started-runtime');self.running=False
    def refreeze_source(self):self.step('refreeze');self.mode='FROZEN';self.source_opened=False

if __name__=='__main__':unittest.main()
