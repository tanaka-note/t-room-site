import assert from 'node:assert/strict';
import test from 'node:test';
await import('../public/asset-chart.js');
const chart=globalThis.TRoomAssetChart;
const series=Array.from({length:52},(_,i)=>({month:chart.monthAt(chart.monthIndex('2022-06')+i),value:1000000+i*120000}));

test('My Investment calendar ranges include the start boundary and only unlock appropriate periods',()=>{
  const before=structuredClone(series);
  assert.equal(chart.periodPoints(series,'all').length,52);
  for(const [period,count]of [['1',2],['3',4],['6',7],['12',13],['24',25],['36',37],['60',52]])assert.equal(chart.periodPoints(series,period).length,count);
  assert.deepEqual(chart.availablePeriods(series).map(p=>p.key),['1','3','6','12','24','36','60','all']);
  assert.deepEqual(chart.availablePeriods([]).map(p=>p.key),['1','3','all']);
  const missing=series.filter(p=>p.month!=='2026-08');assert.equal(chart.periodPoints(missing,'12').length,12);
  assert.deepEqual(series,before);
});

test('previous month change never substitutes an older record for a missing month or a real zero balance',()=>{
  const points=[{month:'2026-06',value:100},{month:'2026-08',value:0},{month:'2026-09',value:-50}];
  assert.equal(chart.periodComparison(points,points[1],'1',points[0].month).value,null);
  assert.equal(chart.periodComparison(points,points[2],'1',points[0].month).value,-50);
  assert.equal(chart.nearest(points,chart.monthIndex('2026-07')+.8),1);
  assert.equal(chart.nearest(points,chart.monthIndex('2020-01')),0);
});

test('readable axes enclose flat, zero, negative and large monetary values with bounded ticks',()=>{
  for(const values of [[0],[-112000,-180000],[24400000,25000000],[18000000000000],[5,8],[-2,4]]){
    const axis=chart.axis(values);assert.ok(axis.low<=Math.min(...values));assert.ok(axis.high>=Math.max(...values));assert.ok(axis.high>axis.low);assert.ok(axis.ticks.length>0&&axis.ticks.length<=7);assert.ok(axis.ticks.every(t=>Number.isFinite(t)));
  }
  assert.equal(chart.axis([20000000,30000000]).label,'万円');
  assert.ok(chart.axis([-112000]).high<0);
  for(const width of [180,230,330,1000]){
    const ticks=chart.xTicks('2018-02','2026-09',width);assert.equal(ticks[0].index,chart.monthIndex('2018-02'));assert.equal(ticks.at(-1).index,chart.monthIndex('2026-09'));assert.ok(ticks.length<=(width<350?4:7));
  }
});

test('axes closely frame the visible change, including yen differences on large balances',()=>{
  for(const values of [[10000000,11000000],[10000000,10010000],[-11000000,-10000000],[80000000000,80000000001],[1234,1235],[-1,0,1]]){
    const scale=chart.axis(values),min=Math.min(...values),max=Math.max(...values),span=max-min;
    assert.ok(Math.abs((scale.high-scale.low)/span-1.1)<.001);
    assert.ok(scale.low<min&&scale.high>max);
    const labels=scale.ticks.map(scale.format);assert.equal(new Set(labels).size,labels.length);
    for(const [i,tick]of scale.ticks.entries()){
      const unit={'円':1,'万円':1e4,'億円':1e8,'兆円':1e12}[scale.label];
      assert.ok(Math.abs(Number(labels[i].replaceAll(',',''))*unit-tick)<.01);
    }
  }
  assert.deepEqual([chart.axis([10000000,11000000]).low,chart.axis([10000000,11000000]).high],[9950000,11050000]);
  assert.ok(chart.axis([80000000000]).low>0);
});
