import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureIdentities,validateFixtureIdentity} from './fixture-identity.mjs';
const configured=()=>{
 const inventory={};let id=100;
 for(const [table,field,value] of fixtureIdentities)(inventory[table]??=[]).push({id:++id,[field]:value});
 inventory.periods=[{id:501,book_id:inventory.books[0].id,fiscal_year:2026,period_no:10}];
 return inventory;
};
test('native configuration IDs may change without guessing or rewriting database identities',()=>{
 const original=validateFixtureIdentity(configured());assert.ok(original.productId>0);
 const inventory=configured();inventory.products[0].id=90132;inventory.books[0].id=90006;inventory.periods[0].book_id=90006;
 const changed=validateFixtureIdentity(inventory);
 assert.equal(changed.productId,90132);assert.equal(changed.bookId,90006);assert.equal(changed.bankAccountId,original.bankAccountId);
});
test('ambiguous or missing identities are explicit failures, never a guessed first record',()=>{
 const duplicate=configured();duplicate.products.push({...duplicate.products[0]});
 assert.throws(()=>validateFixtureIdentity(duplicate),/必须唯一识别配置/);
 const missing=configured();missing.periods=[];
 assert.throws(()=>validateFixtureIdentity(missing),/必须唯一识别本组业务期间/);
});
