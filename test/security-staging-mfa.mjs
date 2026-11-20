// Opt-in STAGING ONLY. Creates one synthetic merchant/account, sends no email, deletes the Auth account afterward.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {createSupabaseClient,loadSupabaseConfigFromEnv} from '../src/supabase/client.js';
import {createIdentityService,loadIdentityServiceEnv} from '../src/identity/service.js';
import {createMfaProvider} from '../src/settings-security/mfa.js';
import {createAdminAuth} from '../src/settings-security/admin-auth.js';
import {createMfaRule} from '../src/settings-security/mfa-rule.js';
import {createSecurityService} from '../src/settings-security/service.js';
import {createAccessChecker} from '../src/identity/sso-contract.js';
import {createSessionAssurance} from '../src/identity/session-assurance.js';
import {openSessionForHandoff} from '../src/identity/handoff.js';
const env=process.env;
if(env.NORDLA_SECURITY_STAGING_DRILL!=='1'||new URL(env.SUPABASE_URL).hostname!=='fvhiammdskpcnfodsnrc.supabase.co')throw Error('STAGING_DRILL_NOT_AUTHORIZED');
const db=createSupabaseClient(loadSupabaseConfigFromEnv(env)),merchantId=randomUUID(),email='security-drill-'+randomBytes(8).toString('hex')+'@nordla-test.example',password=randomBytes(32).toString('base64url')+'A1!';
const headers={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'};
const call=async(path,method,body)=>{const r=await fetch(env.SUPABASE_URL+'/auth/v1'+path,{method,headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});let data;try{data=await r.json();}catch{}return{status:r.status,data};};
let userId=null,identity,old,fresh,growth;const checks=[],cleanup={};
const totp=secret=>{const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';for(const c of secret.toUpperCase().replace(/=+$/,''))bits+=alphabet.indexOf(c).toString(2).padStart(5,'0');const key=Buffer.from(bits.match(/.{8}/g).map(b=>parseInt(b,2)));const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const h=createHmac('sha1',key).update(counter).digest();const offset=h[19]&15;return String((h.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');};
try{
 const made=await call('/admin/users','POST',{email,password,email_confirm:true,user_metadata:{purpose:'Nordla security synthetic drill 2026-11-20'}});assert.equal(made.status,200,'SYNTHETIC_AUTH_CREATE_REFUSED');userId=made.data.id;
 await db.insert('merchants',[{id:merchantId,name:'Synthetic security drill — no real business',source_system:'shopify',source_id:'security-drill-'+randomUUID()}]);
 assert.equal((await db.rpc('identity_member_bootstrap_owner',{p_merchant:merchantId,p_user:userId,p_now:new Date().toISOString(),p_correlation:randomUUID(),p_module:'sourcing'})).ok,true);
 for(const module of ['sourcing','finance','analytics','growth'])await db.rpc('identity_module_set',{p_merchant:merchantId,p_module:module,p_status:'ACTIVE',p_source:'provisioning:manual',p_now:new Date().toISOString(),p_correlation:randomUUID()});
 identity=createIdentityService({merchantId,moduleCode:'sourcing',supabase:db,...loadIdentityServiceEnv({...env,NORDLA_IDENTITY_RATE_LIMIT_KEY:randomBytes(32).toString('base64url')})});
 old=await identity.authenticateAndOpenSession({email,password,ipAddress:'127.0.0.1'});assert.equal(old.ok,true,'PRE_MFA_LOGIN_REFUSED');checks.push('password-only Core session opened before enrolment');
 const adminAuth=createAdminAuth({url:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY});const mfa=createMfaProvider({config:{baseUrl:env.SUPABASE_URL,anonKey:env.SUPABASE_ANON_KEY},adminAuth});const enrolled=await mfa.enroll(email,password);assert.equal(enrolled.ok,true,'TOTP_ENROLMENT_REFUSED');const counter=Math.floor(Date.now()/30000);assert.equal((await mfa.confirm(email,password,enrolled.factorId,totp(enrolled.secret))).ok,true,'TOTP_CONFIRM_REFUSED');
 const rule=createMfaRule({supabase:db,ttlMs:0}),service=createSecurityService({supabase:db,context:{merchantId},features:{mfa:true},mfaRule:rule});await assert.rejects(service.saveTeamRules(old.session,{requireMfa:true}),e=>e.code==='REAUTHENTICATION_REQUIRED');checks.push('enrolled factor does not let the old password-only session change MFA policy');
 if(Math.floor(Date.now()/30000)===counter)await new Promise(r=>setTimeout(r,30000-Date.now()%30000+1200));
 fresh=await identity.authenticateAndOpenSession({email,password,code:totp(enrolled.secret),ipAddress:'127.0.0.1'});assert.equal(fresh.ok,true,'FRESH_TOTP_LOGIN_REFUSED');assert.equal((await service.saveTeamRules(fresh.session,{requireMfa:true})).enabled,true);assert.equal(await rule.blocked(old.session),true);assert.equal(await rule.blocked(fresh.session),false);checks.push('real Supabase TOTP login enables mandatory MFA; old session refused and fresh session accepted');
 const access=createAccessChecker({supabase:db,merchantId,requireCoreSession:true});for(const module of ['finance','analytics']){assert.equal((await access({merchantId,userId,role:'OWNER',module,authSessionId:fresh.session.sessionId})).ok,true);assert.equal((await access({merchantId,userId,role:'OWNER',module,authSessionId:old.session.sessionId})).ok,false);}checks.push('Finance and Analytics accept the MFA Core session and reject the old one');
 growth=await openSessionForHandoff({supabase:db,merchantId,moduleCode:'growth',userId,authSessionId:fresh.session.sessionId,requireCoreSession:true,absoluteMs:3600000});assert.equal(growth.ok,true);const row=(await db.select('app_sessions',{select:'id',merchant_id:'eq.'+merchantId,user_id:'eq.'+userId,module:'eq.growth'}))[0];const proof=createSessionAssurance({supabase:db});assert.equal((await proof.check({merchantId,userId,sessionId:row.id,module:'growth',requireMfa:true})).ok,true);
 await identity.logoutSession(fresh.token);for(const module of ['finance','analytics'])assert.equal((await access({merchantId,userId,role:'OWNER',module,authSessionId:fresh.session.sessionId})).ok,false);assert.equal((await proof.check({merchantId,userId,sessionId:row.id,module:'growth',requireMfa:true})).ok,false);checks.push('revoking Core closes Finance/Analytics checks and linked Growth proof');
}catch(e){console.log(JSON.stringify({ok:false,checks,errorCode:e.code??e.name,error:String(e.message).replace(/https?:[^ ]+/g,'[redacted]').slice(0,200)}));process.exitCode=1;
}finally{
 if(identity)for(const s of [old,fresh])if(s?.token)try{await identity.logoutSession(s.token);}catch{}
 if(growth?.token){try{const {createIdentityService}=await import('../src/identity/service.js');const g=createIdentityService({merchantId,moduleCode:'growth',supabase:db,...loadIdentityServiceEnv({...env,NORDLA_IDENTITY_RATE_LIMIT_KEY:randomBytes(32).toString('base64url')})});await g.logoutSession(growth.token);cleanup.customSessionsClosed=true;}catch{cleanup.customSessionsClosed=false;}}
 if(userId){const removed=await call('/admin/users/'+userId,'DELETE');cleanup.syntheticAuthDeleted=[200,204].includes(removed.status);if(!cleanup.syntheticAuthDeleted){const banned=await call('/admin/users/'+userId,'PUT',{ban_duration:'876000h'});cleanup.syntheticAuthBanned=banned.status===200;}}
 for(const module of ['sourcing','finance','analytics','growth'])try{const r=await db.rpc('identity_module_set',{p_merchant:merchantId,p_module:module,p_status:'SUSPENDED',p_source:'provisioning:security-drill',p_now:new Date().toISOString(),p_correlation:randomUUID()});if(!r.ok)throw Error('module');}catch{cleanup.moduleSuspensionFailed=true;}
 try{await db.delete('merchants',{id:'eq.'+merchantId});cleanup.syntheticMerchantDeleted=true;}catch{cleanup.syntheticMerchantDeleted=false;}
 if(userId){try{cleanup.openSessions=(await db.select('app_sessions',{select:'id',merchant_id:'eq.'+merchantId,user_id:'eq.'+userId,revoked_at:'is.null'})).length;}catch{cleanup.openSessions=null;}if(cleanup.openSessions!==0||(!cleanup.syntheticAuthDeleted&&!cleanup.syntheticAuthBanned))process.exitCode=1;}
 console.log(JSON.stringify({ok:!process.exitCode,checks,cleanup,realBusinessChanged:false,emailSent:false,execution:'real staging Auth/REST with local application functions; no browser or deployed UI test'}));
}
