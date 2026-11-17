import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {root} from './verify-plan.mjs';
export const weeklySuites={
 auth:[['tools/verify.mjs','--target','auth']],
 backup:[['tools/verify.mjs','--target','backup','--build']],
 household:[['tools/verify.mjs','--target','household','--browser','--build'],['household-worker/test/performance.mjs']],
 calendar:[['tools/verify.mjs','--target','calendar','--build']],
 security:[['tools/verify.mjs','--target','security','--browser','--build']],
 diary:[['diary-worker/tests/bootstrap.mjs'],['diary-worker/tests/session-read-reuse.mjs'],['diary-worker/tests/browser/passkey-login.mjs'],['diary-worker/tests/browser/navigation-return.mjs'],['diary-worker/tests/browser/session-clearing.mjs']],
 payments:[['tools/verify.mjs','--target','payments','--browser','--build']],
 site:[['tools/verify.mjs','--target','site','--browser','--build']],
 cloud:[['cloud-worker/tests/passkey-session-resume.mjs'],['cloud-worker/tests/permission-guards.mjs'],['cloud-worker/tests/diary-backup-mount.mjs'],['cloud-worker/tests/listing-boundary.browser.mjs']]
};
export function weeklyCommands(target){if(!Object.hasOwn(weeklySuites,target))throw new Error('Unknown weekly target');return weeklySuites[target];}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 for(const args of weeklyCommands(process.argv[2])){const result=spawnSync(process.execPath,['--require','./tools/browser-trace.cjs',...args],{cwd:root,stdio:'inherit'});if(result.error||result.status!==0)throw new Error('Weekly regression failed');}
}
