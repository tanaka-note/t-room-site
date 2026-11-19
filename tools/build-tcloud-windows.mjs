import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

if(process.platform!=='win32'||process.arch!=='x64')throw new Error('T-Cloud Windows requires Windows x64.');
const root=fileURLToPath(new URL('../',import.meta.url)),distribution=join(root,'tcloud-windows/artifacts/distribution');
const packageId=randomUUID(),out=join(distribution,packageId);
const host=join(out,'payload');mkdirSync(host,{recursive:true});
function run(command,args){const result=spawnSync(command,args,{cwd:root,stdio:'inherit',shell:false});if(result.error)throw result.error;if(result.status!==0)throw new Error('Windows package build failed.');}
run(process.execPath,['tools/build-tcloud-shell-probe.mjs']);
run('dotnet',['publish','tcloud-windows/src/TCloud.Sync.Host','--configuration','Release','--runtime','win-x64','--self-contained','true',
    '-p:DebugType=None','-p:DebugSymbols=false','-warnaserror','--output',host,'--nologo']);
const shellBase=join(root,'tcloud-windows/artifacts/native-shell');
const shellId=JSON.parse(readFileSync(join(shellBase,'active.json'),'utf8')).buildId;
if(!/^[a-f0-9]{64}$/.test(shellId))throw new Error('Invalid Shell build.');
copyFileSync(join(shellBase,shellId,'TCloud.ShellExtension.dll'),join(host,'TCloud.ShellExtension.dll'));
copyFileSync(join(root,'tcloud-windows/Install.ps1'),join(out,'Install.ps1'));
const files=[];
function walk(directory){for(const item of readdirSync(directory,{withFileTypes:true})){
    if(item.isSymbolicLink())throw new Error('Package cannot contain links.');const path=join(directory,item.name);
    if(item.isDirectory())walk(path);else files.push({path:relative(host,path).replaceAll('\\','/'),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});
}}
walk(host);files.sort((a,b)=>a.path.localeCompare(b.path));
if(!existsSync(resolve(host,'TCloud.Sync.Host.exe'))||!files.length)throw new Error('Missing host.');
const buildId=createHash('sha256').update(JSON.stringify(files)).digest('hex');
writeFileSync(join(out,'manifest.json'),JSON.stringify({version:1,buildId,files},null,2)+'\n');
writeFileSync(join(distribution,'active.json'),JSON.stringify({packageId,buildId})+'\n');
console.log('T-Cloud Windows self-contained package: '+out+' ('+buildId.slice(0,12)+')');
