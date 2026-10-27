import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureIdentities,validateFixtureIdentity} from './fixture-identity.mjs';
const configured=()=>{
 const inventory={periods:[{id:18,book_id:6,fiscal_year:2026,period_no:10}]};
 for(const [table,field,value,id] of fixtureIdentities)(inventory[table]??=[]).push({id,[field]:value});
 return inventory;
};
test('native configuration identities must match every archived oracle before business writes',()=>{
 assert.equal(validateFixtureIdentity(configured()),true);
 for(const table of ['products','users','books','fundAccounts']){
  const inventory=configured();inventory[table][0].id+=10000;
  assert.throws(()=>validateFixtureIdentity(inventory),/原生配置ID已变化/);
 }
});
test('ambiguous or missing identities are explicit failures, never a guessed first record',()=>{
 const duplicate=configured();duplicate.products.push({...duplicate.products[0]});
 assert.throws(()=>validateFixtureIdentity(duplicate),/必须唯一识别配置/);
 const missing=configured();missing.periods=[];
 assert.throws(()=>validateFixtureIdentity(missing),/必须唯一识别本组业务期间/);
});
