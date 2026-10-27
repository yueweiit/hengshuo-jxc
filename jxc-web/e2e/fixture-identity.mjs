import assert from 'node:assert/strict';

// This archived driver uses these IDs in its original read-only oracles. Verify
// their actual native configuration before issuing any business command.
export const fixtureIdentities=[
 ['countries','code','MX',3],['books','code','AI09-B01',6],
 ['stores','code','AI09-STORE-A',23],
 ['warehouses','code','AI09-WH-A',26],['warehouses','code','AI09-WH-B',33],
 ['products','product_code','AI09-A-M',132],
 ['customers','code','AI09-A-CASH',167],['customers','code','AI09-A-CREDIT',172],
 ['users','username','ai09_manager_a',70],['users','username','ai09_warehouse_a',95],['users','username','ai09_accountant',110],['users','username','ai09_fin_reviewer',115],
 ['fundAccounts','name','AI09主体比索银行',401],
 ['financeAccounts','code','1002',350],['financeAccounts','code','1405',362],
 ['financeAccounts','code','6001',377],['financeAccounts','code','6401',380],
];
export function validateFixtureIdentity(inventory){
 for(const [table,field,value,id] of fixtureIdentities){
  assert.ok(Array.isArray(inventory[table]),'缺少配置清单：'+table);
  const rows=inventory[table].filter(row=>row[field]===value);
  assert.equal(rows.length,1,`必须唯一识别配置：${table}.${field}=${value}`);
  assert.equal(rows[0].id,id,`原生配置ID已变化，先适配驱动，禁止强制改库：${table}.${field}=${value}`);
 }
 const periods=inventory.periods.filter(row=>row.book_id===6&&row.fiscal_year===2026&&row.period_no===10);
 assert.equal(periods.length,1,'必须唯一识别本组业务期间');
 assert.equal(periods[0].id,18,'业务期间ID已变化，先适配驱动');
 return true;
}
