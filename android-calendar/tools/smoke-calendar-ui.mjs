import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const arg=name=>process.argv[process.argv.indexOf(name)+1];
const adb=arg('--adb'),serial=arg('--serial');
assert(process.argv.includes('--adb')&&process.argv.includes('--serial')&&/^emulator-\d+$/.test(serial),'Use explicit --adb and a dedicated --serial emulator-N');
const pkg='jp.tanaka.troom.calendar',output=resolve('..','tmp','calendar-ui-smoke');mkdirSync(output,{recursive:true});
const run=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:90000}).trim();
assert.equal(run('shell','getprop','sys.boot_completed'),'1');
assert(Number(run('shell','getprop','ro.build.version.sdk'))>=36,'Exercise Android 16 or later');
assert(!/flags=\[[^\n]*\bDEBUGGABLE\b/.test(run('shell','dumpsys','package',pkg)),'Use the signed optimized release APK');
const decode=s=>s.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
let nodes=[];
async function dump(name){
  await delay(400);run('shell','uiautomator','dump','/sdcard/calendar-ui-smoke.xml');
  const xml=run('shell','cat','/sdcard/calendar-ui-smoke.xml');
  writeFileSync(resolve(output,`${name}.xml`),xml);
  nodes=[...xml.matchAll(/<node\b([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],decode(a[2])])));
  assert(!xml.includes("isn't responding"),'Resolve emulator/System UI readiness before the app test');
  return xml;
}
const text=s=>nodes.find(n=>n.text===s),desc=s=>nodes.find(n=>n['content-desc']===s);
const bounds=n=>{assert(n,'Expected UI element');const a=n.bounds.match(/\d+/g).map(Number);return {x:(a[0]+a[2])/2,y:(a[1]+a[3])/2,left:a[0],top:a[1],right:a[2],bottom:a[3]};};
const tap=n=>{const b=bounds(n);run('shell','input','tap',String(Math.round(b.x)),String(Math.round(b.y)));};
const selectedLabel=()=>nodes.find(n=>n['content-desc']?.includes('選択中'))?.['content-desc'];
const selectedDate=()=>{const s=selectedLabel();assert(s,'Selected day must have an accessible label');const [,y,m,d]=s.match(/(\d+)年(\d+)月(\d+)日/);return {y:+y,m:+m,d:+d};};
const heading=()=>nodes.find(n=>/^\d+年\d+月$/.test(n.text))?.text;
const moveDate=(d,amount)=>{const dt=new Date(Date.UTC(d.y,d.m-1+amount,1));return {y:dt.getUTCFullYear(),m:dt.getUTCMonth()+1,d:Math.min(d.d,new Date(Date.UTC(dt.getUTCFullYear(),dt.getUTCMonth()+1,0)).getUTCDate())};};
function assertMonth(d){assert.equal(heading(),`${d.y}年${d.m}月`);assert.deepEqual(selectedDate(),d);}
function screenshot(name){writeFileSync(resolve(output,`${name}.png`),execFileSync(adb,['-s',serial,'exec-out','screencap','-p'],{timeout:30000}));}
const checkedLabel=s=>{const p=bounds(text(s));return nodes.some(n=>{if(n.selected!=='true'&&n.checked!=='true')return false;const b=bounds(n);return b.left<=p.x&&p.x<=b.right&&b.top<=p.y&&p.y<=b.bottom;});};

