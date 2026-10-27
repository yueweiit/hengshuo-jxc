import assert from 'node:assert/strict';

// Resolve native configuration by its unique test identity, never by sequence IDs.
export const fixtureIdentities=[
 ['countries','code','MX','countryId'],['books','code','AI09-B01','bookId'],
 ['stores','code','AI09-STORE-A','storeA'],
 ['warehouses','code','AI09-WH-A','warehouseA'],['warehouses','code','AI09-WH-B','warehouseB'],
 ['products','product_code','AI09-A-M','productId'],
 ['customers','code','AI09-A-CASH','customerId'],['customers','code','AI09-A-CREDIT','creditCustomerId'],
 ['users','username','ai09_manager_a','managerAId'],['users','username','ai09_warehouse_a','warehouseAUserId'],['users','username','ai09_accountant','accountantId'],['users','username','ai09_fin_reviewer','reviewerId'],
 ['fundAccounts','name','AI09主体比索银行','bankAccountId'],
 ['financeAccounts','code','1002','bankGlAccountId'],['financeAccounts','code','1405','inventoryGlAccountId'],
 ['financeAccounts','code','6001','revenueGlAccountId'],['financeAccounts','code','6401','cogsGlAccountId'],
];
export function validateFixtureIdentity(inventory){
 const resolved={};
 for(const [table,field,value,key] of fixtureIdentities){
  assert.ok(Array.isArray(inventory[table]),'缺少配置清单：'+table);
  const rows=inventory[table].filter(row=>row[field]===value);
  assert.equal(rows.length,1,`必须唯一识别配置：${table}.${field}=${value}`);
  assert.ok(Number.isSafeInteger(rows[0].id)&&rows[0].id>0,`原生配置编号无效：${table}.${field}=${value}`);
  resolved[key]=rows[0].id;
 }
 const periods=inventory.periods.filter(row=>row.book_id===resolved.bookId&&row.fiscal_year===2026&&row.period_no===10);
 assert.equal(periods.length,1,'必须唯一识别本组业务期间');
 assert.ok(Number.isSafeInteger(periods[0].id)&&periods[0].id>0,'业务期间编号无效');
 const actorIds={};
 for(const row of inventory.users){
  assert.ok(row.username.startsWith('ai09_'),'禁止混入非本组岗位');
  actorIds[row.username.slice(5)]=row.id;
 }
 return {...resolved,periodId:periods[0].id,actorIds};
}
