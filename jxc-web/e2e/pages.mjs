import { expect } from '@playwright/test';
import { CommandFailure } from './core.mjs';
export const formItem=(root,label)=>root.locator('.el-form-item').filter({has:(typeof root.page==='function'?root.page():root).locator('.el-form-item__label').filter({hasText:new RegExp('^\\s*'+label+'\\s*$')})});
export async function select(page,control,label){await control.click();const option=page.getByRole('option',{name:label,exact:true});await option.click();await expect(option).not.toBeVisible();}
export async function command(page,path,action,{expectedCode='OK'}={}){
 const responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1'+path&&response.request().method()!=='GET');await action();const response=await responsePromise;const body=await response.json();
 if(body.code!==expectedCode)throw new CommandFailure('页面提交返回 '+body.code+'：'+body.message,{path,httpStatus:response.status(),body});return {httpStatus:response.status(),...body};
}
export async function approve(page,docNo,runId,expectedCode='OK'){
 await page.goto('http://127.0.0.1:15199/approval/todo');await page.getByPlaceholder('单号 / 摘要 / 提交人').fill(docNo);await page.getByRole('button',{name:'查询',exact:true}).click();const row=page.locator('.el-table__body tr').filter({hasText:docNo});await expect(row).toHaveCount(1);await row.getByRole('button',{name:'同意',exact:true}).click();const dialog=page.getByRole('dialog',{name:'同意审批',exact:true});await dialog.locator('textarea').fill(runId+' automated approval');
 const pending=page.waitForResponse(response=>/\/wf\/tasks\/\d+\/approve$/.test(new URL(response.url()).pathname));await dialog.getByRole('button',{name:'确认同意',exact:true}).click();const response=await pending,body=await response.json();if(body.code!==expectedCode)throw new CommandFailure('审批实际结果 '+body.code+'：'+body.message,{docNo,httpStatus:response.status(),body});if(expectedCode!=='OK')await expect(dialog.getByRole('alert')).toContainText(body.message);return {expectedCode,httpStatus:response.status(),body};
}
