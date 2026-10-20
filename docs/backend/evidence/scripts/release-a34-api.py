#!/usr/bin/env python3
"""Read-only native A34 API controls in the explicitly isolated UI fixture.

The one login creates authentication metadata only. No business POST, export job,
import confirmation, AI invocation, identity or grant is created. This evidence
cannot record or pass a browser acceptance case.
"""
from pathlib import Path
import argparse,datetime as dt,hashlib,json,os,stat,urllib.request,urllib.error,urllib.parse

ROOT=Path(__file__).resolve().parents[4]
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--credentials',type=Path,required=True)
 p.add_argument('--runtime',type=Path,default=ROOT/'docs/backend/evidence/release-ui-runtime.json')
 p.add_argument('--expected-jar-sha256',required=True)
 p.add_argument('--output',type=Path,default=ROOT/'docs/backend/evidence/release-a34-api-candidate.json')
 p.add_argument('--final',action='store_true')
 a=p.parse_args();runtime=json.loads(a.runtime.read_text())
 if runtime.get('jarSha256')!=a.expected_jar_sha256:raise ValueError('Expected actual UI runtime jar must match its execution metadata')
 if runtime.get('productionDeployment') is not False or runtime.get('originalM4M5Touched') is not False or not runtime.get('database','').startswith('jxc_closure_ui_'):raise ValueError('Only the existing isolated synthetic UI runtime is authorized')
 parsed=urllib.parse.urlsplit(runtime['api'])
 if parsed.scheme!='http' or parsed.hostname not in ('127.0.0.1','localhost') or parsed.port!=18100 or parsed.username or parsed.password:raise ValueError('Exact local UI API required')
 file=a.credentials
 if file.is_symlink() or file.resolve().is_relative_to(ROOT) or file.stat().st_uid!=os.getuid() or stat.S_IMODE(file.stat().st_mode)!=0o600:raise ValueError('Operator-owned private 0600 credential file outside workspace required')
 actor=json.loads(file.read_text())['mx_country_admin']
 if actor['userId']!=366 or runtime['foundation']['countryId']!=3 or runtime['foundation']['bookId']!=6:raise ValueError('The approved MX-only subject and fixture identity changed')
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):return None
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect());token=None;cases=[]
 def request(path,country=None,body=None):
  headers={'Content-Type':'application/json'}
  if token:headers['Authorization']='Bearer '+token
  if country is not None:headers['X-Country-Id']=str(country)
  req=urllib.request.Request(runtime['api']+'/api/v1'+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method='GET' if body is None else 'POST')
  try:
   with opener.open(req,timeout=20) as response:status=response.status;raw=response.read()
  except urllib.error.HTTPError as error:status=error.code;raw=error.read()
  result=json.loads(raw)
  return status,result
 def check(name,path,country,expected,predicate=None):
  status,result=request(path,country);data=result.get('data')
  passed=status==expected and (result.get('code')=='OK' if expected==200 else result.get('code') in ('NOT_FOUND','SYS_FORBIDDEN') and data is None)
  if predicate is not None:passed=passed and predicate(data)
  cases.append({'case':name,'method':'GET','path':path,'countryHeader':country,'expectedStatus':expected,'actualStatus':status,'code':result.get('code'),'businessDataReturned':data is not None,'status':'passed' if passed else 'failed'})
  if not passed:raise AssertionError('Native API control failed: '+name+' HTTP '+str(status)+' code '+str(result.get('code')))
  return data
 evidence={'schemaVersion':1,'channel':'API_NEGATIVE_AND_POSITIVE_CONTROLS','uiAcceptance':False,'browserPassRecorded':False,'candidateOnly':not a.final,'productionDeployment':False,'businessWrites':0,'technicalLoginMetadataCreated':True,'jarSha256':a.expected_jar_sha256,'runtimeEvidenceSha256':sha(a.runtime),'subjectId':366,'authorizedCountryId':3,'deniedCountryId':183,'cases':cases}
 try:
  status,result=request('/auth/login',body={'username':actor['username'],'password':actor['password']})
  if status!=200 or result.get('code')!='OK':raise AssertionError('Approved synthetic actor login failed')
  token=result['data']['token']
  check('MX_ONLY_IDENTITY','/auth/me?countryId=3',3,200,lambda d:d['user']['id']==366 and d['user']['isPlatformAdmin'] is False and [row['id'] for row in d['countries']]==[3])
  check('MX_NATIVE_AP_EXISTS','/ap/bills/163',3,200,lambda d:d['id']==163 and d['countryId']==3)
  check('MX_NATIVE_STORE_EXISTS','/org/stores/11',3,200,lambda d:d['id']==11 and d['countryId']==3)
  check('MX_BOOK_REFERENCE_EXISTS','/org/books',3,200,lambda d:any(row['id']==6 for row in d) and all(row['countryId']==3 for row in d))
  check('CN_REAL_SALES_ID_DENIED','/sal/orders/1405',3,404)
  check('CN_REAL_PURCHASE_ID_DENIED','/pur/orders/1374',3,404)
  check('CN_REAL_ATTACHMENT_CONTENT_DENIED','/sys/attachments/1581/content?bizType=AR_RECEIPT&bizId=1573&category=PAYMENT_PROOF&linkVersion=1&sha256=1010da9591aecd8514a569471fab0acbc51cce13dcad3b40cc0dd2a4c3ff480e',3,404)
  check('CN_AP_ID_DENIED','/ap/bills/375',3,404)
  check('CN_PREPAY_ID_DENIED','/ap/prepayments/383',3,404)
  check('CN_CUSTOMER_ID_DENIED','/md/customers/296',3,404)
  check('CN_BOOK_ID_DENIED','/fin/accounts?bookId=194',3,404)
  check('CN_REAL_REPORT_JOB_DENIED','/sys/jobs/1111',3,404)
  check('CN_REAL_REPORT_DOWNLOAD_DENIED','/sys/jobs/1111/download',3,404)
  check('CN_REAL_INCOME_REPORT_DENIED','/fin/reports/INCOME?bookId=194&periodId=256',3,404)
  for name,path in [('ORDINARY','/ap/bills'),('IMPORTS','/sys/imports'),('REPORT','/fin/reports/BALANCE_SHEET?bookId=6'),('AI_HISTORY','/ai/history')]:
   check('MX_REGISTERED_'+name,path,3,200)
   check('CN_COUNTRY_HEADER_'+name+'_DENIED',path,183,403)
  evidence.update(status='passed',knownCnResourceReferences={'apBill':375,'prepayment':383,'customer':296,'book':194,'incomePeriod':256,'successfulUiExportJob':1111,'attachmentId':1581,'attachmentReference':{'bizType':'AR_RECEIPT','bizId':1573,'category':'PAYMENT_PROOF','linkVersion':1,'metadataReadOnlyVerified':True},'exportExistenceEvidence':'Finance owner created SUCCESS CN export through original UI and downloaded ACCOUNT_MAP_V1 CNY income report; closure-finance-cn-report-export.jpg','existenceEvidence':'Parent-established actual CN UI/native resource references; this MX-only actor does not gain CN authority'},completedAt=dt.datetime.now(dt.timezone.utc).isoformat(),scriptSha256=sha(__file__))
 except BaseException as error:
  evidence.update(status='failed',error=str(error));raise
 finally:
  a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
  print(json.dumps({'status':evidence['status'],'controls':len(cases),'candidateOnly':evidence['candidateOnly'],'uiAcceptance':False,'browserPassRecorded':False,'output':str(a.output)},ensure_ascii=False))

if __name__=='__main__':main()
