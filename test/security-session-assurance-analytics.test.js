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
test('Analytics HTTP guard preserves the parent id and closes on Core revocation',async()=>{const f=assuranceFixture();const g=createGuard({allowedHosts:[HOST],token:'synthetic analytics token long enough',ssoOnly:true,sso:{secret:K_ANALYTICS,merchantId:f.merchantId,requirePerson:true,checkAccess:createAccessChecker({supabase:f.db,merchantId:f.merchantId,requireCoreSession:true})}});const ticket=issueTicket({secret:K_ANALYTICS,merchantId:f.merchantId,audience:ANALYTICS_SSO_AUDIENCE,person:{userId:f.userId,role:'OWNER',module:'analytics',authSessionId:f.sessionId}});const opened=await analyticsRequest(g,'/sso?t='+ticket);assert.equal(opened.res.status,302);const cookie=opened.res.headers['Set-Cookie'].split(';')[0];assert.equal((await analyticsRequest(g,'/api/products',cookie)).ok,true);f.tables.app_sessions[0].revoked_at=new Date().toISOString();assert.equal((await analyticsRequest(g,'/api/products',cookie)).res.status,401);});
