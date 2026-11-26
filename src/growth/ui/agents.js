'use strict';
// Nordla Growth - « Agents IA » and « Administration ». Loaded BEFORE app.js (same pattern as the other pages): nothing runs at load time.
// Data: /api/growth/agents (registry + configuration state) and /api/growth/admin (read-only source states). A draft comes ONLY from
// POST /api/growth/agents/run, and is shown as text (never as HTML) with its period, sources, limits and the confirmations a person must give.
// No answer is ever simulated: without a configured provider the run button is disabled and the missing variable NAMES are shown.

const AG_SOURCES = ['priorities', 'products', 'audience', 'content', 'store', 'dropoff', 'ads', 'social'];
const AG_CONFIRMATIONS = ['plan_review', 'shopify_change', 'price_change', 'message_send', 'campaign_publish', 'social_publish', 'store_offer_publish', 'theme_change', 'ads_spend', 'campaign_change', 'experiment_start'];
const agResults = {}; // agent id -> the last draft or error for this page session (in memory only)
const agBusy = {};

async function agentRunRequest(agentId, question) {
  const body = JSON.stringify({ agentId, question });
  // HOSTED: the session's api() adds the CSRF header and the /growth prefix; the local preview calls the route directly.
  if (typeof growthHosted !== 'undefined' && growthHosted && typeof growthHosted.api === 'function') return growthHosted.api('/api/growth/agents/run', { method: 'POST', body });
  const r = await fetch('/api/growth/agents/run', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body });
  let json = null; try { json = await r.json(); } catch { json = null; }
  return { ok: r.ok, status: r.status, body: json };
}

async function runAgent(agentId, question) {
  agBusy[agentId] = true; agResults[agentId] = null; render();
  let res;
  try { res = await agentRunRequest(agentId, question); } catch { res = { ok: false, status: 0, body: null }; }
  agBusy[agentId] = false;
  const code = res && res.body && res.body.error ? res.body.error.code : null;
  agResults[agentId] = res && res.ok && res.body ? { result: res.body } : { error: code && AG_ERROR_CODES.includes(code) ? code : 'NETWORK' };
  render();
}
const AG_ERROR_CODES = ['AI_NOT_CONFIGURED', 'AI_QUOTA_EXCEEDED', 'AI_TIMEOUT', 'AI_PROVIDER_ERROR', 'AI_BAD_OUTPUT', 'BAD_REQUEST', 'BAD_AGENT', 'FORBIDDEN_ROLE', 'INTERNAL_ERROR'];

const agSourceLabel = (key) => t(`gr.ag.src.${key}`);
const agStatusLabel = (s) => t(`gr.ag.status.${s}`);

function agResultBlock(id) {
  const r = agResults[id];
  if (agBusy[id]) return h('p', { class: 'gr-state-text', role: 'status' }, t('gr.ag.running'));
  if (!r) return null;
  if (r.error) return h('div', { class: 'ex-card gr-state gr-state-error', role: 'alert' }, h('p', { class: 'gr-state-text' }, t(`gr.ag.err.${r.error}`)));
  const d = r.result;
  return h('div', { class: 'gr-ag-result', 'aria-live': 'polite' },
    h('p', { class: 'gr-ag-banner' }, t('gr.ag.draftBanner')),
    h('h4', { class: 'gr-ag-h' }, t('gr.ag.draft')),
    h('pre', { class: 'gr-ag-draft' }, d.draft), // text only
    h('h4', { class: 'gr-ag-h' }, t('gr.ag.reason')),
    h('p', null, d.reason),
    h('h4', { class: 'gr-ag-h' }, t('gr.ag.periodLabel')),
    h('p', null, t(`gr.ag.period.${d.period}`)),
    h('h4', { class: 'gr-ag-h' }, t('gr.ag.sourcesLabel')),
    h('ul', { class: 'gr-ag-list' }, ...d.sources.map((s) => h('li', null, `${agSourceLabel(s.key)} — ${agStatusLabel(s.status)}`))),
    h('h4', { class: 'gr-ag-h' }, t('gr.ag.limitsLabel')),
    h('ul', { class: 'gr-ag-list' }, ...(d.limits.length ? d.limits : [t('gr.ag.noLimits')]).map((l) => h('li', null, l))),
    h('p', { class: 'gr-ag-confirm' }, t('gr.ag.confirmFirst', d.confirmations.map((c) => t(`gr.ag.conf.${c}`)).join(' · '))));
}

function agentCard(a, cfg) {
  const ta = h('textarea', { class: 'gr-ag-q', maxlength: '500', rows: '2', 'aria-label': t('gr.ag.questionLabel'), placeholder: t('gr.ag.questionPh') });
  const configured = cfg.configured === true;
  const missing = (cfg.configuration && cfg.configuration.missing) || [];
  const note = configured ? null : h('p', { class: 'gr-ag-note' }, t('gr.ag.notConfigured'), missing.length ? h('span', null, ` ${t('gr.ag.missingVars')} `, h('code', null, missing.join(', '))) : null,
    cfg.configuration && cfg.configuration.unknownProvider ? h('span', null, ` ${t('gr.ag.unknownProvider')}`) : null);
  const btn = h('button', { type: 'button', class: 'btn-outline gr-ag-run', ...(configured && !agBusy[a.id] ? {} : { disabled: 'disabled' }), on: { click: () => runAgent(a.id, ta.value.trim()) } }, t('gr.ag.run'));
  const ad = cfg.agents ? cfg.agents.find((x) => x.id === a.id) : null;
  const srcs = ad ? ad.sources : [];
  return h('article', { class: 'ex-card gr-ag-card', 'data-agent': a.id },
    h('h3', { class: 'gr-card-title' }, t(`gr.ag.${a.id}.name`)),
    h('p', { class: 'gr-ag-purpose' }, t(`gr.ag.${a.id}.purpose`)),
    h('p', { class: 'gr-ag-meta' }, h('strong', null, t('gr.ag.periodLabel') + ' '), t(`gr.ag.period.${a.period}`)),
    h('div', { class: 'gr-ag-meta' }, h('strong', null, t('gr.ag.sourcesLabel') + ' '), ...srcs.map((s) => chip(`${agSourceLabel(s.key)}${s.available ? '' : ` · ${agStatusLabel('unavailable')}`}`, s.available ? '' : 'warn'))),
    h('div', { class: 'gr-ag-meta' }, h('strong', null, t('gr.ag.confirmLabel') + ' '), ...a.confirmations.map((c) => chip(t(`gr.ag.conf.${c}`)))),
    note, ta, h('div', { class: 'gr-ag-actions' }, btn),
    agResultBlock(a.id));
}

