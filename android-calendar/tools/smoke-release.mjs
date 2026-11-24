import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const adb=arg('--adb'), serial=arg('--serial'), apk=arg('--apk');
const screen=process.argv.includes('--screen')?arg('--screen'):'welcome';
assert(adb&&existsSync(adb)&&apk&&existsSync(apk),'Pass --adb and --apk paths');
assert(/^emulator-\d+$/.test(serial||''),'Only a dedicated emulator fixture is allowed');
assert(['welcome','local','permissions'].includes(screen),'Expected welcome, local or permissions');
const run=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:90000}).trim();
assert.equal(run('shell','getprop','sys.boot_completed'),'1','Wait for emulator boot');
assert(Number(run('shell','getprop','ro.build.version.sdk'))>=36,'Run the Android 16 regression on API 36 or later');
const pkg='jp.tanaka.troom.calendar';
const output=resolve('..','tmp','calendar-release-smoke');mkdirSync(output,{recursive:true});
run('install','-r',resolve(apk));
const info=run('shell','dumpsys','package',pkg);
assert(!/flags=\[[^\n]*\bDEBUGGABLE\b/.test(info),'Use the optimized release APK, not a debug build');
console.log(info.match(/versionCode=\d+[^\n]*/)?.[0]);
run('logcat','-b','crash','-c');

if (screen === 'permissions') {
 const notification = 'android.permission.POST_NOTIFICATIONS';
 const exactAlarm = 'SCHEDULE_EXACT_ALARM';
 const dialog = '通知の設定が必要です';
 const calendar = /パスキーでログイン|予定を追加/;
 const open = () => run('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`);
 const restart = () => {
  run('shell', 'am', 'force-stop', pkg);
  open();
 };
 async function waitForUi(expected) {
  for (let attempt = 0; attempt < 5; attempt++) {
   await delay(500);
   try {
    if (!run('shell', 'uiautomator', 'dump', '--compressed', '/sdcard/calendar-release-smoke.xml').includes('dumped to:')) continue;
    const ui = run('shell', 'cat', '/sdcard/calendar-release-smoke.xml');
    if (expected.test(ui)) return ui;
   } catch (error) {
    if (attempt === 4) throw error;
   }
  }
  assert.fail(`UI did not show ${expected}`);
 }
 function tap(ui, attribute, label) {
  const node = [...ui.matchAll(/<node\b[^>]*>/g)].find(match => match[0].includes(`${attribute}="${label}"`));
  assert(node, `Missing ${label}`);
  const [, left, top, right, bottom] = node[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).map(Number);
  run('shell', 'input', 'tap', String(Math.floor((left + right) / 2)), String(Math.floor((top + bottom) / 2)));
 }
 const enableExactAlarm = mode => run('shell', 'cmd', 'appops', 'set', '--user', '0', pkg, exactAlarm, mode);
 run('shell', 'pm', 'revoke', pkg, notification);
 for (const flag of ['user-set', 'user-fixed']) run('shell', 'pm', 'clear-permission-flags', pkg, notification, flag);
 enableExactAlarm('deny');
 restart();
 const first = await waitForUi(/通知を許可/);
 assert(first.includes(dialog) && !calendar.test(first), 'Require notification setup before use');
 tap(first, 'text', 'アプリを閉じる');
 await delay(500);
 open();
 tap(await waitForUi(/通知を許可/), 'text', '通知を許可');
 const systemPrompt = await waitForUi(/permission_allow_button/);
 const allowId = systemPrompt.match(/resource-id="([^"]*:id\/permission_allow_button)"/)?.[1];
 assert(allowId, 'Android must display its notification permission prompt');
 tap(systemPrompt, 'resource-id', allowId);
 tap(await waitForUi(/時刻の予約を許可/), 'text', '時刻の予約を許可');
 await waitForUi(/package="com\.android\.settings"/);
 run('shell', 'input', 'keyevent', 'KEYCODE_BACK');
 assert((await waitForUi(/時刻の予約を許可/)).includes(dialog), 'Returning without granting must keep setup visible');
 tap(await waitForUi(/時刻の予約を許可/), 'text', '時刻の予約を許可');
 await waitForUi(/package="com\.android\.settings"/);
 enableExactAlarm('allow');
 run('shell', 'input', 'keyevent', 'KEYCODE_BACK');
 assert(!(await waitForUi(calendar)).includes(dialog), 'Both grants should unlock the current launch');
 restart();
 assert(!(await waitForUi(calendar)).includes(dialog), 'Both grants should unlock future launches');
 enableExactAlarm('deny');
 restart();
 const revoked = await waitForUi(/時刻の予約を許可/);
 assert(revoked.includes(dialog) && !calendar.test(revoked), 'A revoked permission should block the next launch');
 enableExactAlarm('allow');
 restart();
 assert(!(await waitForUi(calendar)).includes(dialog), 'Restoring permission should unlock the calendar');
 assert(!run('logcat', '-d', '-b', 'crash').includes(pkg), 'Permission flow must not crash the app');
 console.log('PASS required notification setup, repeat prompt, Android settings return and permission revocation');
 process.exit(0);
}
for(let attempt=1;attempt<=3;attempt++){
 run('shell','am','force-stop',pkg);
 run('shell','am','start','-W','-n',`${pkg}/.MainActivity`);
 await delay(4000);
 const crashes=run('logcat','-d','-b','crash','-v','brief');
 writeFileSync(resolve(output,`crash-${attempt}.log`),crashes);
 assert(!crashes.includes(pkg),`App crashed: ${crashes}`);
 assert(run('shell','pidof',pkg),'App process must remain alive after launch');
 run('shell','uiautomator','dump','/sdcard/calendar-release-smoke.xml');
 const ui=run('shell','cat','/sdcard/calendar-release-smoke.xml');
 writeFileSync(resolve(output,`screen-${attempt}.xml`),ui);
 if(screen==='welcome'){
  assert(ui.includes('パスキーでログイン'),'Passkey choice must be visible');
  assert(ui.includes('ログインせずこの端末で使う'),'Local choice must be visible');
 }else{
  assert(ui.includes('予定を追加')&&ui.includes('メニュー'),'Local calendar must reopen');
  assert(!ui.includes('ログインせずこの端末で使う'),'Local selection must survive restart');
 }
 console.log(`Android ${run('shell','getprop','ro.build.version.release')}: release ${screen} cold start ${attempt}/3 passed`);
}
assert(run('shell','dumpsys','jobscheduler').includes(`${pkg}/androidx.work.impl.background.systemjob.SystemJobService`),'WorkManager periodic work must be scheduled');
console.log('WorkManager periodic job is present');