run('logcat','-b','crash','-c');run('shell','am','start','-W','-n',`${pkg}/.MainActivity`);await dump('initial');
if(text('ログインせずこの端末で使う')){tap(text('ログインせずこの端末で使う'));await dump('local-choice');}
tap(desc('メニュー'));await dump('local-menu');
assert(text('利用方法を選び直す'),'This fixture may only edit device-local data');
tap(text('月間カレンダー'));await dump('calendar');
const initial=selectedDate();assertMonth(initial);
tap(desc('次へ'));await dump('next-month');const target=moveDate(initial,1);assertMonth(target);
tap(text('予定を追加'));await dump('editor');
const editorDate=new RegExp(`^${target.y}年${target.m}月${target.d}日`);
assert.equal(nodes.filter(n=>editorDate.test(n.text)).length,2,'Both dates must use the visible selected day');
assert(!checkedLabel('追跡する（任意）'),'Tracking must start off');
tap(text('保存'));await dump('required-title');assert(text('予定名を入力してください。'),'Show the missing title beside its field');screenshot('required-title');
const titleInput=nodes.find(n=>n.class==='android.widget.EditText');tap(titleInput);run('shell','input','text','CalendarUiSmoke');
run('shell','input','keyevent','KEYCODE_BACK');await dump('title-entered');tap(text('保存'));await dump('saved');
assert(nodes.some(n=>n.text==='CalendarUiSmoke'),'An untracked title/date-only appointment must save');screenshot('calendar');
console.log('PASS selected date, title validation and untracked appointment entry');

const size=run('shell','wm','size').match(/(\d+)x(\d+)/),w=+size[1],h=+size[2],y=Math.round(h*.38);
run('shell','input','swipe',String(Math.round(w*.78)),String(y),String(Math.round(w*.22)),String(y),'450');await dump('swipe-next');assertMonth(moveDate(target,1));
run('shell','input','swipe',String(Math.round(w*.22)),String(y),String(Math.round(w*.78)),String(y),'450');await dump('swipe-back');assertMonth(target);
assert(!text('利用方法を選び直す'),'A rightward month swipe must not open the drawer');
run('shell','input','swipe',String(Math.round(w*.55)),String(y),String(Math.round(w*.47)),String(y),'650');await dump('short-swipe');assertMonth(target);
const next=bounds(desc('次へ'));for(let i=0;i<3;i++)run('shell','input','tap',String(Math.round(next.x)),String(Math.round(next.y)));
await dump('rapid-next');assertMonth(moveDate(target,3));
tap(desc('次へ'));
run('shell','input','swipe',String(Math.round(w*.78)),String(y),String(Math.round(w*.22)),String(y),'550');await dump('interrupted-navigation');
const interrupted=selectedDate();assertMonth(interrupted);
tap(desc('次へ'));await dump('after-interruption');assertMonth(moveDate(interrupted,1));
console.log('PASS left/right paging, incomplete swipe and repeated navigation');

tap(desc('メニュー'));await dump('settings-menu');tap(text('設定'));await dump('settings');
for(const label of ['ブルー','ミント','ラベンダー','ローズ','ピーチ','グレー'])assert(text(label),`Palette ${label} must be available`);
tap(text('ローズ'));await dump('rose');tap(text('ダーク'));await dump('dark');
assert(checkedLabel('ローズ'));assert(checkedLabel('ダーク'));screenshot('rose-dark');
run('shell','am','force-stop',pkg);run('shell','am','start','-W','-n',`${pkg}/.MainActivity`);await dump('reopened');
tap(desc('メニュー'));await dump('reopened-menu');tap(text('設定'));await dump('restored-settings');
assert(checkedLabel('ローズ'));assert(checkedLabel('ダーク'));
tap(text('ブルー'));await dump('blue');tap(text('ライト'));await dump('light');screenshot('blue-light');
tap(desc('メニュー'));await dump('return-menu');tap(text('月間カレンダー'));await dump('return-calendar');
tap(desc('予定を追加'));await dump('timed-editor');tap(text('終日'));await dump('times');
assert(text('09:00')&&text('10:00'),'Timed entry must show an explicit one-hour end');screenshot('timed-editor');
tap(desc('戻る'));await dump('discard');tap(text('破棄して戻る'));await dump('finished');
assert(!run('logcat','-d','-b','crash').includes(pkg),'No release UI crash');
console.log('PASS palette/appearance persistence, timed-entry defaults and close confirmation');
console.log(`Screenshots and UI snapshots: ${output}`);
