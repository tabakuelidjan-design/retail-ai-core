#!/usr/bin/env node
// HOSTED Nordla Growth (the "growth" service of src/service-start.js): the Growth screen on a public https address behind the Core identity.
// The configuration must be complete or nothing starts (each missing piece has its own code). It reuses China Sourcing's hosted checks
// (hostedConfig, project pin, pinned-project verification) with Growth's own variable names:
//   GROWTH_HOSTED=1                         explicit opt-in (without it the process refuses to start: the local launcher is serve.js)
//   NORDLA_MERCHANT_ID                      the merchant (UUID) this server works for - never taken from a request
//   GROWTH_PUBLIC_ORIGIN                    the exact public origin, https only (e.g. https://app.nordla.app); its host is the only Host accepted
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, NORDLA_IDENTITY_RATE_LIMIT_KEY, NORDLA_CSRF_KEY, NORDLA_SUPABASE_PROJECT_REF (required on Railway)
//   MERCHANT_TIMEZONE                       unless the merchant profile carries one (no silent UTC)
// Optional: GROWTH_HOST (default 0.0.0.0), PORT / GROWTH_PORT. The data this server reads is the merchant's synced data (read only) and its import files;
// the only thing it writes is the merchant's own follow-up (growth_follow_up). Fictitious data and scenarios stay in the local preview.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createGrowthApp } from './app.js';
import { buildGrowthSources } from './sources.js';
import { createHostedGrowth } from './hosted.js';
import { createPersonalizerCollector, collectChannels } from './collect-personalizer.js';
import { createSupabaseFollowUpStore } from './follow-up-store.js';
import { hostedConfig, verifyPinnedProject } from '../../sourcing/server/hosted.js';
import { createSessionGate } from '../../sourcing/server/session-gate.js';
import { createMfaRule } from '../../settings-security/mfa-rule.js';
import { createGrowthSso } from './sso.js';
import { createHandoffVerifier, openSessionForHandoff, HANDOFF_MIN_SECRET_LENGTH } from '../../identity/handoff.js';
import { createIdentityService, loadIdentityServiceEnv } from '../../identity/service.js';
import { createHttpSecurity } from '../../security/index.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../../supabase/client.js';

/** The hosted configuration of Growth: the Sourcing checks with Growth's names (the Sourcing merchant-profile requirement does not apply). */
export function growthHostedConfig(env = process.env) {
  if (String(env.GROWTH_HOSTED ?? '').trim() !== '1') throw Object.assign(new Error('GROWTH_HOSTED=1 is required: this is the hosted server (the local launcher is src/growth/server/serve.js)'), { code: 'HOSTED_NOT_ENABLED' });
  return hostedConfig({ ...env, SOURCING_PUBLIC_ORIGIN: env.GROWTH_PUBLIC_ORIGIN, SOURCING_HOST: env.GROWTH_HOST, SOURCING_MERCHANT_ID: env.NORDLA_MERCHANT_ID });
}

/** Growth single sign-on from the Nordla server (GROWTH_SSO_SECRET, the same value as on the Nordla server). No secret (or too short): no /sso route, the sign-in form stays the only way in. */
export function buildGrowthSso(env, hosted, services = null) {
  const secret = String(env.GROWTH_SSO_SECRET ?? ''); if (secret.length < HANDOFF_MIN_SECRET_LENGTH) return null;
  const security = services?.security ?? createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: hosted.allowedHosts, allowedOrigins: [hosted.origin], moduleCode: 'growth', csrfKey: env.NORDLA_CSRF_KEY });
  const supabase = services?.supabase ?? createSupabaseClient(loadSupabaseConfigFromEnv(env)); const sessions = loadIdentityServiceEnv(env).sessions;
  return createGrowthSso({ verifier: createHandoffVerifier({ secret, merchantId: hosted.merchantId }), openSession: (userId) => openSessionForHandoff({ supabase, merchantId: hosted.merchantId, moduleCode: 'growth', userId, absoluteMs: sessions.absoluteMs }), cookiesFor: (token) => [security.cookies.sessionCookie(token), security.cookies.csrfCookie(security.csrfTokenFor(token))] });
}

/** The Core identity sign-in for the 'growth' module of THIS merchant. `services` lets a test inject both collaborators. */
export function buildGrowthGate(env, hosted, services = null) {
  const identity = services?.identity ?? createIdentityService({ merchantId: hosted.merchantId, moduleCode: 'growth', supabase: createSupabaseClient(loadSupabaseConfigFromEnv(env)), ...loadIdentityServiceEnv(env) });
  const security = services?.security ?? createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: hosted.allowedHosts, allowedOrigins: [hosted.origin], moduleCode: 'growth', csrfKey: env.NORDLA_CSRF_KEY });
  const mfaRule = services?.mfaRule ?? (services?.identity ? null : createMfaRule({ supabase: createSupabaseClient(loadSupabaseConfigFromEnv(env)), ttlMs: 0 }));
  return createSessionGate({ identity, security, moduleCode: 'growth', mfaRule });
}

export async function startGrowthHosted({ env = process.env, log = console.log, port = Number(env.GROWTH_PORT || env.PORT || 8788), services = null, fetchImpl } = {}) {
  const hosted = growthHostedConfig(env);
  if (hosted.supabaseRef) log(`Supabase project check (${hosted.supabaseRef}): ${await verifyPinnedProject(env, hosted, fetchImpl ? { fetchImpl } : {})}`);
  const sources = services?.sources ?? await buildGrowthSources(env, { log });
  if (sources.merchantId !== hosted.merchantId) throw Object.assign(new Error('the resolved merchant is not NORDLA_MERCHANT_ID'), { code: 'HOSTED_MERCHANT_MISMATCH' });
  const gate = buildGrowthGate(env, hosted, services);
  const { guide, ...rest } = sources;
  const app = createGrowthApp({ ...rest, guide: { previewUrl: null, isPreview: false, hosted: true }, hosted: true });
  const store = services?.store ?? createSupabaseFollowUpStore(sources.supabase ?? createSupabaseClient(loadSupabaseConfigFromEnv(env)));
  const historyScope = createHash('sha256').update(hosted.merchantId).digest('hex');
  const collectOrigins = String(env.GROWTH_COLLECT_ORIGINS ?? 'https://habb.be').split(',').map((s) => s.trim()).filter(Boolean); // the shop origins allowed to send personalizer events
  const collect = sources.personalizerStore ? createPersonalizerCollector({ store: sources.personalizerStore, allowedOrigins: collectOrigins, channels: collectChannels(env) }) : null;
  const sso = buildGrowthSso(env, hosted, services);
  const ssoOnly = env.NORDLA_SSO_ONLY === '1';
  if (ssoOnly && !sso) throw new Error('SSO-only Growth requires a configured Nordla handoff');
  const handler = createHostedGrowth({ gate, merchantId: hosted.merchantId, historyScope, app, store, collect, sso, ssoOnly, homeUrl: (() => { try { const u = new URL(String(env.NORDLA_HOME_URL ?? '').trim()); return u.protocol === 'https:' && !u.username && !u.password ? u.origin : null; } catch { return null; } })() });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, hosted.host, resolve); });
  log(`Nordla Growth HOSTED for ${hosted.origin}: Core identity sign-in (module growth, merchant ${hosted.merchantId}), follow-up on the server, port ${server.address().port}.`);
  return { server, port: server.address().port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGrowthHosted().catch((e) => { console.error(`growth hosted failed to start${e.code ? ` (${e.code})` : ''}: ${e.message}`); process.exit(1); });
}
