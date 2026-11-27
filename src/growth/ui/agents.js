'use strict';
// Nordla Growth - « Agents IA » and « Administration ». Loaded BEFORE app.js (same pattern as the other pages): nothing runs at load time.
// Data: /api/growth/agents (registry + configuration state) and /api/growth/admin (read-only source states). A draft comes ONLY from
// POST /api/growth/agents/run, and is shown as text (never as HTML) with its period, sources, limits and the confirmations a person must give.
// No answer is ever simulated: without a configured provider the run button is disabled and the missing variable NAMES are shown.

const AG_SOURCES = ['priorities', 'products', 'audience', 'content', 'store', 'dropoff', 'ads', 'social'];
const AG_CONFIRMATIONS = ['plan_review', 'shopify_change', 'price_change', 'message_send', 'campaign_publish', 'social_publish', 'store_offer_publish', 'theme_change', 'ads_spend', 'campaign_change', 'experiment_start'];
const agResults = {}; // agent id -> the last draft or error for this page session (in memory only)
const agBusy = {};

async function agentRunRequest(agentId, question, priorityId) {
  const body = JSON.stringify({ agentId, question, ...(priorityId ? { priorityId } : {}) }); // A5: a priority of this merchant, checked by the server
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
  if (res && res.ok && res.body && agentId === 'strategist') saveStrategistDraft(res.body); // A3: kept as a draft to validate
  render();
}
const AG_ERROR_CODES = ['QUESTION_PERSONAL_DATA', 'AI_OUTPUT_BLOCKED', 'PRIORITY_NOT_FOUND', 'AI_NOT_CONFIGURED', 'AI_QUOTA_EXCEEDED', 'AI_TIMEOUT', 'AI_PROVIDER_ERROR', 'AI_BAD_OUTPUT', 'BAD_REQUEST', 'BAD_AGENT', 'FORBIDDEN_ROLE', 'INTERNAL_ERROR'];

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
    note, ta, h('p', { class: 'gr-ag-note' }, t('gr.ag.questionPrivacy')), h('div', { class: 'gr-ag-actions' }, btn),
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
// « Suivi commercial » also lists the conversations that carry a follow-up: each link opens THAT conversation in Opportunités.
function renderSource(key, main, safe) {
  const d = srcData[key] || null;
  const status = d ? d.status : 'unavailable';
  main.appendChild(safe(() => h('div', { class: 'ex-card gr-xp-card' },
    cardHead('', t(`gr.src.${key}.title`)),
    h('p', null, t(`gr.src.${key}.what`)),
    h('p', { class: 'gr-state-text' }, t(`gr.src.status.${status}`)),
    h('p', null, t(`gr.src.${key}.need`)),
    status === 'available' || status === 'server' ? h('p', null, t(`gr.src.${key}.available`)) : null)));
  if (key === 'pipeline') main.appendChild(safe(() => conversationLinksCard(d)));
}

/** A2: one line per conversation that has a follow-up; the link carries the opportunity's stable id (the page opens that row). */
function conversationLinksCard(d) {
  const items = d && Array.isArray(d.items) ? d.items : [];
  const head = cardHead('', t('gr.src.pipeline.linksTitle'));
  if (!items.length) return h('div', { class: 'ex-card gr-xp-card' }, head, h('p', { class: 'gr-muted' }, t('gr.src.pipeline.noItems')));
  return h('div', { class: 'ex-card gr-xp-card' }, head,
    h('p', { class: 'gr-muted' }, t('gr.src.pipeline.linksNote')),
    h('ul', { class: 'gr-ag-list' }, ...items.map((i) => h('li', null,
      h('a', { href: `#/opportunities?open=${encodeURIComponent(i.id)}` },
        `${typeof opSocialNetwork === 'function' ? opSocialNetwork(i.network) : (i.network || '–')} · ${(typeof INQ_KEYWORD !== 'undefined' && INQ_KEYWORD[i.requestType]) || i.requestType || '–'} — ${t('gr.src.pipeline.openLink')}`)))));
}

