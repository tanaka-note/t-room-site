import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyData,defaultCategories,orderedCategories,mutateData,backup,restoreInput,csv} from '../src/domain.js';
await import('../public/asset-chart.js');
const chart=globalThis.TRoomAssetChart;

test('category display order matches ME without renumbering IDs or losing legacy categories',()=>{
  const categories=defaultCategories();
  assert.deepEqual([...new Set(orderedCategories([...categories].reverse()).map(c=>c.parent))],['収入','食費','現金・カード','交通費','趣味・娯楽','日用品','衣服・美容','特別な支出','交際費','住宅','水道・光熱費','自動車','保険','税・社会保障','教養・教育','通信費','健康・医療','その他','未分類']);
  assert.equal(categories.find(c=>c.parent==='日用品').id,'builtin-2-0');
  assert.equal(categories.find(c=>c.parent==='未分類').id,'builtin-18-0');
  assert.deepEqual(restoreInput(backup(emptyData())),emptyData());
});

test('new income and expense records are included and independent from account selection; legacy backups retain their meaning',()=>{
  const data=emptyData(),category=data.categories.find(c=>c.type==='expense');
  const entry={id:crypto.randomUUID(),date:'2026-09-01',type:'expense',categoryId:category.id,amount:1234,description:'Synthetic',included:false};
  const next=mutateData(data,'transaction.save',entry);
  assert.equal(next.transactions[0].included,true);assert.equal(next.transactions[0].accountId,null);assert.equal(next.transactions[0].toAccountId,null);
  assert.throws(()=>mutateData(data,'transaction.save',{...entry,type:'transfer'}),{status:400});
  const uncategorized=mutateData(data,'transaction.save',{...entry,categoryId:'builtin-18-0'});
  assert.equal(uncategorized.transactions[0].categoryId,data.categories.find(c=>c.parent==='その他'&&c.name==='その他').id);
  const legacy=backup({...data,transactions:[entry]});assert.equal(restoreInput(legacy).transactions[0].included,false);
  assert.match(csv(restoreInput(legacy)),/"1","2026-09-01"/);
});

test('reordering account items persists stable IDs and amounts without changing prior dates or household transactions',()=>{
  const row={id:crypto.randomUUID(),name:'Synthetic bank',type:'bank',items:[{id:crypto.randomUUID(),name:'A',amount:100},{id:crypto.randomUUID(),name:'B',amount:-25}]};
  const data=mutateData(emptyData(),'account.save',{...row,asOf:'2026-09-01'});
  const next=mutateData(data,'account.save',{...data.accounts[0],asOf:'2026-09-30',items:[...row.items].reverse()});
  assert.deepEqual(next.accounts[0].items,[...row.items].reverse());
  assert.deepEqual(next.accounts[0].balances[0].items,row.items);
  assert.equal(next.accounts[0].items.reduce((s,i)=>s+i.amount,0),75);
  assert.deepEqual(next.transactions,data.transactions);assert.deepEqual(restoreInput(backup(next)),next);
});

test('comparisons use exact calendar offsets and never fill missing months or confuse zero with missing',()=>{
  const points=Array.from({length:25},(_,i)=>({month:chart.monthAt(chart.monthIndex('2024-09')+i),value:i*100}));
  const selected=points.at(-1);
  for(const [period,offset,label]of [['1',1,'前月末比'],['3',3,'3ヶ月前の月末比'],['6',6,'6ヶ月前の月末比'],['12',12,'1年前の月末比'],['24',24,'2年前の月末比']]){
    const result=chart.periodComparison(points,selected,period,points[0].month);assert.equal(result.value,offset*100);assert.equal(result.label,label);
  }
  assert.equal(chart.periodComparison(points,selected,'all',points[0].month).value,2400);
  assert.equal(chart.periodComparison(points,points[0],'all',points[0].month).value,0);
  assert.equal(chart.periodComparison(points.filter(p=>p.month!=='2026-06'),selected,'3',points[0].month).value,null);
  assert.equal(chart.periodComparison(points,selected,'36',points[0].month).value,null);
});
