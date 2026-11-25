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
  const remote='/sdcard/calendar-ui-smoke.xml';
  for(let attempt=1;attempt<=4;attempt++){
    await delay(400);
    try {
      if(run('shell','uiautomator','dump',remote).includes('dumped to:')) break;
    } catch(error) {
      if(attempt===4) throw error;
    }
    assert(attempt<4,'Could not read the Android UI');
  }
  const xml=run('shell','cat','/sdcard/calendar-ui-smoke.xml');
  writeFileSync(resolve(output,`${name}.xml`),xml);
  nodes=[...xml.matchAll(/<node\b([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],decode(a[2])])));
  assert(!xml.includes("isn't responding"),'Resolve emulator/System UI readiness before the app test');
  return xml;
}
const text=s=>nodes.find(n=>n.text===s),desc=s=>nodes.find(n=>n['content-desc']===s);
const bounds=n=>{assert(n,'Expected UI element');const a=n.bounds.match(/\d+/g).map(Number);return {x:(a[0]+a[2])/2,y:(a[1]+a[3])/2,left:a[0],top:a[1],right:a[2],bottom:a[3]};};
const tap=n=>{const b=bounds(n);run('shell','input','tap',String(Math.round(b.x)),String(Math.round(b.y)));};
const selectedDate=()=>{
  const label=nodes.find(n=>n['content-desc']?.startsWith('選択中の日付：'))?.['content-desc'];
  assert(label,'Selected date must be accessible even outside the visible month');
  const [,y,m,d]=label.match(/(\d+)年(\d+)月(\d+)日/).map(Number);
  return {y,m,d};
};
const heading=()=>nodes.find(n=>/^\d+年\d+月$/.test(n.text))?.text;
const visibleMonth=()=>{const [,y,m]=heading().match(/^(\d+)年(\d+)月$/).map(Number);return {y,m};};
const moveMonth=(month,amount)=>{
  const date=new Date(Date.UTC(month.y,month.m-1+amount,1));
  return {y:date.getUTCFullYear(),m:date.getUTCMonth()+1};
};
const monthLabel=month=>`${month.y}年${month.m}月`;
const datePrefix=date=>`${monthLabel(date)}${date.d}日`;
function assertMonth(shown,selection=shown){
  assert.equal(heading(),monthLabel(shown));
  assert.deepEqual(selectedDate(),selection);
  const highlights=nodes.filter(n=>n['content-desc']?.includes(' 選択中'));
  for(const item of highlights) assert(item['content-desc'].startsWith(datePrefix(selection)+'('));
  if(shown.y===selection.y&&shown.m===selection.m) assert(highlights.length>0,'Selected day should be highlighted in its month');
}
function screenshot(name){writeFileSync(resolve(output,`${name}.png`),execFileSync(adb,['-s',serial,'exec-out','screencap','-p'],{timeout:30000}));}
const checkedLabel=s=>{const p=bounds(text(s));return nodes.some(n=>{if(n.selected!=='true'&&n.checked!=='true')return false;const b=bounds(n);return b.left<=p.x&&p.x<=b.right&&b.top<=p.y&&p.y<=b.bottom;});};
const size=run('shell','wm','size').match(/(\d+)x(\d+)/),w=+size[1],h=+size[2];
let scrollAttempt=0;
async function reveal(label,locate=text){for(let i=0;i<12;i++){const n=locate(label);if(n){const b=bounds(n);if(b.y>h*.12&&b.y<h*.88)return n;}run('shell','input','swipe',String(Math.round(w*.5)),String(Math.round(h*.78)),String(Math.round(w*.5)),String(Math.round(h*.3)),'450');await dump(`scroll-${scrollAttempt++}`);}throw new Error(`Could not reveal ${label}`);}
async function openPage(page){
  tap(desc('メニュー'));
  await dump('navigation-menu');
  tap(text(page));
  await dump(page==='設定'?'settings':'navigation-page');
}
const pagingOnly=process.argv.includes('--paging-only');