// ---- A3: the Stratège drafts already produced on this page, kept per merchant (follow-up store key agent.v1, no opportunity id) ----
const AG_DRAFTS_MAX = 10;
const agDraftKey = (scope) => `nordla.growth.agent.v1:${scope}`;
function readStrategistDrafts(scope) {
  try { const v = JSON.parse(growthStorage.getItem(agDraftKey(scope)) ?? 'null'); return v && v.v === 1 && Array.isArray(v.drafts) ? v.drafts : []; } catch { return []; }
}
/** A new draft gets its own id and starts as pending (to validate). Called only after the server returned a checked draft. */
function newDraftId() { return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; }
function saveStrategistDraft(res) {
  const scope = (agData && agData.historyScope) || (oppData && oppData.historyScope); // the Opportunités payload carries the scope too
  if (!scope) return; // the local preview has no merchant scope: nothing is kept there
  const entry = { id: newDraftId(), at: new Date().toISOString(), period: res.period, draft: res.draft, reason: res.reason, limits: res.limits, sources: res.sources, confirmations: res.confirmations, state: 'pending', ...(res.priorityRef ? { priorityRef: { id: res.priorityRef.id } } : {}) };
  const drafts = [entry, ...readStrategistDrafts(scope)].slice(0, AG_DRAFTS_MAX);
  try { growthStorage.setItem(agDraftKey(scope), JSON.stringify({ v: 1, drafts })); } catch { /* storage refused: the draft is still shown on the agents page */ }
}
/** The provider state, read from the server (never assumed). Resolves to { configured, missing } or null. */
async function agentStatusRequest() {
  try {
    if (typeof growthHosted !== 'undefined' && growthHosted && typeof growthHosted.api === 'function') {
      const r = await growthHosted.api('/api/growth/agents'); return r && r.ok && r.body ? { configured: r.body.configured === true, missing: (r.body.configuration && r.body.configuration.missing) || [] } : null;
    }
    const r = await fetch('/api/growth/agents', { headers: { accept: 'application/json' } }); const b = await r.json();
    return { configured: b.configured === true, missing: (b.configuration && b.configuration.missing) || [] };
  } catch { return null; }
}
/** The « Brouillons de l'agent Stratège » block of Opportunités: stored drafts with their state; the provider state is said, not assumed. */
/** The merchant scope comes from the Opportunités payload (always there) or from the agents payload when this page has loaded it. */
// A4: each draft shows its decision (pending / validated / rejected). A decision records the status only: nothing the agent suggested is started.
const AG_REVIEW_ERR = ['FORBIDDEN_ROLE', 'ALREADY_REVIEWED', 'VERSION_CONFLICT', 'DRAFT_NOT_FOUND', 'DRAFT_ID_INVALID', 'STATUS_INVALID'];
/** The same rule as the server (follow-up-store.js draftId): a draft written before A4 has no id, its id comes from its date. */
const agDraftIdOf = (d) => (d && typeof d.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(d.id) ? d.id : `a${String((d && d.at) || '').replace(/\D/g, '')}`);
const agDraftStateOf = (d) => (d && (d.state === 'validated' || d.state === 'rejected') ? d.state : 'pending');
const agFmtDate = (iso) => (iso ? new Date(iso).toLocaleString(NORDLA_I18N.getLang()) : '');

function agentDraftsCard(d) {
  const scope = (d && d.historyScope) || (agData && agData.historyScope) || null;
  const hosted = typeof growthHosted !== 'undefined' && Boolean(growthHosted) && typeof growthHosted.api === 'function';
  const key = scope ? agDraftKey(scope) : null;
  const drafts = scope ? readStrategistDrafts(scope) : [];
  const stateLine = h('p', { class: 'gr-muted', role: 'status' }, t('gr.ag.draftsChecking'));
  agentStatusRequest().then((s) => {
    stateLine.replaceChildren(s === null ? t('gr.ag.draftsStatusUnknown')
      : s.configured ? t('gr.ag.draftsProviderOn')
        : s.missing.length ? t('gr.ag.draftsProviderOff', s.missing.join(', ')) : t('gr.ag.draftsProviderOffPlain'));
  });
  const list = drafts.length
    ? drafts.map((dr) => agentDraftArticle(dr, { key, hosted, page: d }))
    : [h('p', { class: 'gr-muted' }, t('gr.ag.draftsNone'), ' ', h('a', { href: '#/agents' }, t('gr.ag.draftsGoAgents')))];
  return h('div', { class: 'ex-card gr-xp-card', 'data-agent-drafts': '1' }, cardHead('', t('gr.ag.draftsTitle')), stateLine, ...list);
}

