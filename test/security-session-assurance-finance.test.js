import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {issueTicket,createTicketVerifier,ANALYTICS_SSO_AUDIENCE} from '../src/finance/sso-ticket.js';
import {createAccessChecker} from '../src/identity/sso-contract.js';
import {createGuard} from '../src/analytics-premium/server/hosting.js';
import {openSessionForHandoff,issueHandoff,createHandoffVerifier} from '../src/identity/handoff.js';
import {createSessionAssurance} from '../src/identity/session-assurance.js';
import {startApp} from './finance-dashboard-helpers.js';
import {K_FINANCE,K_ANALYTICS} from './fixtures/sso-test-keys.js';
import {assuranceFixture} from './fixtures/session-assurance.js';
const HOST='analytics.example';
const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(status,h){this.status=status;Object.assign(this.headers,h);},end(){}});
async function analyticsRequest(guard,url,cookie){const res=response();const ok=await guard({method:'GET',url,headers:{host:HOST,...(cookie?{cookie}:{})},socket:{remoteAddress:'127.0.0.1'}},res);return {ok,res};}
test('Finance HTTP: a real linked MFA proof opens data, revoking Core closes the existing module session',async()=>{const f=assuranceFixture();const a=await startApp({merchantId:f.merchantId,deps:{ssoOnly:true,sso:{secret:K_FINANCE,requirePerson:true,checkAccess:createAccessChecker({supabase:f.db,merchantId:f.merchantId,requireCoreSession:true})}}});try{const ticket=issueTicket({secret:K_FINANCE,merchantId:f.merchantId,person:{userId:f.userId,role:'OWNER',module:'finance',authSessionId:f.sessionId}});const entry=await fetch(a.base+'/sso?t='+ticket,{redirect:'manual'});assert.equal(entry.status,302);const cookie=entry.headers.get('set-cookie').split(';')[0];const data=()=>fetch(a.base+'/api/overview',{headers:{cookie}});assert.equal((await data()).status,200);f.tables.app_sessions[0].revoked_at=new Date().toISOString();assert.equal((await data()).status,401);}finally{await a.close();}});
test('hosted access refuses missing, foreign or unproven parent even with a correctly signed ticket',async()=>{const f=assuranceFixture();const check=createAccessChecker({supabase:f.db,merchantId:f.merchantId,requireCoreSession:true});for(const id of [null,randomUUID()])assert.equal((await check({merchantId:f.merchantId,userId:f.userId,role:'OWNER',module:'finance',authSessionId:id})).ok,false);delete f.tables.identity_events[0].detail.mfa;assert.equal((await check({merchantId:f.merchantId,userId:f.userId,role:'OWNER',module:'finance',authSessionId:f.sessionId})).ok,false);});