function renderAgents(main, safe) {
  const d = agData || { agents: [] };
  const intro = h('div', { class: 'ex-card gr-ag-intro' }, h('p', null, t('gr.ag.intro')));
  main.appendChild(safe(() => intro));
  main.appendChild(safe(() => h('div', { class: 'gr-ag-grid' }, ...(d.agents || []).map((a) => agentCard(a, d)))));
}

function renderAdmin(main, safe) {
  const d = admData || { sources: [], agents: {}, configuration: {}, goals: {} };
  const srcRows = (d.sources || []).map((s) => h('tr', null, h('td', { 'data-label': t('gr.adm.source') }, agSourceLabel(s.key)), h('td', { 'data-label': t('gr.adm.state') }, chip(agStatusLabel(s.status), s.status === 'available' ? '' : 'warn'))));
  const cfgMissing = (d.configuration && d.configuration.missing) || [];
  main.appendChild(safe(() => h('div', { class: 'ex-card' }, cardHead('', t('gr.adm.sources')),
    h('p', { class: 'gr-muted' }, t('gr.adm.sourcesNote')),
    h('div', { class: 'gr-ag-table-wrap' }, h('table', { class: 'gr-table gr-ag-table' }, h('thead', null, h('tr', null, h('th', null, t('gr.adm.source')), h('th', null, t('gr.adm.state')))), h('tbody', null, ...srcRows))))));
  main.appendChild(safe(() => h('div', { class: 'ex-card' }, cardHead('', t('gr.adm.agents')),
    h('p', null, `${t('gr.adm.provider')}: `, h('strong', null, d.agents && d.agents.provider ? d.agents.provider : t('gr.adm.noneConfigured'))),
    d.agents && d.agents.model ? h('p', null, `${t('gr.adm.model')}: `, h('code', null, d.agents.model)) : null,
    d.agents && d.agents.dailyLimit ? h('p', null, `${t('gr.adm.quota')}: ${d.agents.dailyLimit}`) : null,
    cfgMissing.length ? h('p', { class: 'gr-ag-note' }, t('gr.adm.missing'), ' ', h('code', null, cfgMissing.join(', '))) : null,
    h('p', { class: 'gr-muted' }, t('gr.adm.secretNote')))));
  main.appendChild(safe(() => h('div', { class: 'ex-card' }, cardHead('', t('gr.adm.goals')),
    h('p', null, t('gr.adm.goalsNotStored')))));
  main.appendChild(safe(() => h('div', { class: 'ex-card' }, cardHead('', t('gr.adm.prefs')),
    h('ul', { class: 'gr-ag-list' }, h('li', null, t('gr.adm.langs')), h('li', null, t('gr.adm.periods'))))));
  main.appendChild(safe(() => h('div', { class: 'ex-card' }, cardHead('', t('gr.adm.connectors')),
    h('ul', { class: 'gr-ag-list' }, ...['ga4', 'metaAds', 'instagram', 'messaging'].map((k) => h('li', null, t(`gr.adm.conn.${k}`)))))));
}

function renderExperiments(main, safe) {
  const d = xpData || { state: null, needs: [] };
  main.appendChild(safe(() => h('div', { class: 'ex-card gr-xp-card' },
    cardHead('', t('gr.xp.stateTitle')),
    h('p', { class: 'gr-state-text' }, t(`gr.xp.state.${d.state || 'UNKNOWN'}`)),
    h('p', null, t('gr.xp.needsLabel')),
    h('ul', { class: 'gr-ag-list' }, ...['gr.xp.need1', 'gr.xp.need2', 'gr.xp.need3'].map((k) => h('li', null, t(k)))),
    h('p', null, h('a', { class: 'btn-outline', href: '#/agents' }, t('gr.xp.agentLink'))))));
}

// Pipeline, Inbox, social calendar and advertising: the state of their source, explained. No figure is shown here.
function renderSource(key, main, safe) {
  const d = srcData[key] || null;
  const status = d ? d.status : 'unavailable';
  main.appendChild(safe(() => h('div', { class: 'ex-card gr-xp-card' },
    cardHead('', t(`gr.src.${key}.title`)),
    h('p', null, t(`gr.src.${key}.what`)),
    h('p', { class: 'gr-state-text' }, t(`gr.src.status.${status}`)),
    h('p', null, t(`gr.src.${key}.need`)),
    status === 'available' ? h('p', null, t(`gr.src.${key}.available`)) : null,
    h('p', null, h('a', { class: 'btn-outline', href: '#/agents' }, t('gr.xp.agentLink'))))));
}

let agData = null;
let admData = null;
let xpData = null;
const srcData = {};
