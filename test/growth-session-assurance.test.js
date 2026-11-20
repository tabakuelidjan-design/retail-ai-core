import test from 'node:test';
import assert from 'node:assert/strict';
import {assuranceFixture} from './fixtures/session-assurance.js';
import {openSessionForHandoff} from '../src/identity/handoff.js';
import {createSessionAssurance} from '../src/identity/session-assurance.js';
import {createMfaRule} from '../src/settings-security/mfa-rule.js';
import {buildGrowthGate} from '../src/growth/server/hosted-main.js';
import {createHostedGrowth} from '../src/growth/server/hosted.js';
test('Growth gate accepts a linked MFA session, then refuses data before reads after root revocation or storage failure',async()=>{
 const f=assuranceFixture();const r=await openSessionForHandoff({supabase:f.db,merchantId:f.merchantId,moduleCode:'growth',userId:f.userId,authSessionId:f.sessionId,requireCoreSession:true,absoluteMs:3600000});assert.equal(r.ok,true);const sid=f.tables.app_sessions.find(s=>s.module==='growth').id;
 const access={ok:true,merchantId:f.merchantId,userId:f.userId,sessionId:sid,module:'growth',role:'OWNER'};let reads=0;
 const identity={context:{module:'growth'},authenticateAndOpenSession:async()=>({ok:false}),resolveAccessSession:async()=>access};
 const security={module:'growth',guardRead:()=>({ok:true}),guardMutation:async()=>({ok:true,access}),cookies:{read:()=>({session:r.token})}};
 const gate=buildGrowthGate({}, {merchantId:f.merchantId},{identity,security,mfaRule:createMfaRule({supabase:f.db,ttlMs:0}),sessionAssurance:createSessionAssurance({supabase:f.db})});
 const app=createHostedGrowth({gate,merchantId:f.merchantId,historyScope:'synthetic',ssoOnly:true,app:(_req,res)=>{reads++;res.writeHead(200);res.end('{}');},store:{list:async()=>[],put:async()=>({ok:true})}});
 const call=async()=>{const out={};await app({method:'GET',url:'/api/growth/dropoff',headers:{}},{writeHead(status){out.status=status;},end(body){out.body=JSON.parse(body);}});return out;};
 assert.equal((await call()).status,200);assert.equal(reads,1);f.tables.app_sessions[0].revoked_at=new Date().toISOString();assert.equal((await call()).status,401);assert.equal(reads,1);f.db.select=async()=>{throw Error('synthetic unavailable');};assert.equal((await call()).status,503);assert.equal(reads,1);
});
