import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createEventLog} from '../../src/identity/events.js';
import {createSessionAssurance} from '../../src/identity/session-assurance.js';
import {createMfaRule} from '../../src/settings-security/mfa-rule.js';
import {openSessionForHandoff} from '../../src/identity/handoff.js';
export async function verifyNativeSessionAssurance(pg,merchantId){
 const userId=randomUUID(),at=new Date(),correlation=randomUUID();
 await pg.query("insert into auth.users(id,email) values($1,$2)",[userId,'synthetic-recovery@security.example']);
 assert.equal((await pg.query("select public.identity_member_bootstrap_owner($1,$2,$3,$4,'sourcing') result",[merchantId,userId,at,randomUUID()])).rows[0].result.ok,true);
 for(const module of ['sourcing','growth'])await pg.query("select public.identity_module_set($1,$2,'ACTIVE','provisioning:synthetic',$3,$4)",[merchantId,module,at,randomUUID()]);
 await pg.query("insert into auth.mfa_factors(user_id,status,factor_type) values($1,'verified','totp')",[userId]);
 assert.equal((await pg.query("select public.security_set_require_mfa($1,$2,true,$3,$4,'sourcing') result",[merchantId,userId,at,randomUUID()])).rows[0].result.ok,true);
 const ident=n=>{assert.match(n,/^[a-z_][a-z0-9_]*$/);return '"'+n+'"';};
 const query=async(sql,values)=>{await pg.query('begin');try{await pg.query('set local role service_role');const out=await pg.query(sql,values);await pg.query('commit');return out;}catch(e){await pg.query('rollback');throw e;}};
 const db={select:async(table,filters)=>{const cols=filters.select==='*'?'*':filters.select.split(',').map(ident).join(',');const values=[],where=[];for(const[k,v]of Object.entries(filters))if(!['select','limit','order'].includes(k)){assert.ok(v.startsWith('eq.'));values.push(v.slice(3));where.push(ident(k)+' = $'+values.length);}return (await query('select '+cols+' from public.'+ident(table)+(where.length?' where '+where.join(' and '):'')+' limit '+Number(filters.limit??100),values)).rows;},insert:async(table,rows)=>{assert.equal(rows.length,1);const ks=Object.keys(rows[0]);return(await query('insert into public.'+ident(table)+' ('+ks.map(ident).join(',')+') values ('+ks.map((k,i)=>'$'+(i+1)).join(',')+') returning *',ks.map(k=>rows[0][k]))).rows;},rpc:async(fn,args)=>{assert.ok(['identity_open_session','security_mfa_status'].includes(fn));const keys=Object.keys(args);return(await query('select public.'+ident(fn)+'('+keys.map((k,i)=>ident(k)+' => $'+(i+1)).join(',')+') result',keys.map(k=>args[k]))).rows[0].result;}};
 const events=createEventLog({supabase:db});await events.record({merchantId,userId,module:'sourcing',type:'AUTH_SUCCEEDED',outcome:'SUCCESS',correlationId:correlation,detail:{mfa:'TOTP'}});
 const root=(await db.rpc('identity_open_session',{p_user:userId,p_merchant:merchantId,p_module:'sourcing',p_token_hash:randomBytes(32).toString('hex'),p_now:new Date().toISOString(),p_expires_at:new Date(Date.now()+3600000).toISOString(),p_correlation:correlation}));assert.equal(root.ok,true);
 const checker=createSessionAssurance({supabase:db}),rule=createMfaRule({supabase:db,ttlMs:0});const input={merchantId,userId,sessionId:root.session_id,module:'sourcing',requireMfa:true};
 const rootProof=await checker.check(input);assert.equal(rootProof.ok,true,rootProof.code);assert.equal(await rule.blocked(input),false);
 const child=await openSessionForHandoff({supabase:db,merchantId,moduleCode:'growth',userId,authSessionId:root.session_id,requireCoreSession:true,absoluteMs:3600000});assert.equal(child.ok,true);
 const growth=(await pg.query("select id from app_sessions where merchant_id=$1 and user_id=$2 and module='growth'",[merchantId,userId])).rows[0];assert.equal((await checker.check({...input,sessionId:growth.id,module:'growth'})).ok,true);
 await pg.query("update app_sessions set revoked_at=now(),revoked_reason='REVOKED' where id=$1",[root.session_id]);assert.equal((await checker.check(input)).ok,false);assert.equal((await checker.check({...input,sessionId:growth.id,module:'growth'})).ok,false);
 assert.equal(await rule.blocked({...input,sessionId:growth.id,module:'growth'}),true);
 return 'native service_role: root MFA proof, Growth parent binding and cascade revocation';
}
