import {createRequire} from 'node:module';
import {readFile,readdir,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=new URL('../../',import.meta.url),security=new URL('security-worker/',root);
const require=createRequire(new URL('package.json',security));
const {build}=createRequire(require.resolve('wrangler/package.json'))('esbuild');
const dir=new URL('diary-worker/migrations/',root),names=(await readdir(dir)).filter(name=>name.endsWith('.sql')).sort();
const ddl=(await Promise.all([...names.map(name=>new URL(name,dir)),new URL('diary-worker/e2ee/schema.sql',root),new URL('diary-worker/e2ee/legacy-fences.sql',root)].map(path=>readFile(path,'utf8')))).join('\n');
const result=await build({absWorkingDir:fileURLToPath(root),entryPoints:[fileURLToPath(new URL('diary-restore.mjs',security))],bundle:true,platform:'browser',format:'esm',target:'es2022',write:false,minify:false,legalComments:'inline',plugins:[{name:'trusted-ddl',setup(build){build.onResolve({filter:/^diary-trusted-ddl$/},()=>({path:'ddl',namespace:'trusted'}));build.onLoad({filter:/.*/,namespace:'trusted'},()=>({contents:'export default '+JSON.stringify(ddl),loader:'js'}));}}]});
const output=new URL('public/diary-restore.mjs',security);
if(process.argv.includes('--check')) {
  if(await readFile(output,'utf8')!==result.outputFiles[0].text)throw new Error('Diary restore bundle is stale; run node security-worker/tools/build-diary-restore.mjs');
  if(!(await readFile(new URL('public/vendor/sql-wasm.wasm',security))).equals(await readFile(require.resolve('sql.js/dist/sql-wasm.wasm'))))throw new Error('Diary SQLite WASM is stale');
}else {
  await writeFile(output,result.outputFiles[0].text);
  await mkdir(new URL('public/vendor/',security),{recursive:true});
  await copyFile(require.resolve('sql.js/dist/sql-wasm.wasm'),new URL('public/vendor/sql-wasm.wasm',security));
  await copyFile(new URL('node_modules/sql.js/LICENSE',security),new URL('public/vendor/sqlite-license.txt',security));
}
console.log('Diary isolated SQLite browser restore bundle '+(process.argv.includes('--check')?'verified':'built'));
