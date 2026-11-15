import {passkeyTtlSecondsForService} from '../../assets/passkey-calendar-policy.mjs';
export class HttpError extends Error { constructor(status,message,extra={}) { super(message);this.status=status;this.extra=extra; } }
export const CALENDAR_TTL=passkeyTtlSecondsForService('calendar');
export const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const modes=['NONE','DAILY','WEEKLY','MONTHLY','YEARLY','DATES'];
const colors=['blue','green','pink','orange','purple','gray'];
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const fail=message=>{throw new HttpError(400,message);};
const integer=(v,low,high)=>Number.isSafeInteger(v)&&v>=low&&v<=high;
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const datetime=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(v)&&date(v.slice(0,10));
const text=(v,max,required=false)=>typeof v==='string'&&v.length<=max&&(!required||v.trim().length>0);
function fields(v,allowed){if(!object(v)||Object.keys(v).some(k=>!allowed.includes(k)))fail('入力項目を確認してください。');}
function ids(v){return Array.isArray(v)&&v.length<=32&&v.every(i=>idPattern.test(i))&&new Set(v).size===v.length;}
function reminderList(v){return Array.isArray(v)&&v.length<=10&&v.every(n=>integer(n,0,525600))&&new Set(v).size===v.length;}
function reminderKey(key){const [id,anchor,extra]=key.split('@');return idPattern.test(id)&&extra===undefined&&(anchor===undefined||date(anchor));}
export function validatePayload(kind,id,v,depth=0){
  if(!['event','track','tag','settings'].includes(kind)||(kind==='settings'?id!=='preferences':!idPattern.test(id))||!object(v))fail('保存する項目を確認してください。');
  if(kind==='event'){
    if(v.purged===true){fields(v,['id','purged']);if(v.id!==id)fail('予定を確認してください。');return v;}
    fields(v,['id','title','start','end','allDay','trackIds','tagIds','color','place','memo','url','cancelled','deletedAt','repeat','exceptions','excludedDates']);
    if(v.id!==id||!text(v.title,200,true)||!datetime(v.start)||!datetime(v.end)||typeof v.allDay!=='boolean'
      ||!ids(v.trackIds)||!ids(v.tagIds)||!colors.includes(v.color)||!text(v.place,500)||!text(v.memo,20000)||!text(v.url,2048)
      ||(v.url&&!/^https?:\/\//i.test(v.url))||typeof v.cancelled!=='boolean'
      ||(v.deletedAt!==null&&!integer(v.deletedAt,0,8640000000000000)))fail('予定の入力内容を確認してください。');
    const start=Date.parse(v.start+'+09:00'),end=Date.parse(v.end+'+09:00');
    if(!(end>start)||end-start>366*86400000||(v.allDay&&(!/T00:00(?::00)?$/.test(v.start)||!/T00:00(?::00)?$/.test(v.end))))fail('終了日時を開始日時より後にしてください。');
    const r=v.repeat;fields(r,['mode','interval','weekdays','monthly','until','count','dates']);
    if(!modes.includes(r.mode)||!integer(r.interval,1,100)||!Array.isArray(r.weekdays)||r.weekdays.length>7||r.weekdays.some(n=>!integer(n,1,7))
      ||!['DAY','LAST','NTH','LAST_WEEKDAY'].includes(r.monthly)||(r.until!==null&&(!date(r.until)||r.until<v.start.slice(0,10)))
      ||(r.count!==null&&!integer(r.count,1,10000))||!Array.isArray(r.dates)||r.dates.length>512||!r.dates.every(date))fail('繰り返し設定を確認してください。');
    if(r.mode==='WEEKLY'&&!r.weekdays.length)fail('繰り返す曜日を選んでください。');
    if(!Array.isArray(v.excludedDates)||v.excludedDates.length>2048||!v.excludedDates.every(date)||!object(v.exceptions)||Object.keys(v.exceptions).length>2048)fail('繰り返しの例外を確認してください。');
    for(const [anchor,override] of Object.entries(v.exceptions)){
      if(!date(anchor)||depth>0)fail('繰り返しの例外を確認してください。');fields(override,['replacement','cancelled','deleted','deletedAt']);
      if(override.deletedAt!==undefined&&!integer(override.deletedAt,0,8640000000000000))fail('削除日時を確認してください。');
      if(override.cancelled!==undefined&&typeof override.cancelled!=='boolean'||override.deleted!==undefined&&typeof override.deleted!=='boolean')fail('例外の状態を確認してください。');
      if(override.replacement){validatePayload('event',id,override.replacement,depth+1);if(override.replacement.repeat.mode!=='NONE')fail('個別変更は繰り返しなしで保存してください。');}
    }
  }else if(kind==='track'||kind==='tag'){
    fields(v,['id','name','archived','mergedInto','targetDays']);
    if(v.id!==id||!text(v.name,100,true)||typeof v.archived!=='boolean'||v.mergedInto!==null&&(!idPattern.test(v.mergedInto)||v.mergedInto===id)||v.targetDays!==null&&!integer(v.targetDays,1,36500))fail('項目の名前・設定を確認してください。');
    v.name=v.name.trim().normalize('NFC');
  }else{
    fields(v,['theme','startPage','durationMinutes','reminders','eventReminders','pinned','manualOrder','sort','descending','cacheMiB']);
    if(!['blue','mint','lavender'].includes(v.theme)||!['MONTH','WEEK','AGENDA','TRACKS','SETTINGS'].includes(v.startPage)||!integer(v.durationMinutes,1,1440)
      ||!reminderList(v.reminders)||!object(v.eventReminders)||Object.keys(v.eventReminders).length>10000||Object.entries(v.eventReminders).some(([key,value])=>!reminderKey(key)||!reminderList(value))
      ||!Array.isArray(v.pinned)||v.pinned.length>10000||!v.pinned.every(i=>idPattern.test(i))||!Array.isArray(v.manualOrder)||v.manualOrder.length>10000||!v.manualOrder.every(i=>idPattern.test(i))
      ||!['MANUAL','ELAPSED','NAME'].includes(v.sort)||typeof v.descending!=='boolean'||!integer(v.cacheMiB,20,500))fail('設定を確認してください。');
  }
  return v;
}
export function publicEntity(row){return row?{kind:row.kind,id:row.id,payload:JSON.parse(row.payload),version:Number(row.version),purged:row.purged===1}:null;}
export async function jsonBody(request,max=1048576){
  const reader=request.body?.getReader();if(!reader)throw new HttpError(400,'入力内容を確認してください。');
  let size=0;const chunks=[];
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new HttpError(413,'入力内容が大きすぎます。');}chunks.push(value);}
  try{const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const v=JSON.parse(new TextDecoder().decode(bytes));if(!object(v))throw Error();return v;}catch{throw new HttpError(400,'入力内容を確認してください。');}
}
