import {seal,signed} from './crypto.mjs';
import {proofOf,verifyRecord} from './record.mjs';
import {investmentScope} from './policy.mjs';
export const INVESTMENT_VALUES=Object.freeze(['total','cash','stocks','funds','bonds','crypto','futures','points','other']);
export function investmentHousehold(directory) {
  const households=Object.entries(directory.households).filter(([,config])=>!config.independent);
  if(households.length!==1)throw new Error('InvestmentHouseholdUnavailable');return households[0][0];
}
export function investmentBinding(directory,revision=1) {
  const household=investmentHousehold(directory),scope=investmentScope(household),epoch=directory.epochs[scope];
  if(!epoch)throw new Error('InvestmentScopeMissing');
  return {id:scope,household,scope,state:'investment',author:directory.households[household].owner,revision,epoch,sourceId:null,sourceRevision:null,retainedFor:[],photoIds:[]};
}
export function investmentRecords(rows) {
  if(!Array.isArray(rows)||rows.length>100000)throw new Error('InvalidInvestmentRecords');
  const dates=new Set();
  return rows.map(row=>{
    const date=row.recorded_at??row.date;
    if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||dates.has(date))throw new Error('InvalidInvestmentRecords');
    dates.add(date);const value={date};
    for(const key of INVESTMENT_VALUES){if(!Number.isSafeInteger(row[key])||row[key]<0)throw new Error('InvalidInvestmentRecords');value[key]=row[key];}
    return value;
  }).sort((a,b)=>a.date.localeCompare(b.date));
}
export async function sealInvestment({records,current,directory,key,signingKey,writer}) {
  investmentRecords(records);
  const binding=investmentBinding(directory,(current?.revision||0)+1);
  const row={...binding,keyBox:{},envelope:await seal(key,{version:1,entry:{records}},{...binding,kind:'document'},{format:2}),summary:await seal(key,{}, {...binding,kind:'summary'}),attestation:{writer}};
  row.attestation.signature=(await signed(proofOf(row),signingKey)).signature;
  await verifyRecord(row,directory);return row;
}
export function investmentProposal(row,requestId) {
  return {id:row.id,household:row.household,expectedRevision:row.revision-1,state:row.state,epoch:row.epoch,envelope:row.envelope,summary:row.summary,
    photoIds:[],sourceId:null,sourceRevision:null,keyBox:row.keyBox,attestation:row.attestation,requestId};
}
