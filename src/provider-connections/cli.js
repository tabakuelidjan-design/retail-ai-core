#!/usr/bin/env node
// Operator / developer surface of Provider Provisioning (there is no canonical front end yet: the Connection Center UI is an open dependency).
//
//   node src/provider-connections/cli.js status
//   node src/provider-connections/cli.js connect <instagram|tiktok|google_business_profile>      prints the authorization URL to open
//   node src/provider-connections/cli.js serve-callback                                          receives the provider redirect (127.0.0.1 by default)
//   node src/provider-connections/cli.js targets <session_ref>                                   accounts / locations the merchant authorized
//   node src/provider-connections/cli.js select <session_ref> <external_id>                      the EXPLICIT choice
//   node src/provider-connections/cli.js verify <connector_id>
//   node src/provider-connections/cli.js disconnect <connector_id>
//   node src/provider-connections/cli.js readiness
//
// It prints ids, states, scopes and safe codes - NEVER a token, a code, a secret or a raw state (every line passes through the redaction
// guard). It publishes nothing. The merchant is the server-side tenant (NORDLA_MERCHANT_ID), never a command-line value.

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { assessProviderProvisioningReadiness } from './readiness.js';
import { PC_ERROR as E, PROVIDERS, ProvisioningError } from './constants.js';
import { assertNoSecrets, redact } from './validation.js';

const USAGE = 'usage: status | connect <provider> | serve-callback | targets <session_ref> | select <session_ref> <external_id> | verify <connector_id> | disconnect <connector_id> | readiness';

/**
 * The authorization URL is the one value the operator MUST see: it carries the one-time CSRF `state` (public by design - it travels through
 * the browser; only its hash is stored) and the PKCE challenge. It is let through only when it is an https URL without any secret parameter.
 */
function authorizationUrlOf(value) {
  const url = new URL(value);
  const forbidden = ['client_secret', 'access_token', 'refresh_token', 'code', 'code_verifier'];
  if (url.protocol !== 'https:' || forbidden.some((key) => url.searchParams.has(key))) throw new ProvisioningError(E.INVALID_FIELD, 'the authorization URL is not safe to print');
  return { printable_url: url.toString() };
}

function emit(io, value) {
  const printable = value?.open_this_url_in_a_browser?.printable_url;
  const { open_this_url_in_a_browser: _url, ...rest } = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const safe = redact(printable ? rest : value);
  assertNoSecrets(safe, 'cli output');
  io.out(typeof safe === 'string' ? safe : JSON.stringify(printable ? { open_this_url_in_a_browser: printable, ...safe } : safe, null, 2));
}

/**
 * A minimal callback receiver. Local only by default (127.0.0.1), configurable host / port; a provider that requires a public HTTPS
 * redirect URI needs a real deployment in front of it (an open dependency) - no tunnel is ever opened automatically. It answers with a
 * fixed text: the code and the state are never echoed.
 */
export function createCallbackServer({ provisioning, tenant, host = '127.0.0.1', port = 0, onResult = () => {}, basePath = '/oauth/callback' }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const match = new RegExp(`^${basePath}/([a-z_]+)$`).exec(url.pathname);
    const reply = (status, text) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(text); };
    if (req.method !== 'GET' || !match || !PROVIDERS.includes(match[1])) { reply(404, 'not found'); return; }
    try {
      const result = await provisioning.handleCallback({ tenant, provider: match[1], query: Object.fromEntries(url.searchParams) });
      onResult({ ok: true, session_ref: result.session_ref, provider: match[1] });
      reply(200, 'Authorization received. Go back to the operator console to choose the account.');
    } catch (error) {
      const code = error?.detail?.oauth ?? error?.code ?? 'ERROR';
      onResult({ ok: false, code, provider: match[1] });
      reply(400, `Authorization failed (${String(code).replace(/[^A-Za-z0-9_]/g, '')}).`);
    }
  });
  return {
    server,
    listen: () => new Promise((resolve) => { server.listen(port, host, () => resolve(server.address())); }),
    close: () => new Promise((resolve) => { server.close(() => resolve()); }),
  };
}

/**
 * @param {string[]} argv the arguments after the script name
 * @param {{ runtime, tenant, io: {out: Function, err: Function}, facts?: object, serve?: Function }} deps
 * @returns {Promise<number>} the exit code
 */
export async function runCli(argv, {
  runtime, tenant, io, facts = {}, serve = createCallbackServer,
}) {
  const [command, a, b] = argv;
  try {
    switch (command) {
      case 'status': emit(io, await runtime.connectionCenter.listConnections({ tenant })); break;
      case 'connect': {
        if (!PROVIDERS.includes(a)) throw new ProvisioningError(E.PROVIDER_UNSUPPORTED, `provider must be one of ${PROVIDERS.join(', ')}`);
        const started = await runtime.connectionCenter.startConnect({ tenant, provider: a, returnTo: null, actorRef: 'cli' });
        emit(io, { open_this_url_in_a_browser: authorizationUrlOf(started.authorization_url), session_ref: started.session_ref, expires_at: started.expires_at, then: 'run serve-callback, consent at the provider, then: targets <session_ref> and select <session_ref> <external_id>' });
        break;
      }
      case 'serve-callback': {
        const server = serve({ provisioning: runtime.provisioning, tenant, host: process.env.PROVIDER_CALLBACK_HOST ?? '127.0.0.1', port: Number(process.env.PROVIDER_CALLBACK_PORT ?? 8788), onResult: (r) => emit(io, r) });
        const address = await server.listen();
        emit(io, { listening: `${address.address}:${address.port}`, note: 'local only unless PROVIDER_CALLBACK_HOST says otherwise; providers that need an HTTPS redirect URI need a real deployment in front of this' });
        return 0;
      }
      case 'targets': emit(io, await runtime.connectionCenter.listTargets({ tenant, sessionRef: a })); break;
      case 'select': emit(io, await runtime.connectionCenter.selectTarget({ tenant, sessionRef: a, externalId: b, actorRef: 'cli' })); break;
      case 'verify': emit(io, await runtime.connectionCenter.verify({ tenant, connectorId: a })); break;
      case 'disconnect': emit(io, await runtime.connectionCenter.disconnect({ tenant, connectorId: a })); break;
      case 'readiness': emit(io, assessProviderProvisioningReadiness(facts)); break;
      default: io.err(USAGE); return 2;
    }
    return 0;
  } catch (error) {
    io.err(JSON.stringify(redact({ error: error?.code ?? 'ERROR', message: error?.message ?? 'failed', detail: error?.detail ?? {} })));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [{ createSupabaseClient, loadSupabaseConfigFromEnv }, { resolveTenant }, { createProviderConnectionsRuntime }] = await Promise.all([
    import('../supabase/client.js'), import('../tenant/index.js'), import('./runtime.js'),
  ]);
  try {
    const supabase = createSupabaseClient(loadSupabaseConfigFromEnv());
    const tenant = await resolveTenant({ supabase });
    const runtime = createProviderConnectionsRuntime({ supabase, fetch: globalThis.fetch });
    process.exitCode = await runCli(process.argv.slice(2), { runtime, tenant, io: { out: (s) => console.log(s), err: (s) => console.error(s) } });
  } catch (error) {
    console.error(JSON.stringify(redact({ error: error?.code ?? 'ERROR', message: error?.message ?? 'failed' })));
    process.exitCode = 1;
  }
}
