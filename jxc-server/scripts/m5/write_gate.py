#!/usr/bin/env python3
"""Explicit offline write freeze. Uses the V008 database gate, never a Mock flag.

Configuration is an operator-owned 0600 JSON file shared with recovery.py.
No shell, password arguments, web endpoint, or automatic thaw on failure.
"""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import uuid


def connection(path, section, expected):
    path=Path(path)
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600 or info.st_uid!=os.getuid() or info.st_size>65536:
        raise ValueError('CONFIG_REQUIRES_OWNED_REGULAR_0600_FILE')
    config=json.loads(path.read_text())
    if config.get('schemaVersion')!=1 or section not in ('source','target'):
        raise ValueError('CONFIG_VERSION_OR_SECTION_INVALID')
    value=config[section]
    if any(not isinstance(value.get(k),str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}',value[k]) for k in ('container','database','adminUser')):
        raise ValueError('CONNECTION_TARGET_INVALID')
    if expected!=value['container']+'/'+value['database']:
        raise ValueError('EXACT_DATABASE_TARGET_MISMATCH')
    return value


def literal(value):
    if not isinstance(value,str) or '\x00' in value:
        raise ValueError('INVALID_SQL_LITERAL')
    return "E'"+value.replace('\\','\\\\').replace("'","''")+"'"


def query(config, sql):
    command=['docker','exec','-i',config['container'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',config['adminUser'],'-d',config['database']]
    result=subprocess.run(command,input=sql,text=True,capture_output=True,timeout=65)
    if result.returncode:
        # Do not print SQL, connection diagnostics or arbitrary server data.
        for code in ('SYS_WRITE_EPOCH_CONFLICT','SYS_WRITE_CONTROL_MISSING','SYS_WRITE_CONTROL_INVALID'):
            if code in result.stderr:raise ValueError(code)
        raise ValueError('WRITE_GATE_DATABASE_OPERATION_FAILED')
    return json.loads(result.stdout.strip())


STATE_SQL="""SELECT jsonb_build_object('database',current_database(),'mode',g.mode,'epoch',g.epoch,
 'batch_id',g.batch_id,'changed_at',g.changed_at,'missing_gates',COALESCE((
 SELECT jsonb_agg(c.relname ORDER BY c.relname) FROM pg_class c
 WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
 AND c.relname NOT IN ('flyway_schema_history','sys_write_control','sys_write_control_log')
 AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid
 AND t.tgname='jxc_write_gate' AND t.tgenabled IN ('O','A')
 AND t.tgfoid='public.jxc_assert_writes_open()'::regprocedure
 AND (t.tgtype::int & 1)=0 AND (t.tgtype::int & 2)=2
 AND (t.tgtype::int & 60)=60)), '[]'::jsonb))
 FROM public.sys_write_control g WHERE singleton;"""


def proof(config, state):
    if state.get('database')!=config['database'] or state.get('mode') not in ('OPEN','FROZEN') or state.get('missing_gates')!=[]:
        raise ValueError('WRITE_GATE_DATABASE_OR_COVERAGE_MISMATCH')
    return {'schemaVersion':1,'batchId':state['batch_id'],'source':{k:config[k] for k in ('container','database')},
            'epoch':state['epoch'],'mode':state['mode'],'changedAt':state.get('changed_at'),'missingGates':[]}


def save(path, value):
    # Exclusive creation avoids replacing a prior operator proof or following symlinks.
    with open(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as out:
        json.dump(value,out,ensure_ascii=False,indent=2);out.write('\n')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('status','freeze','resume'))
    parser.add_argument('--config',type=Path,required=True)
    parser.add_argument('--connection',choices=('source','target'),default='source')
    parser.add_argument('--expect-target',required=True)
    parser.add_argument('--expected-epoch',type=int)
    parser.add_argument('--batch-id')
    parser.add_argument('--operator')
    parser.add_argument('--reason')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    try:
        config=connection(args.config,args.connection,args.expect_target)
        if args.output.exists() or args.output.is_symlink():raise ValueError('OUTPUT_ALREADY_EXISTS')
        if args.action=='status':
            state=query(config,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'+STATE_SQL+'\nCOMMIT;')
        else:
            if args.expected_epoch is None or args.expected_epoch<0 or not args.operator or not args.reason:
                raise ValueError('TRANSITION_REQUIRES_EPOCH_OPERATOR_REASON')
            batch=str(uuid.UUID(args.batch_id))
            mode='FROZEN' if args.action=='freeze' else 'OPEN'
            sql="BEGIN; SET LOCAL lock_timeout='50s'; SELECT jxc_set_write_mode("+','.join((literal(mode),str(args.expected_epoch),literal(batch)+'::uuid',literal(args.operator),literal(args.reason)))+"); COMMIT;"
            query(config,sql)
            state=query(config,'BEGIN READ ONLY;\n'+STATE_SQL+'\nCOMMIT;')
            if state['mode']!=mode or state['batch_id']!=batch:raise ValueError('TRANSITION_NOT_OBSERVED')
        value=proof(config,state);save(args.output,value)
        print(json.dumps({'status':'passed','mode':value['mode'],'epoch':value['epoch'],'output':str(args.output)}))
        return 0
    except (ValueError,KeyError,OSError,TypeError,subprocess.SubprocessError) as error:
        print(json.dumps({'status':'failed','code':str(error) if isinstance(error,ValueError) else 'WRITE_GATE_INPUT_OR_EXECUTION_FAILED'}))
        return 1


if __name__=='__main__':raise SystemExit(main())
