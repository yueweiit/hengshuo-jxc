#!/usr/bin/env python3
"""Prepare and record the ORIGINAL A01-A38 real-browser workload for two countries.

This helper performs no HTTP/SQL or business writes. CUA/the operator performs each
page action. API/SQL preparation is recorded in a separate layer and cannot pass a
browser case. Evidence paths must exist; pass requires actor, page, business/voucher
references (explicit N/A allowed), closing quantity/amount and an actual capture.
"""
from pathlib import Path
import argparse,datetime as dt,hashlib,json,tempfile,os,fcntl
from urllib.parse import urlparse
ROOT=Path(__file__).resolve().parents[4]
MATRIX=ROOT/'docs/backend/evidence/closure-acceptance.json'

CASE_ORDER=['A33','A35','A06','A13','A34','A09','A15','A30','A01','A02','A03','A04','A05','A07','A08','A10','A11','A12','A14','A16','A17','A18','A19','A20','A21','A22','A23','A24','A25','A26','A27','A28','A29','A31','A32','A36','A37','A38']
SECOND_CORE={'A01','A02','A04','A07','A08','A10','A11','A12','A17','A24','A26','A28'}
SECOND_ONLY={'A35','A36','A38'}
def case_assignments():
 return [(country,key) for key in CASE_ORDER for country in (['SECOND'] if key in SECOND_ONLY else ['MX','SECOND'] if key in SECOND_CORE else ['MX'])]

def read(path):return json.loads(Path(path).read_text())
def save(path,value):
 path=Path(path);temporary=path.with_suffix(path.suffix+'.tmp');temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n');temporary.chmod(0o600);os.replace(temporary,path)
def now():return dt.datetime.now(dt.timezone.utc).isoformat()

def frontend_source_sha(root=ROOT):
 # Browser acceptance uses Vite's actual source tree; the same frozen source is built for container proof.
 web=Path(root)/'jxc-web'
 paths=list((web/'src').rglob('*'))+list(web.glob('.env*'))+[web/name for name in ('package.json','package-lock.json','index.html','vite.config.ts','tsconfig.json','tsconfig.app.json')]
 files={str(path.relative_to(web)):hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(set(paths)) if path.is_file()}
 return hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def actual_capture(path):
 path=Path(path)
 if not path.is_file():return False
 with path.open('rb') as stream:
  head=stream.read(32)
  if path.suffix.lower()=='.png':
   if len(head)<24 or head[:8]!=b'\x89PNG\r\n\x1a\n' or head[12:16]!=b'IHDR':return False
   stream.seek(-12,2);return stream.read()==b'\x00\x00\x00\x00IEND\xaeB`\x82'
  if path.suffix.lower() in ('.jpg','.jpeg'):
   if not head.startswith(b'\xff\xd8\xff'):return False
   stream.seek(-2,2);return stream.read()==b'\xff\xd9'
 return False

def validate_browser_record(run,record,current_jar,frontend_root=ROOT,*,country):
 """Rechecked by the release verifier; labels and API/SQL logs alone are insufficient."""
 for key in ('operator','page','documentNumbers','voucherNumbers','closingQuantity','closingAmount','notes'):
  if not isinstance(record.get(key),str) or not record[key].strip():raise ValueError('Actual browser result requires '+key+' (explicit N/A with reason is allowed)')
 page=urlparse(record['page']);base=urlparse(run.get('browserBaseUrl') or '')
 local={'localhost','127.0.0.1'}
 same_host=page.hostname==base.hostname or page.hostname in local and base.hostname in local
 if page.scheme not in ('http','https') or page.scheme!=base.scheme or not same_host or page.port!=base.port or page.username or page.password:raise ValueError('Actual page must belong to this browser acceptance environment')
 expected_country=run.get('countries',{}).get(country,{}).get('countryId')
 if type(expected_country) is not int or expected_country<1 or type(record.get('executionCountryId')) is not int or record['executionCountryId']!=expected_country:raise ValueError('Browser execution country changed or was not recorded; revalidate the original country page')
 if record.get('executionJarSha256')!=current_jar or run.get('jarSha256')!=current_jar:raise ValueError('Browser runtime changed; revalidate against the current candidate before passing')
 if record.get('frontendSourceSha256')!=frontend_source_sha(frontend_root):raise ValueError('Frontend source changed; revalidate the current original page before passing')
 if not any(actual_capture(item['path']) for item in record.get('evidence',[])):raise ValueError('Browser pass requires an actual PNG/JPEG page capture; API/SQL preparation is supplemental only')

