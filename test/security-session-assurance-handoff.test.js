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
test('signed ticket and handoff preserve the source id; forged parent claims cannot be substituted',async()=>{const f=assuranceFixture();const ticket=issueTicket({secret:K_FINANCE,merchantId:f.merchantId,person:{userId:f.userId,role:'OWNER',module:'finance',authSessionId:f.sessionId}});assert.equal(createTicketVerifier({secret:K_FINANCE,merchantId:f.merchantId,requirePerson:true}).verify(ticket).claims.authSessionId,f.sessionId);const handoff=issueHandoff({secret:K_FINANCE,merchantId:f.merchantId,userId:f.userId,authSessionId:f.sessionId});assert.equal(createHandoffVerifier({secret:K_FINANCE,merchantId:f.merchantId}).verify(handoff).authSessionId,f.sessionId);const [body,sig]=ticket.split('.');const claim=JSON.parse(Buffer.from(body,'base64url'));claim.sid=randomUUID();const forged=Buffer.from(JSON.stringify(claim)).toString('base64url')+'.'+sig;assert.equal(createTicketVerifier({secret:K_FINANCE,merchantId:f.merchantId}).verify(forged).ok,false);});
test('Growth handoff journals the parent and its session loses access after Core revocation',async()=>{const f=assuranceFixture();const opened=await openSessionForHandoff({supabase:f.db,merchantId:f.merchantId,moduleCode:'growth',userId:f.userId,authSessionId:f.sessionId,requireCoreSession:true,absoluteMs:3600000});assert.equal(opened.ok,true);const child=f.tables.app_sessions.find(s=>s.module==='growth');const checker=createSessionAssurance({supabase:f.db});const input={merchantId:f.merchantId,userId:f.userId,sessionId:child.id,module:'growth',requireMfa:true};assert.equal((await checker.check(input)).ok,true);f.tables.app_sessions[0].revoked_at=new Date().toISOString();assert.equal((await checker.check(input)).ok,false);});
