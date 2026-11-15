import { WorkerEntrypoint } from 'cloudflare:workers';
import { calendarRequest,accountVersion,purgeExpired } from './api.js';

export default class CalendarWorker extends WorkerEntrypoint {
  fetch(request){return calendarRequest(request,this.env);}
  async scheduled(){await purgeExpired(this.env);}
}
export class SecurityIntegration extends WorkerEntrypoint {
  async listLinkTargets(){const rows=(await this.env.DB.prepare('SELECT * FROM calendar_accounts WHERE is_active=1 ORDER BY created_at,id').all()).results||[];return{service:'calendar',displayName:'カレンダー',targets:rows.map(target)};}
  async describeAccount(input){if(input?.rootFolderId!=null)return{valid:false};const row=await this.env.DB.prepare('SELECT * FROM calendar_accounts WHERE id=? AND is_active=1').bind(String(input?.accountId||'')).first();return row?{valid:true,...target(row)}:{valid:false};}
  async getSessionRuntimeState(input){const row=await this.env.DB.prepare('SELECT * FROM calendar_accounts WHERE id=? AND is_active=1').bind(String(input?.serviceAccountId||'')).first();return row?{sessionVersion:accountVersion(this.env,row),passkeyEnabled:String(this.env.PASSKEY_ENABLED)==='true'}:null;}
}
function target(row){return{accountId:row.id,displayLabel:row.display_name,role:'member',roleLabel:'利用者',privileged:false,exclusive:false,shared:true,rootFolderId:null};}