def main():
 p=argparse.ArgumentParser(description=__doc__);commands=p.add_subparsers(dest='command',required=True)
 init=commands.add_parser('init');init.add_argument('--runtime',type=Path,default=ROOT/'docs/backend/evidence/release-ui-runtime.json');init.add_argument('--directory',type=Path)
 for name in ['next','record','prepare','summary','bind-country']:
  q=commands.add_parser(name);q.add_argument('--run',type=Path,required=True)
  if name in ['next','record','bind-country']:q.add_argument('--country',choices=['MX','SECOND'],required=True)
  if name=='record':
   q.add_argument('--case',required=True);q.add_argument('--result',choices=['passed','failed','blocked'],required=True);q.add_argument('--operator',required=True);q.add_argument('--page',required=True);q.add_argument('--documents',required=True);q.add_argument('--vouchers',required=True);q.add_argument('--closing-quantity',required=True);q.add_argument('--closing-amount',required=True);q.add_argument('--evidence',type=Path,action='append',default=[]);q.add_argument('--notes',required=True)
  if name=='bind-country':
   q.add_argument('--id',type=int,required=True);q.add_argument('--currency',required=True);q.add_argument('--timezone',required=True)
  if name=='prepare':q.add_argument('--layer',choices=['SQL_PREPARATION','API_PREPARATION'],required=True);q.add_argument('--description',required=True);q.add_argument('--references',default='')
 a=p.parse_args()
 if a.command=='init':
  runtime=read(a.runtime);matrix=read(MATRIX);directory=a.directory or Path(tempfile.mkdtemp(prefix='hengshuo-closure-browser-'));directory.mkdir(exist_ok=True);directory.chmod(0o700)
  cases={x['id']:x for x in matrix['items']};plan=[]
  for country,key in case_assignments():
   item=cases[key];plan.append({'country':country,'id':key,'title':item['title'],'pages':item['pages'],'originalRule':item['source']['acceptance'],'actions':item['browser']['steps'],'status':'not_executed','records':[]})
  run={'schemaVersion':1,'createdAt':now(),'runtimeEvidence':str(a.runtime.resolve()),'jarSha256':runtime['jarSha256'],'browserBaseUrl':None,'productionDeployment':False,'mockDisabled':False,'mockEvidence':[],'countries':{'MX':{'countryId':runtime['foundation']['countryId'],'currency':'MXN','timezone':'America/Mexico_City'},'SECOND':{'countryId':None,'currency':None,'timezone':None,'mustCreateUsingOriginalCountryClonePage':True}},'preparation':[{'layer':'FOUNDATION_SETUP','reference':str(a.runtime.resolve()),'browserAcceptance':False}],'businessInputs':{'sharedScenario':'Use the same native pages in both countries; use locally configured currency/timezone and exact current IDs.','productCodes':['UI-SKU-A','UI-SKU-B'],'customerCodes':['UI-CASH','UI-CREDIT'],'supplierCode':'UI-SUPPLIER','carrierCode':'UI-CARRIER','purchaseCurrency':'CNY','seaDispatchQty':50,'seaReceiptQty':48,'seaShortageQty':2,'airDispatchQty':10,'salesOrderQty':20,'partialOutboundQty':8,'remainingQty':12,'allocation':'Full assignment required. Two warehouses split exact total. Approved unassigned=0.','opening':'Explicit parent-established synthetic fixture, not inferred operational data. Cutoff2026-09-30 and first period2026-10. SKU-A qty10 x local unitCost10=100; UI-OPEN AR200/advance30; UI-OPEN-SUP AP150/prepay40. GL independent fixed DrInventory100+AR200+Prepay40 and CrAP150+Advance30+Equity160, totals340. Same explicit inputs both countries using each local base currency. A01/A04 compare stock increments against opening10.'},'businessInputsAreNotCreated':True,'originalCaseCount':38,'secondCountryCoreCaseCount':len(SECOND_CORE),'cases':plan}
  path=directory/'browser-run.json';save(path,run)
  notes=['# 实际页面执行顺序','', '本目录只准备动作，不生成业务事实。先通过设置页补齐编号、期间、计价、审批、主档、账户与映射；所有 API/SQL 准备必须用 prepare 单独记录。每次 passed 必须引用实际页面截图/下载物、操作者、单据/凭证与期末数量金额。未执行不能用测试、Mock 或 API 结果填补。','', '共享数量：海运派送50/实收48/短缺2；另空运10；销售订单20/分批出库8/未交12。分仓必须严格守恒；未分配列正常为0。先记录各阶段原币/本位币金额与数量，不让后续退货/调拨覆盖前序验收证据。','']
  for row in plan:notes += [f"## {row['country']} {row['id']} {row['title']}",'',f"页面：{'、'.join(row['pages'])}",'', ' → '.join(row['actions']),'',f"验收：{row['originalRule']}",'']
  (directory/'actions.md').write_text('\n'.join(notes));print(json.dumps({'run':str(path),'actions':str(directory/'actions.md'),'plannedCountryCases':len(plan),'businessWrites':0},ensure_ascii=False));return
 lock=Path(str(a.run)+'.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX)
 run=read(a.run)
 if a.command=='bind-country':
  if a.id<1 or len(a.currency)!=3:raise ValueError('Use actual positive country ID and configured currency')
  __import__('zoneinfo').ZoneInfo(a.timezone)
  identity={'countryId':a.id,'currency':a.currency,'timezone':a.timezone}
  if any(row.get('country')==a.country and row.get('records') for row in run['cases']) and any(run['countries'][a.country].get(key)!=value for key,value in identity.items()):raise ValueError('Country identity has recorded browser history; retain it and start a new run for a different country')
  run['countries'][a.country].update(identity);save(a.run,run);print('Bound actual UI-created country metadata only.');return
 if a.command=='next':
  row=next((x for x in run['cases'] if x['country']==a.country and x['status']!='passed'),None);print(json.dumps(row,ensure_ascii=False,indent=2));return
 if a.command=='prepare':run['preparation'].append({'at':now(),'layer':a.layer,'description':a.description,'references':a.references,'browserAcceptance':False});save(a.run,run);print('Recorded setup separately; no browser case changed.');return
 if a.command=='record':
  row=next((x for x in run['cases'] if x['country']==a.country and x['id']==a.case),None)
  if row is None:raise ValueError('Unknown original acceptance case')
  evidence=[]
  for path in a.evidence:
   path=path.resolve()
   if not path.is_file():raise ValueError('Evidence must be an existing real capture or downloaded artifact')
   evidence.append({'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
  runtime=read(run['runtimeEvidence']);current_jar=runtime['jarSha256']
  record={'at':now(),'layer':'BROWSER_UI','result':a.result,'operator':a.operator,'page':a.page,'documentNumbers':a.documents,'voucherNumbers':a.vouchers,'closingQuantity':a.closing_quantity,'closingAmount':a.closing_amount,'notes':a.notes,'evidence':evidence,'operatorAttestsOriginalPageActions':True,'executionJarSha256':current_jar,'executionCountryId':run.get('countries',{}).get(a.country,{}).get('countryId'),'frontendSourceSha256':frontend_source_sha()}
  if a.result=='passed':validate_browser_record(run,record,current_jar,country=a.country)
  row['records'].append(record);row['status']=a.result;save(a.run,run)
 counts={country:{status:sum(x['country']==country and x['status']==status for x in run['cases']) for status in ['not_executed','passed','failed','blocked']} for country in ['MX','SECOND']}
 print(json.dumps({'countries':counts,'productionDeployment':False,'allOriginalBrowserCasesPassed':all(x['status']=='passed' for x in run['cases']),'preparationNeverCountsAsBrowser':True},ensure_ascii=False,indent=2))
if __name__=='__main__':main()
