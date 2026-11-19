#!/usr/bin/env node
// Phase 5 - staging recette: rejoue le parcours Core -> Finance / Analyses avec les comptes fictifs, et imprime un tableau.
// Usage: node scripts/recette-staging.mjs
// Les comptes et mots de passe sont lus depuis NORDLA_RECETTE_ENV (défaut : ~/.nordla-recette/staging-accounts.env), HORS dépôt.
// Aucun mot de passe, cookie, jeton ou ticket n'est affiché.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, cookieHeaderOf, evaluate, renderTable } from './recette-lib.mjs';

const CORE = 'https://sourcing-staging-staging.up.railway.app';
const FIN = 'https://finance-staging-staging.up.railway.app';
const AN = 'https://analytics-staging-staging.up.railway.app';
const envPath = process.env.NORDLA_RECETTE_ENV || join(homedir(), '.nordla-recette', 'staging-accounts.env');
const env = parseEnv(readFileSync(envPath, 'utf8'));
const domain = 'nordla-test.example';
const ACCOUNTS = {
  OWNER: `recette-owner@${domain}`, ACCOUNTANT: `recette-accountant@${domain}`, VIEWER: `recette-viewer@${domain}`,
  SUSPENDED: `recette-suspended@${domain}`, OUTSIDER: `recette-outsider@${domain}`,
};

