// Session-bound MFA assurance, reconstructed from the existing append-only identity journal.
// No credential or MFA code is stored here. Only the server-issued session id can select its login event.
import { loadIdentityConfig } from './config.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const methods=new Set(['TOTP','RECOVERY_CODE']);
const fail=code=>({ok:false,code});
const stamp=v=>v instanceof Date?v.getTime():typeof v==='string'?Date.parse(v):NaN;
const same=(a,b)=>typeof a==='string'&&a.toLowerCase()===b;
export function createSessionAssurance({supabase,now=()=>Date.now(),config=loadIdentityConfig()}) {
 if(!supabase?.select)throw new TypeError('session assurance needs a server reader');
 async function readSession({merchantId,userId,sessionId,module}) {
  if(!UUID.test(sessionId??'')||!UUID.test(merchantId??'')||!UUID.test(userId??''))return fail('SOURCE_SESSION_REQUIRED');
  const rows=await supabase.select('app_sessions',{select:'id,merchant_id,user_id,module,created_at,last_seen_at,expires_at,revoked_at',id:'eq.'+sessionId,merchant_id:'eq.'+merchantId,user_id:'eq.'+userId,module:'eq.'+module,limit:'2'});
  if(!Array.isArray(rows)||rows.length!==1)return fail('SOURCE_SESSION_INVALID');
  const s=rows[0],t=now();
  if(!same(s.id,sessionId)||!same(s.merchant_id,merchantId)||!same(s.user_id,userId)||s.module!==module||s.revoked_at||![s.created_at,s.last_seen_at,s.expires_at].every(x=>Number.isFinite(stamp(x)))||stamp(s.created_at)>t+30000||stamp(s.last_seen_at)>t+30000||stamp(s.expires_at)<=t||t-stamp(s.last_seen_at)>=config.idleMs)return fail('SOURCE_SESSION_INVALID');
  return {ok:true,session:s};
 }
 async function activeCore({merchantId,userId}) {
  const ms=await supabase.select('merchant_members',{select:'merchant_id,user_id,status,removed_at',merchant_id:'eq.'+merchantId,user_id:'eq.'+userId,limit:'2'});
  if(!Array.isArray(ms)||ms.length!==1||!same(ms[0].merchant_id,merchantId)||!same(ms[0].user_id,userId)||ms[0].status!=='ACTIVE'||ms[0].removed_at)return false;
  const es=await supabase.select('module_entitlements',{select:'merchant_id,module_code,status',merchant_id:'eq.'+merchantId,module_code:'eq.sourcing',limit:'2'});
  return Array.isArray(es)&&es.length===1&&same(es[0].merchant_id,merchantId)&&es[0].module_code==='sourcing'&&es[0].status==='ACTIVE';
 }
 async function mfaEvidence(input,session,depth=0,requireProof=true) {
  const shared={merchant_id:'eq.'+input.merchantId,user_id:'eq.'+input.userId,module:'eq.'+input.module,outcome:'eq.SUCCESS',limit:'2'};
  const opened=await supabase.select('identity_events',{...shared,select:'merchant_id,user_id,session_id,module,event_type,outcome,correlation_id,occurred_at',session_id:'eq.'+input.sessionId,event_type:'eq.SESSION_OPENED'});
  const good=(e,type)=>e&&same(e.merchant_id,input.merchantId)&&same(e.user_id,input.userId)&&e.module===input.module&&e.outcome==='SUCCESS'&&e.event_type===type;
  if(!Array.isArray(opened)||opened.length!==1||!good(opened[0],'SESSION_OPENED')||!same(opened[0].session_id,input.sessionId)||!UUID.test(opened[0].correlation_id??''))return fail('MFA_SESSION_UNPROVEN');
  const correlation=opened[0].correlation_id;
  const auth=await supabase.select('identity_events',{...shared,select:'merchant_id,user_id,module,event_type,outcome,correlation_id,occurred_at,detail',correlation_id:'eq.'+correlation,event_type:'eq.AUTH_SUCCEEDED'});
  if(!Array.isArray(auth)||auth.length!==1||!good(auth[0],'AUTH_SUCCEEDED')||!same(auth[0].correlation_id,correlation))return fail('MFA_SESSION_UNPROVEN');
  const a=auth[0],gap=stamp(session.created_at)-stamp(a.occurred_at);
  if(!Number.isFinite(gap)||gap<0||gap>120000)return fail('MFA_SESSION_UNPROVEN');
  if(input.module==='sourcing'&&!requireProof)return {ok:true};
  if(input.module==='sourcing'&&methods.has(a.detail?.mfa)&&!a.detail?.sourceSessionId)return {ok:true,verifiedAt:new Date(stamp(a.occurred_at)).toISOString(),method:a.detail.mfa};
  if(depth!==0||input.module==='sourcing'||!UUID.test(a.detail?.sourceSessionId??''))return fail('MFA_SESSION_UNPROVEN');
  const parent={...input,sessionId:a.detail.sourceSessionId.toLowerCase(),module:'sourcing'};
  const root=await readSession(parent);if(!root.ok)return root;
  if(!(await activeCore(parent)))return fail('SOURCE_SESSION_INVALID');
  return mfaEvidence(parent,root.session,depth+1,requireProof);
 }
 return Object.freeze({async check({merchantId,userId,sessionId,module='sourcing',requireMfa=false,maxMfaAgeMs=null}) {
  const input={merchantId:String(merchantId??'').toLowerCase(),userId:String(userId??'').toLowerCase(),sessionId:String(sessionId??'').toLowerCase(),module};
  try {
   const loaded=await readSession(input);if(!loaded.ok)return loaded;
   if(module==='sourcing'&&!(await activeCore(input)))return fail('SOURCE_SESSION_INVALID');
   const proof=(requireMfa||module!=='sourcing')?await mfaEvidence(input,loaded.session,0,requireMfa):{ok:true};if(!proof.ok)return proof;
   if(maxMfaAgeMs!==null&&(!requireMfa||!Number.isFinite(maxMfaAgeMs)||maxMfaAgeMs<0||now()-stamp(proof.verifiedAt)>maxMfaAgeMs))return fail('MFA_STEP_UP_REQUIRED');
   return proof;
  }catch{return fail('SESSION_ASSURANCE_UNAVAILABLE');}
 }});
}