run('logcat','-b','crash','-c');run('shell','am','force-stop',pkg);run('shell','am','start','-W','-n',`${pkg}/.MainActivity`);await dump('initial');
if(text('ログインせずこの端末で使う')){tap(text('ログインせずこの端末で使う'));await dump('local-choice');}
tap(desc('メニュー'));await dump('local-menu');
assert(text('利用方法を選び直す'),'This fixture may only edit device-local data');
tap(text('月間カレンダー'));await dump('calendar');
const initial=selectedDate();assertMonth(initial);
assert.equal(nodes.filter(n=>n['content-desc']==='予定を追加').length,1,'Keep only the floating add button');
assert(!text('予定を追加'),'The extra text add button must be removed');
if(process.argv.includes('--account-only')){
  const fixture=`AccountKeep${Date.now()}`;
  tap(desc('予定を追加'));await dump('account-fixture-editor');
  tap(nodes.find(n=>n.class==='android.widget.EditText'));run('shell','input','text',fixture);run('shell','input','keyevent','KEYCODE_BACK');await dump('account-fixture-entered');
  tap(text('保存'));await dump('account-fixture-saved');
  await openPage('設定');
  assert(text('アカウント')&&text('アカウント名')&&text('この端末（ログインなし）'),'Show the account section and explicit local identity');
  assert(!text('ログアウト'),'Do not label local use as an authenticated account');screenshot('account-settings');
  tap(text('利用方法を選び直す'));await dump('account-cancel-dialog');run('shell','input','keyevent','KEYCODE_BACK');await dump('account-cancelled');
  assert(text('アカウント名')&&desc('カレンダーへ戻る'),'Cancelling must retain settings and the active account');
  tap(text('利用方法を選び直す'));await dump('account-confirm-dialog');assert(nodes.some(n=>n.text.includes('端末内の予定は残したまま')));
  tap(text('ログイン画面へ'));await dump('account-logged-out');
  assert(text('パスキーでログイン')&&text('ログインせずこの端末で使う'),'Leave settings for the initial login screen');screenshot('account-login-screen');
  for(let attempt=1;attempt<=3;attempt++){
    run('shell','am','force-stop',pkg);run('shell','am','start','-W','-n',`${pkg}/.MainActivity`);await dump(`account-logout-restart-${attempt}`);
    assert(text('パスキーでログイン')&&text('ログインせずこの端末で使う'),'Restart must keep the logged-out screen');
  }
  tap(text('ログインせずこの端末で使う'));await dump('account-local-resumed');
  tap(desc('検索'));await dump('account-search');tap(nodes.find(n=>n.class==='android.widget.EditText'));run('shell','input','text',fixture);run('shell','input','keyevent','KEYCODE_BACK');await dump('account-retained-data');
  assert(text(fixture),'Resuming local use must retain the saved appointment');
  tap(desc('検索'));await dump('account-finished');
  assert(!run('logcat','-d','-b','crash').includes(pkg),'No release account UI crash');
  console.log('PASS account section, local identity, cancel/back, return to login, logged-out restart and retained local data');
  process.exit(0);
}
if(process.argv.includes('--back-only')){
  const back=()=>run('shell','input','keyevent','KEYCODE_BACK');
  const foreground=()=>run('shell','dumpsys','activity','activities').split(/\r?\n/)
    .some(line=>line.includes('topResumedActivity=')&&line.includes(pkg+'/'));
  async function waitForeground(expected){
    for(let attempt=0;attempt<10;attempt++){
      if(foreground()===expected) return;
      await delay(200);
    }
    assert.fail(expected?'Calendar must remain in the foreground':'The second Back must take Calendar to the background');
  }
  const imeVisible=()=>/\bmInputShown=true\b/.test(run('shell','dumpsys','input_method'));
  const searchLabel='表示中の予定・追跡・タグを検索';
  const shown=moveMonth(initial,1);
  tap(desc('次へ'));await dump('back-visible-month');assertMonth(shown,initial);

  tap(desc('検索'));await dump('back-search');
  tap(nodes.find(n=>n.class==='android.widget.EditText'));
  for(let attempt=0;attempt<8&&!imeVisible();attempt++) await delay(200);
  assert(imeVisible(),'Search keyboard should be visible');
  back();await dump('back-keyboard-closed');
  assert(!imeVisible(),'Back should first close the keyboard');
  assert(text(searchLabel),'The search field must remain for the next Back');
  back();await dump('back-search-closed');
  assert(!text(searchLabel),'The second Back should close search');
  assertMonth(shown,initial);

  tap(desc('メニュー'));await dump('back-drawer-open');
  back();await dump('back-drawer-closed');
  assert(!text('利用方法を選び直す'),'Back should close the drawer only');
  assertMonth(shown,initial);

  tap(desc('予定を追加'));await dump('back-editor');
  back();await dump('back-editor-confirmation');
  assert(text('編集を終了しますか？'),'Back should protect unsaved editor input');
  back();await dump('back-editor-keep-editing');
  assert(text('保存')&&!text('編集を終了しますか？'),'Back should close only the discard confirmation');
  back();await dump('back-editor-confirm-again');
  tap(text('破棄して戻る'));await dump('back-from-editor');
  assertMonth(shown,initial);

  await openPage('設定');
  tap(await reveal('タグを管理'));await dump('back-settings-child');
  assert(desc('設定へ戻る'));
  back();await dump('back-settings-root');
  assert(desc('カレンダーへ戻る'),'Back should return to the root of Settings');
  back();await dump('back-from-settings');
  assertMonth(shown,initial);

  await openPage('追跡');
  const track='Back42';
  tap(text('追跡を作成'));await dump('back-new-track');
  tap(nodes.find(n=>n.class==='android.widget.EditText'));
  await delay(700);run('shell','input','text',track);
  await dump('back-track-name');
  tap(text('作成'));await dump('back-tracking-list');
  tap(text(track));await dump('back-track-detail');
  assert(desc('追跡一覧へ戻る'));
  back();await dump('back-track-parent');
  assert(text('追跡を作成'),'A tracking detail must first return to the tracking list');
  back();await dump('back-from-tracking');
  assertMonth(shown,initial);
  console.log('PASS one-level Back for the keyboard, search, drawer, editor, Settings and tracking');

  await openPage('設定');
  tap(await reveal('月間カレンダー'));await dump('back-startup-options');
  tap(text('予定一覧'));await dump('back-agenda-startup-setting');
  assert(text('予定一覧'),'The configured startup page should update');
  back();await dump('back-configured-startup');
  assert.equal(heading(),monthLabel(shown));
  assert(!nodes.some(n=>n['content-desc']?.startsWith('選択中の日付：')),'Back should open the configured agenda');
  await openPage('月間カレンダー');
  assertMonth(shown,initial);
  back();await dump('back-month-to-agenda');
  assert(!nodes.some(n=>n['content-desc']?.startsWith('選択中の日付：')),'Back should return to the agenda from Calendar');

  back();await delay(250);assert(foreground(),'The first Back at startup should leave Calendar open');
  await delay(2100);
  back();await delay(250);assert(foreground(),'Back after the confirmation window should leave Calendar open');
  await delay(2100);
  run('shell','input','keyevent','KEYCODE_BACK','KEYCODE_BACK');
  await waitForeground(false);
  run('shell','am','start','-W','-n',`${pkg}/.MainActivity`);
  await waitForeground(true);
  back();await delay(250);assert(foreground(),'A new foreground visit should reset exit confirmation');
  assert(!run('logcat','-d','-b','crash').includes(pkg),'No release Back navigation crash');
  console.log('PASS configured startup, two-second confirmation, exit and reopening');
  process.exit(0);
}
if(!process.argv.includes('--settings-only')){
const nextMonth=moveMonth(initial,1);
tap(desc('次へ'));await dump('next-month');assertMonth(nextMonth,initial);
await openPage('週間カレンダー');
assert.equal(heading(),monthLabel(initial),'Week header must match the date shown in the week');
await openPage('月間カレンダー');assertMonth(nextMonth,initial);

tap(desc('予定を追加'));await dump('editor-after-browsing');
assert.equal(nodes.filter(n=>n.text?.startsWith(datePrefix(initial))).length,2,'New appointments still start on the selected date');
tap(desc('戻る'));await dump('leave-editor-after-browsing');
tap(text('破棄して戻る'));await dump('returned-from-editor');assertMonth(nextMonth,initial);

const target={...nextMonth,d:initial.d===12?13:12};
tap(nodes.find(n=>n['content-desc']?.startsWith(datePrefix(target)+'(')));
await dump('other-date-selected');assertMonth(target);
tap(desc('前へ'));await dump('previous-after-selection');assertMonth(initial,target);
tap(desc('次へ'));await dump('next-after-selection');assertMonth(target);

if(!pagingOnly){
tap(desc('予定を追加'));const editorXml=await dump('editor');
assert(editorXml.includes('例：9:00-10:00 友達とお出かけ'),'Show the requested time/title example');
const editorDate=new RegExp(`^${target.y}年${target.m}月${target.d}日`);
assert.equal(nodes.filter(n=>editorDate.test(n.text)).length,2,'Both dates must use the visible selected day');
assert(!checkedLabel('追跡する（任意）'),'Tracking must start off');
tap(text('保存'));await dump('required-title');assert(text('予定名を入力してください。'),'Show the missing title beside its field');screenshot('required-title');
const titleInput=nodes.find(n=>n.class==='android.widget.EditText');tap(titleInput);run('shell','input','text','CalendarUiSmoke');
run('shell','input','keyevent','KEYCODE_BACK');await dump('title-entered');tap(text('保存'));await dump('saved');
assert(nodes.some(n=>n.text==='CalendarUiSmoke'),'An untracked title/date-only appointment must save');screenshot('calendar');
console.log('PASS selected date, title validation and untracked appointment entry');

tap(desc('予定を追加'));await dump('quick-editor');tap(nodes.find(n=>n.class==='android.widget.EditText'));
run('shell','input','text','9:00-10:30%sQuickTimeFixture');run('shell','input','keyevent','KEYCODE_BACK');await dump('quick-preview');
assert(text('09:00')&&text('10:30'),'One-line input must update the time controls');
tap(text('保存'));await dump('quick-saved');assert(text('QuickTimeFixture'),'Save the title without its time prefix');
assert(!text('9:00-10:30 QuickTimeFixture'));screenshot('quick-saved');
tap(desc('予定を追加'));await dump('invalid-editor');tap(nodes.find(n=>n.class==='android.widget.EditText'));
run('shell','input','text','25:00-26:00%sInvalidTimeFixture');run('shell','input','keyevent','KEYCODE_BACK');await dump('invalid-time-input');tap(text('保存'));await dump('invalid-time-error');
assert(text('時刻は0:00〜23:59で入力してください。'),'Invalid one-line times must block saving');
run('shell','input','keyevent','KEYCODE_BACK');await dump('invalid-keyboard-closed');if(!text('破棄して戻る')){tap(desc('戻る'));await dump('invalid-discard');}tap(text('破棄して戻る'));await dump('invalid-closed');
tap(desc('予定を追加'));await dump('overnight-editor');tap(nodes.find(n=>n.class==='android.widget.EditText'));
run('shell','input','text','23:00-1:00%sOvernightFixture');run('shell','input','keyevent','KEYCODE_BACK');await dump('overnight-preview');
assert(nodes.some(n=>n.text.includes('翌日01:00')),'Make the overnight interpretation visible');
tap(text('保存'));await dump('overnight-saved');assert(text('OvernightFixture'));tap(text('OvernightFixture'));await dump('overnight-detail');
assert(nodes.some(n=>/23:00.*01:00/.test(n.text)),'Persist both overnight times');run('shell','input','keyevent','KEYCODE_BACK');await dump('after-quick-entry');
console.log('PASS one-line time input, requested example, invalid ranges and overnight entry');
}

const y=Math.round(h*.38);
run('shell','input','swipe',String(Math.round(w*.78)),String(y),String(Math.round(w*.22)),String(y),'450');await dump('swipe-next');assertMonth(moveMonth(target,1),target);
run('shell','input','swipe',String(Math.round(w*.22)),String(y),String(Math.round(w*.78)),String(y),'450');await dump('swipe-back');assertMonth(target);
assert(!text('利用方法を選び直す'),'A rightward month swipe must not open the drawer');
run('shell','input','swipe',String(Math.round(w*.55)),String(y),String(Math.round(w*.47)),String(y),'650');await dump('short-swipe');assertMonth(target);
const next=bounds(desc('次へ'));for(let i=0;i<3;i++)run('shell','input','tap',String(Math.round(next.x)),String(Math.round(next.y)));
await dump('rapid-next');assertMonth(moveMonth(target,3),target);
tap(desc('次へ'));
run('shell','input','swipe',String(Math.round(w*.78)),String(y),String(Math.round(w*.22)),String(y),'550');await dump('interrupted-navigation');
const interrupted=visibleMonth();assertMonth(interrupted,target);
tap(desc('次へ'));await dump('after-interruption');assertMonth(moveMonth(interrupted,1),target);
console.log('PASS selected date preserved by arrows, swipes and rapid month paging');
}

