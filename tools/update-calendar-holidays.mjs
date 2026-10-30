import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const source='https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
const index=process.argv.indexOf('--source');
const bytes=index>=0?await readFile(process.argv[index+1]):await (async()=>{const response=await fetch(source,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error(`Holiday source HTTP ${response.status}`);return Buffer.from(await response.arrayBuffer());})();
if(bytes.length>1048576)throw Error('Unexpected holiday source size');
const holidays={};
for(const line of new TextDecoder('shift_jis').decode(bytes).split(/\r?\n/)){
  const row=line.match(/^"?(\d{4})[/-](\d{1,2})[/-](\d{1,2})"?,(.+)$/);if(!row)continue;
  const day=`${row[1]}-${row[2].padStart(2,'0')}-${row[3].padStart(2,'0')}`;
  if(new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)throw Error('Invalid holiday date');
  const name=row[4].replace(/^"|"$/g,'').replaceAll('""','"').trim();if(!name||holidays[day])throw Error('Invalid holiday name/duplicate date');holidays[day]=name;
}
const keys=Object.keys(holidays).sort();if(keys.length<500)throw Error('Incomplete holiday source');
const result={source,retrievedAt:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'}),sha256:createHash('sha256').update(bytes).digest('hex'),through:keys.at(-1),holidays:Object.fromEntries(keys.map(k=>[k,holidays[k]]))};
await writeFile(new URL('../android-calendar/app/src/main/assets/holidays.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(`公表済み祝日 ${keys.length}件、${result.through}まで`);
