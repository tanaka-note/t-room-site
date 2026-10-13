import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { fixture, d1 } from '../../health-worker/test/fixture.js';
import { migrationNames, migrationSql } from './health-migration-fixture.mjs';

registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export class WorkerEntrypoint {}',shortCircuit:true};
  return next(specifier,context);
}});
export const {default:SecurityWorker}=await import('../src/index.js');
export const {default:HealthWorker}=await import('../../health-worker/src/index.js');

export async function healthSecurityFixture() {
  const health=await fixture(), db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for(const name of migrationNames)db.exec(migrationSql(name));
  const security=new SecurityWorker();security.env={DB:d1(db),PASSKEY_ENABLED:'true'};
  for(const [person,user] of Object.entries(health.users)) {
    user.handoff.credentialId=`fixture-${person}-AA`;
    const {identityId,credentialId,serviceLinkId}=user.handoff;
    db.prepare("INSERT INTO security_identities(id,display_name,status) VALUES (?,?,'active')").run(identityId,`Fixture ${person}`);
    db.prepare("INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status,prf_enabled) VALUES (?,?,'public-fixture','salt-fixture','active',1)").run(credentialId,identityId);
    db.prepare('INSERT INTO security_health_members(slot,identity_id) VALUES (?,?)').run(person,identityId);
    db.prepare("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES (?,?,'health','nobumi','Fixture Health','active')").run(serviceLinkId,identityId);
    const vault=user.bundle.vault;
    db.prepare('INSERT INTO security_health_vaults VALUES (?,?,?,?,?)').run(credentialId,identityId,JSON.stringify(vault.publicKey),vault.iv,vault.ciphertext);
    db.prepare('INSERT INTO security_health_grants VALUES (?,?,?,?)').run(identityId,credentialId,serviceLinkId,user.bundle.wrappedKey);
  }
  db.exec("INSERT INTO security_health_config VALUES ('nobumi','encrypted-recovery-fixture','{}'); INSERT INTO security_identities(id,display_name,status) VALUES ('fixture-third','Fixture third','active'); INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status) VALUES ('fixture-third-AA','fixture-third','public-fixture','salt-fixture','active'); INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES ('third-link','fixture-third','diary','fixture-third','Fixture Diary','active')");
  health.env.SECURITY=security;
  const worker=new HealthWorker();worker.env=health.env;
  return {health,db,security,worker,close(){health.master.fill(0);for(const user of Object.values(health.users))user.prf.fill(0);health.db.close();db.close();},
    issue(person='owner',overrides={}) {
      const token=randomBytes(32).toString('base64url'), user=health.users[person].handoff;
      const input={...user,sessionEpoch:1,consumedAt:null,...overrides};
      db.prepare('INSERT INTO security_handoffs(id,token_hash,identity_id,credential_id,service_link_id,expires_at,session_epoch,consumed_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(),createHash('sha256').update(token).digest('base64url'),input.identityId,input.credentialId,input.serviceLinkId,Math.floor(Date.now()/1000)+60,input.sessionEpoch,input.consumedAt);
      return token;
    }
  };
}