const beforeSettings=visibleMonth(), selectedBeforeSettings=selectedDate();
await openPage('設定');tap(desc('カレンダーへ戻る'));await dump('toolbar-back');assertMonth(beforeSettings,selectedBeforeSettings);
await openPage('設定');run('shell','input','keyevent','KEYCODE_BACK');await dump('android-back');assertMonth(beforeSettings,selectedBeforeSettings);
if(pagingOnly){
  tap(desc('今日'));await dump('today-button');assertMonth(initial);
  assert(!run('logcat','-d','-b','crash').includes(pkg),'No release paging UI crash');
  console.log('PASS month and selected date retained through settings, and Today resets both');
  process.exit(0);
}
await openPage('設定');
for(const label of ['ブルー','ミント','ラベンダー','ローズ','ピーチ','グレー','スカイ','ターコイズ','ネイビー','プラム','アンバー','コーラル'])await reveal(label);
tap(text('ローズ'));await dump('rose');tap(text('ダーク'));await dump('dark');
assert(checkedLabel('ローズ'));assert(checkedLabel('ダーク'));screenshot('rose-dark');
run('shell','am','force-stop',pkg);run('shell','am','start','-W','-n',`${pkg}/.MainActivity`);await dump('reopened');
tap(desc('メニュー'));await dump('reopened-menu');tap(text('設定'));await dump('restored-settings');
assert(checkedLabel('ローズ'));assert(checkedLabel('ダーク'));
tap(text('ブルー'));await dump('blue');tap(text('ライト'));await dump('light');screenshot('blue-light');
await reveal('標準の通知');
if(nodes.some(n=>n.text.startsWith('設定した通知：'))){tap(await reveal('通知なしにする'));await dump('reminders-cleared');}
tap(await reveal('1日前'));await dump('one-reminder');tap(await reveal('1時間前'));await dump('two-reminders');
assert(desc('1日前の通知を削除')&&desc('1時間前の通知を削除'));screenshot('multiple-reminders');
run('shell','am','force-stop',pkg);run('shell','am','start','-W','-n',`${pkg}/.MainActivity`);await dump('reminders-restart');await openPage('設定');
await reveal('1日前の通知を削除',desc);await reveal('1時間前の通知を削除',desc);
assert(desc('1日前の通知を削除')&&desc('1時間前の通知を削除'),'Both standard reminders must survive restart');
tap(desc('1時間前の通知を削除'));await dump('reminder-removed');assert(desc('1日前の通知を削除'));assert(!desc('1時間前の通知を削除'));
tap(await reveal('通知なしにする'));await dump('no-reminders');
tap(await reveal('ゴミ箱（30日）'));await dump('settings-child');run('shell','input','keyevent','KEYCODE_BACK');await dump('settings-child-back');assert(desc('カレンダーへ戻る'),'Back from a settings child must return to settings first');
tap(desc('カレンダーへ戻る'));await dump('settings-root-back');assert(heading());
console.log('PASS settings back hierarchy, twelve palettes and persistent multiple reminders');
tap(desc('予定を追加'));await dump('timed-editor');tap(text('終日'));await dump('times');
assert(text('09:00')&&text('10:00'),'Timed entry must show an explicit one-hour end');screenshot('timed-editor');
tap(desc('戻る'));await dump('discard');tap(text('破棄して戻る'));await dump('finished');
assert(!run('logcat','-d','-b','crash').includes(pkg),'No release UI crash');
console.log('PASS palette/appearance persistence, timed-entry defaults and close confirmation');
console.log(`Screenshots and UI snapshots: ${output}`);
