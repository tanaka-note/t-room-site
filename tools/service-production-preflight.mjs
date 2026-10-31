import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
export function assertServiceProductionReady(target,config,settings,migrations,expected){
 if(!['household','calendar'].includes(target))throw new Error('Unsupported preflight target');
 const bindings=settings?.bindings||[],db=config.d1_databases?.find(b=>b.binding==='DB');
 if(Object.hasOwn(config.vars||{},'SESSION_SECRET')||!config.services?.some(b=>b.binding==='SECURITY'&&b.service==='t-room-security')
   ||!config.queues?.producers?.some(b=>b.binding==='SECURITY_AUDIT'&&b.queue==='t-room-security-audit'))throw new Error('Production authentication/audit configuration is not ready.');
 if(!db||!bindings.some(b=>b.name==='DB'&&b.type==='d1'&&b.id===db.database_id)
   ||!bindings.some(b=>b.name==='SESSION_SECRET'&&b.type==='secret_text')
   ||!bindings.some(b=>b.name==='SECURITY'&&b.type==='service'&&b.service==='t-room-security')
   ||!bindings.some(b=>b.name==='SECURITY_AUDIT'&&b.type==='queue'))throw new Error('Required production bindings/Secret names are not ready.');
 if(target==='household'&&config.vars?.PASSKEY_ENABLED!=='true')throw new Error('Household passkey configuration is not ready.');
 if(target==='calendar'&&!bindings.some(b=>b.name==='PASSKEY_ENABLED'&&b.type==='secret_text'))throw new Error('Calendar passkey Secret is missing.');
 if(!Array.isArray(migrations)||JSON.stringify([...migrations].sort())!==JSON.stringify([...expected].sort()))throw new Error('Production D1 migrations differ from the verified checkout. Apply reviewed migrations with the dedicated procedure first.');
}
export async function serviceProductionPreflight(target,directory,config,settings,request=fetch){
 const response=await request(`https://tanaka-note.com/${target}/api/deployment-status`,{cache:'no-store',signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new Error('Production schema preflight unavailable. Initial bootstrap requires the documented dedicated release procedure.');
 const status=await response.json(),expected=readdirSync(resolve(directory,'migrations')).filter(f=>f.endsWith('.sql'));
 assertServiceProductionReady(target,config,settings,status.migrations,expected);
}
