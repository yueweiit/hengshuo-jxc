import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

const cell=value=>String(value??'未记录').replaceAll('|','\\|').replaceAll('\n','<br>');
export function writeReport(e){
 const r=e.run,counts={};
 for(const step of r.steps)counts[step.status]=(counts[step.status]??0)+1;
 const logins=Object.entries(r.checks).filter(([key,value])=>key.startsWith('login:')&&value.status==='PASS').length;
 const documents=Object.entries(r.documents).filter(([,value])=>value?.docNo);
 const text=[
  '# MXN页面自动化实际结果',
  `Run：${r.id}。状态：${r.status}。生成时间：${new Date().toISOString()}。`,
  `隔离目标：jxc_test_ai09，前端15199、后端18099。实际浏览器执行记录：${e.prep.browserUsed===true?'有':'未验证'}。workers=1、retries=0。`,
  `检查点统计：${JSON.stringify(counts)}。本轮已验证页面登录${logins}岗；同会话换岗：${r.checks.sameSessionSwitch?.status??'未验证'}。PREVIOUS_RUN只表示引用前轮，不计本轮通过。`,
  '\n| 步骤 | 状态 | 岗位 |\n|---|---|---|',
  ...r.steps.map(step=>`| ${cell(step.id)} | ${cell(step.status)} | ${cell(step.evidence?.role??step.error?.role)} |`),
  '\n| 类型 | 单号 | ID |\n|---|---|---|',
  ...documents.map(([kind,value])=>`| ${cell(kind)} | ${cell(value.docNo)} | ${cell(value.id)} |`),
  '\n实际问题记录：',
  ...r.issues.map(issue=>`- 步骤${cell(issue.step)}，${cell(issue.classification)}，岗位${cell(issue.role)}：${cell(issue.message)}。页面：${cell(issue.url)}；截图：${cell(issue.screenshot)}。`),
  r.issues.length===0?'当前run没有记录问题；未执行步骤仍保持未执行状态。':'问题原始事实见issues/与responses.jsonl，不能以本报告替代原始响应。',
  `\n源码提交：${e.prep.sourceCommit??'未记录'}；测试提交：${e.prep.testCommit??'未记录'}；后端JAR SHA256：${e.prep.backendJarSha256??'未记录'}；前端源指纹：${e.prep.frontendSourceSha256??'未记录'}；实际dist指纹：${e.prep.frontendDistSha256??'未记录'}。`,
  r.continuation?`引用前轮：${cell(r.continuation.parentRunId)}；本轮起点：${cell(r.continuation.fromStep)}。`:'本run从第一步开始，未将分段历史状态改为本轮通过。',
  '\n数量金额、来源行与财务核对见checkpoints/及本run实际生成的快照。API/隔离集成测试、页面执行和人工体验验收分别报告；此报告不继承历史回归、备份、部署或验收结论。'
 ].join('\n\n');
 writeFileSync(join(e.dir,'summary.md'),text,'utf8');
 return counts;
}
