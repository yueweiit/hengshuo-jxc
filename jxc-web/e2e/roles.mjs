import assert from 'node:assert/strict';
import { join } from 'node:path';
import { load,save,credentialFile } from './preflight.mjs';
export const roleNames=['admin','sales_a','sales_b','manager_a','manager_b','buyer','purchase_manager','logistics','warehouse_a','warehouse_b','cashier','accountant','fin_reviewer'];
export class Roles {
 constructor(browser,evidence){this.browser=browser;this.evidence=evidence;this.credentials=load(credentialFile);this.sessions=new Map();}
 async login(page,role){
  const username='ai09_'+role,credential=this.credentials.find(item=>item.username===username);assert.ok(credential,'缺少岗位凭据：'+username);
  await page.goto('http://127.0.0.1:15199/login');await page.locator('#login-language').selectOption('zh-CN');await page.locator('#account').fill(username);await page.locator('#password').fill(credential.password);
  const mePromise=page.waitForResponse(response=>response.url().includes('/api/v1/auth/me')&&response.request().method()==='GET');
  await page.locator('button[type=submit]').click();const meResponse=await mePromise;const me=(await meResponse.json()).data;
  assert.equal(me.user.username,username);assert.equal(me.currentCountryId,this.evidence.prep.countryId);await page.waitForURL(url=>url.pathname!=='/login');
  const facts={username,userId:me.user.id,countryId:me.currentCountryId,permissions:me.permissions,displayName:me.user.displayName};
  this.evidence.run.checks['login:'+role]={status:'PASS',...facts};this.evidence.save();return facts;
 }
 async get(role){
  if(this.sessions.has(role))return this.sessions.get(role);
  const context=await this.browser.newContext({viewport:{width:1500,height:1000},locale:'zh-CN',timezoneId:'America/Mexico_City',acceptDownloads:true});
  const page=await context.newPage();page.setDefaultTimeout(15000);await this.login(page,role);this.evidence.prep.browserUsed=true;save(join(this.evidence.dir,'preparation.json'),this.evidence.prep);
  page.on('response',async response=>{const path=new URL(response.url()).pathname,method=response.request().method();if(!path.startsWith('/api/v1/')||path.startsWith('/api/v1/auth/'))return;if(method==='GET'&&response.status()<400)return;try{this.evidence.response(role,path,method,response.status(),await response.json());}catch{/* Binary download responses are verified separately by content hash. */}});
  this.sessions.set(role,page);await this.evidence.shot(page,'login-'+role);return page;
 }
 async close(role){const page=this.sessions.get(role);if(page){await page.context().close();this.sessions.delete(role);}}
 async verifyAll(){for(const role of roleNames){if(this.evidence.run.checks['login:'+role]?.status==='PASS')continue;await this.get(role);console.log('UI_LOGIN_PASS '+role);await this.close(role);}}
 async relogin(role){const page=await this.get(role);await page.locator('.header .el-dropdown').last().getByRole('button').click();await page.getByRole('menuitem',{name:'退出登录',exact:true}).click();await page.waitForURL(url=>url.pathname==='/login');await this.login(page,role);return page;}
 async switchSameSession(){const page=await this.get('sales_a');await page.locator('.header .el-dropdown').last().getByRole('button').click();await page.getByRole('menuitem',{name:'退出登录',exact:true}).click();await page.waitForURL(url=>url.pathname==='/login');await this.login(page,'sales_b');await this.evidence.shot(page,'same-session-sales-b');await page.locator('.header .el-dropdown').last().getByRole('button').click();await page.getByRole('menuitem',{name:'退出登录',exact:true}).click();await page.waitForURL(url=>url.pathname==='/login');await this.login(page,'sales_a');this.evidence.run.checks.sameSessionSwitch={status:'PASS',sequence:['sales_a','logout','sales_b','logout','sales_a']};this.evidence.save();}
}