function agentDraftArticle(dr, { key, hosted, page }) {
  const id = agDraftIdOf(dr);
  const st = agDraftStateOf(dr);
  const stateText = st === 'pending' ? t('gr.ag.draftsState.pending')
    : st === 'validated' ? t('gr.ag.draftsState.validated', agFmtDate(dr.reviewedAt))
      : t('gr.ag.draftsState.rejected', agFmtDate(dr.reviewedAt));
  const feedback = h('p', { class: 'gr-ag-note', role: 'alert' });
  const actions = st !== 'pending' ? null
    : hosted
      ? h('div', { class: 'gr-ag-actions' },
        h('button', { type: 'button', class: 'btn-outline', on: { click: () => agentReviewDraft(key, id, 'validated', feedback) } }, t('gr.ag.review.validate')),
        h('button', { type: 'button', class: 'btn-outline', on: { click: () => agentReviewDraft(key, id, 'rejected', feedback) } }, t('gr.ag.review.reject')))
      : h('p', { class: 'gr-muted' }, t('gr.ag.review.hostedOnly'));
  return h('article', { class: 'gr-ag-result', 'data-draft-id': id, 'data-draft-state': st },
    h('p', { class: 'gr-ag-banner' }, stateText),
    h('p', { class: 'gr-muted' }, `${t('gr.ag.draftsAt')} ${agFmtDate(dr.at)} · ${t(`gr.ag.period.${dr.period}`)}`),
    dr.priorityRef ? agentDraftPriorityLine(dr.priorityRef, page) : null,
    dr.reviewedBy ? h('p', { class: 'gr-muted' }, t('gr.ag.review.byTeam')) : null,
    h('pre', { class: 'gr-ag-draft' }, dr.draft),
    h('p', null, dr.reason),
    h('ul', { class: 'gr-ag-list' }, ...(dr.limits || []).map((l) => h('li', null, l))),
    h('p', { class: 'gr-ag-confirm' }, t('gr.ag.confirmFirst', (dr.confirmations || []).map((c) => t(`gr.ag.conf.${c}`)).join(' · '))),
    st === 'pending' ? h('p', { class: 'gr-muted' }, t('gr.ag.review.note')) : null,
    actions, feedback);
}

/** Records the human decision on the server, then shows the stored status. The browser copy is updated with the server's version. */
async function agentReviewDraft(key, id, status, feedback) {
  feedback.replaceChildren();
  let r = null;
  try { r = await growthHosted.api('/api/growth/agents/review', { method: 'POST', body: JSON.stringify({ id, status }) }); } catch { r = null; }
  if (!r || !r.ok) {
    const code = r && r.body && r.body.error ? r.body.error.code : null;
    feedback.replaceChildren(t(`gr.ag.review.err.${AG_REVIEW_ERR.includes(code) ? code : 'NETWORK'}`));
    return;
  }
  if (r.body && r.body.value && key && typeof growthPersist !== 'undefined' && growthPersist.server) {
    growthPersist.server.entries.set(key, { raw: JSON.stringify(r.body.value), version: r.body.version });
  }
  render();
}


let agData = null;
let admData = null;
let xpData = null;
const srcData = {};

// ---- A5: a draft started from ONE priority of Opportunités. The server sets the reference; the page only shows it. ----
/** The priorities the page shows, by id (the same rule as the server: sections, then the conversation, ads, site and social blocks). */
function agPriorityIndex(d) {
  const out = new Map();
  const add = (l) => { if (Array.isArray(l)) for (const i of l) if (i && typeof i.id === 'string' && !out.has(i.id)) out.set(i.id, i); };
  if (d && d.sections) { add(d.sections.fix); add(d.sections.commercial); add(d.sections.watch); }
  for (const k of ['inbox', 'ads', 'site', 'social']) add(d && d[k] ? d[k].items : null);
  return out;
}
function agPriorityLabel(item) {
  try { if (['product', 'storeWeekday', 'segment'].includes(item.kind) && typeof opCommercialTitle === 'function') return opCommercialTitle(item); } catch { /* fall back below */ }
  return t('gr.ag.priorityGeneric');
}
function agentDraftPriorityLine(ref, page) {
  const item = agPriorityIndex(page).get(ref.id);
  if (!item) return h('p', { class: 'gr-muted' }, t('gr.ag.priorityGone'));
  return h('p', null, t('gr.ag.priorityLinked'), ' ', h('a', { href: `#/opportunities?open=${encodeURIComponent(ref.id)}` }, agPriorityLabel(item)));
}
const agErrText = (code) => t(`gr.ag.err.${AG_ERROR_CODES.includes(code) ? code : 'NETWORK'}`);

/** The button on a priority row of Opportunités. It only asks the server for a draft: no draft and no link are made here. */
function opAgentDraftAction(priorityId) {
  const feedback = h('p', { class: 'gr-ag-note', role: 'status' });
  const btn = h('button', { type: 'button', class: 'btn-outline gr-ag-frompriority', on: { click: () => agentDraftFromPriority(priorityId, btn, feedback) } }, t('gr.ag.fromPriority'));
  return h('div', { class: 'gr-ag-frompriority-box' }, btn, feedback);
}
async function agentDraftFromPriority(priorityId, btn, feedback) {
  feedback.replaceChildren();
  btn.setAttribute('disabled', 'disabled');
  let r = null;
  try { r = await agentRunRequest('strategist', '', priorityId); } catch { r = null; }
  btn.removeAttribute('disabled');
  if (!r || !r.ok || !r.body) { feedback.replaceChildren(agErrText(r && r.body && r.body.error ? r.body.error.code : null)); return; }
  saveStrategistDraft(r.body); // the reference is the server's (r.body.priorityRef); a failed run saves nothing
  render();
}
