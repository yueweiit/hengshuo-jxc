#!/usr/bin/env python3
"""Capture a reviewable closure contract from an explicitly isolated migrated PG16 fixture.

Reads catalogs only. It never migrates, seeds, repairs or accepts unknown live production schema.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

HERE=Path(__file__).resolve().parent
MIGRATIONS=HERE.parents[1]/'jxc-app/src/main/resources/db/migration'

def capture(query):
    statement="SET search_path=pg_catalog,public; "+query
    result=subprocess.run(capture.command,input=statement,text=True,capture_output=True,check=True,env={**os.environ,'PGAPPNAME':'jxc-isolated-contract-capture'})
    return json.loads(result.stdout.strip())

def generate(command, runtime_role='jxc_audit_runtime'):
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', runtime_role):raise ValueError('Explicit capture runtime role required')
    capture.command=command
    tables=capture("SELECT json_object_agg(table_name,columns ORDER BY table_name) FROM (SELECT c.relname table_name,json_object_agg(a.attname,format_type(a.atttypid,a.atttypmod) ORDER BY a.attnum) columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'flyway_schema_history' GROUP BY c.relname) x;")
    properties=capture("SELECT coalesce(json_agg(json_build_object('table',c.relname,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default_expression',pg_get_expr(d.adbin,d.adrelid),'generated',a.attgenerated,'identity',a.attidentity) ORDER BY c.relname,a.attnum),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'flyway_schema_history';")
    checks=capture("SELECT coalesce(json_agg(json_build_object('table',c.relname,'name',co.conname,'definition',pg_get_constraintdef(co.oid,true),'validated',co.convalidated,'no_inherit',co.connoinherit) ORDER BY c.relname,co.conname),'[]') FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND co.contype='c';")
    foreign=capture("SELECT coalesce(json_agg(x ORDER BY x.table,x.name),'[]') FROM (SELECT c.relname AS table,p.conname AS name,ARRAY(SELECT a.attname FROM unnest(p.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=p.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,target.relname AS target,ARRAY(SELECT a.attname FROM unnest(p.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=p.confrelid AND a.attnum=k.num ORDER BY k.ord) AS target_columns FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_class target ON target.oid=p.confrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND p.contype='f') x;")
    unique=capture("SELECT coalesce(json_agg(x ORDER BY x.table,x.name),'[]') FROM (SELECT c.relname AS table,idx.relname AS name,ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,pg_get_expr(i.indpred,i.indrelid) AS predicate FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname<>'flyway_schema_history' AND i.indisunique AND NOT i.indisprimary AND i.indexprs IS NULL) x;")
    triggers=capture("SELECT coalesce(json_agg(json_build_object('table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) ORDER BY c.relname,t.tgname),'[]') FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal;")
    functions=capture("SELECT coalesce(json_agg(json_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid)) ORDER BY p.oid::regprocedure::text),'[]') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';")
    for function in functions:
        if function['signature']=='jxc_period_closing_guard()':
            token="current_user='"+runtime_role+"'"
            if function['definition'].count(token)!=1:raise ValueError('Closing guard does not bind the reviewed runtime role')
            function['definition']=function['definition'].replace(token,"current_user='${runtimeRole}'")
    policies=capture("SELECT coalesce(json_agg(json_build_object('table',tablename,'name',policyname,'permissive',permissive,'roles',roles,'command',cmd,'qual',qual,'with_check',with_check) ORDER BY tablename,policyname),'[]') FROM pg_policies WHERE schemaname='public';")
    migrations=capture("SELECT coalesce(json_agg(json_build_object('version',version,'script',script) ORDER BY installed_rank),'[]') FROM public.flyway_schema_history WHERE success;")
    return {'profile':'release-closure-pg16','origin':'Isolated PostgreSQL 16 full migration catalogs, captured by generate_audit_contract.py','tables':tables,'table_names':sorted(tables),'column_properties':properties,'required_checks':checks,'migrations':migrations,'allowed_additions':{'tables':[],'migrations':[]},'foreign_keys':foreign,'source_keys':unique,'required_triggers':triggers,'required_functions':functions,'required_policies':policies,'rls_tables':sorted(t for t,columns in tables.items() if 'country_id' in columns),'exact_columns':True,'migration_files':[{ 'script':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(MIGRATIONS.glob('V*.sql'))]}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--docker-container',required=True);parser.add_argument('--database',required=True);parser.add_argument('--db-user',default='postgres');parser.add_argument('--runtime-role',default='jxc_audit_runtime');parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    if not args.docker_container.startswith('hengshuo-m5-audit-test-') or not args.database.startswith('audit_closure'):parser.error('Capture requires an explicitly isolated audit closure fixture')
    for name in (args.docker_container,args.database,args.db_user):
        if not re.fullmatch(r'[A-Za-z0-9_-]+',name):parser.error('Plain target names required')
    command=['docker','exec','-i',args.docker_container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',args.db_user,'-d',args.database]
    contract=generate(command,args.runtime_role);args.output.write_text(json.dumps(contract,ensure_ascii=False,indent=2)+'\n')
if __name__=='__main__':main()