/** A session of one account: its cookies, and the CSRF header the page sends on every change. */
function session() {
  let cookies = '';
  let csrf = '';
  const absorb = (res) => {
    const list = res.headers.getSetCookie?.() ?? [];
    if (list.length) cookies = [cookies, cookieHeaderOf(list)].filter(Boolean).join('; ');
    const c = cookies.split('; ').find((x) => x.startsWith('__Host-nordla_sourcing_csrf='));
    if (c) csrf = c.slice('__Host-nordla_sourcing_csrf='.length);
  };
  return {
    async login(role) {
      const res = await fetch(`${CORE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: CORE }, body: JSON.stringify({ email: ACCOUNTS[role], password: env[`${role}_PASSWORD`] }) });
      absorb(res);
      const body = await res.json().catch(() => ({}));
      return { status: res.status, role: body.role ?? null };
    },
    async core(method, path, body) {
      const res = await fetch(`${CORE}${path}`, { method, redirect: 'manual', headers: { cookie: cookies, origin: CORE, 'x-nordla-csrf': csrf, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : (body ?? '{}') });
      absorb(res);
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, json };
    },
    /** Opens a module from Core, then follows the one-time ticket to its landing and reads one data route. */
    async open(module, dataPath) {
      const r = await this.core('POST', `/api/core/${module}/open`);
      if (r.status !== 200 || !r.json?.url) return { open: r.status, landing: null, data: null, requestId: r.json?.requestId ?? null };
      const base = new URL(r.json.url).origin;
      const sso = await fetch(r.json.url, { redirect: 'manual' });
      const landingCookie = cookieHeaderOf(sso.headers.getSetCookie?.() ?? []);
      const landing = await fetch(`${base}/`, { headers: { cookie: landingCookie } });
      const data = await fetch(`${base}${dataPath}`, { headers: { cookie: landingCookie } });
      return { open: 200, landing: landing.status, data: data.status, requestId: null, cookie: landingCookie };
    },
    async raw(method, path) {
      const res = await fetch(`${CORE}${path}`, { method, redirect: 'manual', headers: { cookie: cookies, origin: CORE } });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, json, requestId: res.headers.get('x-request-id') };
    },
  };
}

const checks = [];
const add = (id, role, action, observed, expect) => checks.push({ id, role, action, observed, expect });

const owner = session();
const accountant = session();
const viewer = session();
const suspended = session();
const outsider = session();

// 1-4 : propriétaire
const lo = await owner.login('OWNER'); add(1, 'Propriétaire', 'Connexion Core', lo.status, 200);
const ofin = await owner.open('finance', '/api/overview'); add(2, 'Propriétaire', 'Ouvrir Finance depuis Core', ofin.open, 200); add(3, 'Propriétaire', 'Atterrir sur Finance et lire les données', `${ofin.landing}/${ofin.data}`, '200/200');
const oana = await owner.open('analytics', '/api/brief'); add(4, 'Propriétaire', 'Ouvrir Analyses depuis Core et lire les données', `${oana.open} ${oana.landing}/${oana.data}`, '200 200/200');

// 5-7 : comptable
const la = await accountant.login('ACCOUNTANT'); add(5, 'Comptable', 'Connexion Core', la.status, 200);
const afin = await accountant.open('finance', '/api/overview'); add(6, 'Comptable', 'Ouvrir Finance et lire', `${afin.open} ${afin.landing}/${afin.data}`, '200 200/200');
const aana = await accountant.open('analytics', '/api/brief'); add(7, 'Comptable', 'Ouvrir Analyses et lire', `${aana.open} ${aana.landing}/${aana.data}`, '200 200/200');

// 8-11 : lecture seule
const lv = await viewer.login('VIEWER'); add(8, 'Lecture seule', 'Connexion Core', lv.status, 200);
const vstat = await viewer.core('GET', '/api/core/status'); add(9, 'Lecture seule', 'Lire le statut Core', vstat.status, 200);
const vfin = await viewer.core('POST', '/api/core/finance/open', '{}'); add(10, 'Lecture seule', 'Ouvrir Finance depuis Core', vfin.status, 403);
const vana = await viewer.core('POST', '/api/core/analytics/open', '{}'); add(11, 'Lecture seule', 'Ouvrir Analyses depuis Core', vana.status, 403);
const vwrite = await viewer.core('POST', '/api/core/campaigns', '{}'); add(12, 'Lecture seule', 'Écrire dans Core (campagne)', vwrite.status, 403);

// 13 : la décision de refus est retrouvable par son identifiant (propriétaire)
const rid = vfin.json?.requestId ?? null;
const trace = rid ? await owner.core('GET', `/api/core/refusals?requestId=${encodeURIComponent(rid)}`) : { status: 0, json: null };
add(13, 'Propriétaire', 'Retrouver le refus de lecture seule par requestId', trace.json?.entries?.[0]?.code ?? trace.status, ['FORBIDDEN', 'FORBIDDEN_ROLE']);

// 14-15 : compte suspendu
const ls = await suspended.login('SUSPENDED'); add(14, 'Suspendu', 'Connexion Core', ls.status, [401, 403]);
const sstat = await suspended.core('GET', '/api/core/status'); add(15, 'Suspendu', 'Lire le statut Core', sstat.status, [401, 403]);

// 16-18 : étranger (propriétaire d'un autre marchand)
const lout = await outsider.login('OUTSIDER'); add(16, 'Autre commerce', 'Connexion Core du marchand de test (non membre)', lout.status, [401, 403]);
const ostat = await outsider.core('GET', '/api/core/status'); add(17, 'Autre commerce', 'Lire le statut du marchand de test', ostat.status, [401, 403]);
const oopen = await outsider.core('POST', '/api/core/analytics/open', '{}'); add(18, 'Autre commerce', 'Ouvrir Analyses du marchand de test', oopen.status, [401, 403]);

// 19 : sans session, aucune donnée et un requestId
const anon = await fetch(`${CORE}/api/core/status`, { redirect: 'manual' });
add(19, 'Sans session', 'Lire le statut Core', anon.status, 401);

// 20-24 : révocation après suspension. Demande la clé de service dans NORDLA_RECETTE_SERVICE_KEY (jamais écrite dans un fichier).
// Sans cette variable, l'étape est sautée et le tableau ne contient que les 19 premiers contrôles.
const svc = process.env.NORDLA_RECETTE_SERVICE_KEY || '';
if (svc) {
  const SUPA = env.SUPABASE_URL || 'https://fvhiammdskpcnfodsnrc.supabase.co';
  const ACC = env.ACCOUNTANT_ID;
  const setAccountant = async (status) => {
    const body = status === 'SUSPENDED' ? { status, suspended_at: new Date().toISOString() } : { status, suspended_at: null };
    const res = await fetch(`${SUPA}/rest/v1/merchant_members?merchant_id=eq.67646dbb-5e2e-4cd7-aad6-0ab289b068cb&user_id=eq.${ACC}`, {
      method: 'PATCH', headers: { apikey: svc, authorization: `Bearer ${svc}`, 'content-type': 'application/json', prefer: 'return=representation' }, body: JSON.stringify(body),
    });
    return res.status;
  };
  try {
    await setAccountant('ACTIVE');
    const rev = session();
    const rl = await rev.login('ACCOUNTANT'); add(20, 'Comptable (révocation)', 'Connexion Core avant suspension', rl.status, 200);
    const rf = await rev.open('finance', '/api/overview'); add(21, 'Comptable (révocation)', 'Session Finance ouverte avant suspension', `${rf.open} ${rf.landing}/${rf.data}`, '200 200/200');
    const sus = await setAccountant('SUSPENDED');
    add(22, 'Comptable (révocation)', 'Suspension appliquée en base', sus, 200);
    const cs = await rev.core('GET', '/api/core/status'); add(23, 'Comptable (révocation)', 'Core refuse la session après suspension', cs.status, [401, 403]);
    const fd = await fetch(`${FIN}/api/overview`, { headers: { cookie: rf.cookie ?? '' } }); add(24, 'Comptable (révocation)', 'Finance refuse la session ouverte après suspension', fd.status, [401, 403]);
    const fo = await rev.open('finance', '/api/overview'); add(25, 'Comptable (révocation)', 'Nouvelle ouverture Finance refusée après suspension', fo.open, [401, 403]);
  } finally {
    await setAccountant('ACTIVE');
  }
} else {
  console.log('Révocation non exécutée : NORDLA_RECETTE_SERVICE_KEY absente (19 contrôles seulement).');
}

const result = evaluate(checks);
console.log(renderTable(result.rows));
console.log(`\n${result.passed}/${result.total} contrôles conformes`);
if (result.failures.length) { console.error('ÉCHECS :', result.failures.map((f) => `#${f.id} ${f.action}`).join(' ; ')); process.exit(1); }
