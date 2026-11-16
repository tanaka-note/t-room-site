import assert from 'node:assert/strict';
import {test} from 'node:test';
import {boundedMaintenanceInventory} from '../../e2ee/maintenance.mjs';
import {encode} from '../../e2ee/crypto.mjs';

test('maintenance budgets include both arrays, separators and UTF-8 bytes across arbitrary page boundaries',()=>{
  const rows={records:[{id:'本文',value:'写真📷'},{id:'2',value:'é'}],media:[{id:'写真',value:'合成データ'}]};
  const exact=encode(rows).length,bounded=boundedMaintenanceInventory(exact);
  bounded.append('records',rows.records.slice(0,1));bounded.append('media',rows.media);
  assert.equal(bounded.append('records',rows.records.slice(1)),exact);
  assert.deepEqual(bounded.rows,rows);
  assert.throws(()=>bounded.append('media',[{id:'overflow'}]),/MaintenanceBudgetExceeded/);
  const tooSmall=boundedMaintenanceInventory(exact-1,'RotationSourceBudgetExceeded');
  tooSmall.append('records',rows.records);
  assert.throws(()=>tooSmall.append('media',rows.media),/RotationSourceBudgetExceeded/);
});

test('22,000 media rows are budgeted with linear row visits instead of repeatedly traversing every earlier page',()=>{
  const count=22000,bounded=boundedMaintenanceInventory(100_000_000);let visits=0;
  const media=Array.from({length:count},(_,index)=>new Proxy({id:String(index),metadata:'x'.repeat(1024)},{ownKeys(value){visits++;return Reflect.ownKeys(value);}}));
  for(let offset=0;offset<count;offset+=20)bounded.append('media',media.slice(offset,offset+20));
  assert.equal(bounded.rows.media.length,count);assert.ok(visits<=count*2,`row visits must stay linear: ${visits}`);
  assert.equal(bounded.append('media',[]),encode(bounded.rows).length);
});
