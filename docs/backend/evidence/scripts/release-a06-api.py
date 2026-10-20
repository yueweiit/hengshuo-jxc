#!/usr/bin/env python3
"""Read-only scope controls for sources created through the original synthetic UI."""
import argparse,json,urllib.request,urllib.error,urllib.parse,hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[4]
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--private-dir',type=Path,required=True)
args=parser.parse_args();private=args.private_dir.resolve()
assert private.is_dir() and not private.is_relative_to(root),'Keep synthetic credentials outside the source workspace'
runtime=json.loads((root/'docs/backend/evidence/release-ui-runtime.json').read_text());assert runtime['productionDeployment'] is False and runtime['database'].startswith('jxc_closure_ui_')
creds=json.loads((private/'credentials.json').read_text());actors=json.loads((private/'business-actor-credentials.json').read_text())
base=creds['api'].rstrip('/')
if not base.endswith('/api/v1'):base+='/api/v1'
assert base.startswith('http://127.0.0.1:18100/')
def call(path,token=None,body=None):
 headers={'Content-Type':'application/json','X-Country-Id':'3'}
 if token:headers['Authorization']='Bearer '+token
 target=base+path
 if path.startswith('/api/v1/'):target=base.removesuffix('/api/v1')+path
 req=urllib.request.Request(target,headers=headers,data=None if body is None else json.dumps(body).encode(),method='GET' if body is None else 'POST')
 try:
  with urllib.request.urlopen(req,timeout=15) as r:
   raw=r.read();return r.status,json.loads(raw) if 'json' in r.headers.get('Content-Type','') else raw
 except urllib.error.HTTPError as e:return e.code,json.load(e)
def login(c):
 status,data=call('/auth/login',body={'username':c['username'],'password':c['password']});assert status==200
 return data['data']['token']
admin=login(creds);status,body=call('/sys/attachments?bizType=SAL_ORDER&bizId=1098&category=SALES_DOC',admin);assert status==200 and len(body['data'])==1
attachment=body['data'][0];aid=attachment['id']
status,result=call(f'/sys/attachments/{aid}/url',admin);assert status==200
u=urllib.parse.urlparse(result['data']['url']);assert u.path==f'/api/v1/sys/attachments/{aid}/content' and not u.netloc
content=u.path+'?'+u.query
checks=[]
for actor in ('shop1','shop2'):
 token=login(actors[actor]);expected=404 if actor=='shop1' else 200
 for path in ('/sal/orders/1098','/md/customers/1089','/sys/attachments?bizType=SAL_ORDER&bizId=1098&category=SALES_DOC',f'/sys/attachments/{aid}/url',content):
  status,result=call(path,token)
  assert status==expected,(actor,path.split('?')[0],status,expected)
  if expected==404:assert result.get('data') is None
  if path==content and expected==200:assert hashlib.sha256(result).hexdigest()==urllib.parse.parse_qs(u.query)['sha256'][0]
  checks.append({'actorUserId':actors[actor]['userId'],'resource':path.split('?')[0],'expectedStatus':expected,'actualStatus':status,'passed':True})
 status,positive=call('/md/customers/93',token)
 assert status==(200 if actor=='shop1' else 404)
 checks.append({'actorUserId':actors[actor]['userId'],'resource':'/md/customers/93','expectedStatus':200 if actor=='shop1' else 404,'actualStatus':status,'passed':True})
evidence={'status':'passed','layer':'API_VALIDATION','browserAcceptance':False,'productionDeployment':False,'jarSha256':runtime['jarSha256'],'originalUiCreatedSources':{'orderId':1098,'customerId':1089,'storeId':150,'warehouseId':151,'attachmentId':aid},'sourceAttachmentIsSynthetic':True,'sameCountryAndRoleDifferentStoreScopes':True,'businessWritesPerformedByThisScript':0,'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'checks':checks}
(root/'docs/backend/evidence/release-a06-scope-api.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'status':'passed','checks':len(checks),'attachmentId':aid,'businessWrites':0}))
