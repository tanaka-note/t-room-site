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
assert(['welcome','local'].includes(screen),'Expected welcome or local');
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
