// Phase 1c - the single source of the Core permission rules (who may do what, route by route).
// Values are the ones the server already applied (see test/core-permission-characterization.test.js): moving them here changes no behaviour.
//   - writers: roles allowed to change anything under /api on a hosted server (any other role reads only).
//   - readOnlyPosts: POST routes that issue no change, so every role may call them (module and session checks still apply).
//   - moduleOpenRoles: roles allowed to open a module dashboard from Core (null = no role restriction beyond the module gate).
//   - financeInboxRoles: roles allowed to read the Finance supplier-invoice inbox from Core.

export const WRITER_ROLES = Object.freeze(['OWNER', 'ADMIN', 'COLLABORATOR']);

export const READ_ONLY_POSTS = Object.freeze([
  '/api/safety/check',
  '/api/core/ask',
  '/api/core/finance/open',
  '/api/core/analytics/open',
  '/api/core/growth/open',
]);

export const FINANCE_ROLES = Object.freeze(['OWNER', 'ADMIN', 'ACCOUNTANT']);

export const MODULE_OPEN_ROLES = Object.freeze({
  finance: FINANCE_ROLES,
  analytics: FINANCE_ROLES,
  growth: null,
  sourcing: null,
});

export const FINANCE_INBOX_ROLES = Object.freeze(['OWNER', 'ADMIN', 'ACCOUNTANT']);

// Route table: one line per Core route, so a new route cannot be added without deciding who may call it.
// access: 'member' (any role reads), 'writer' (OWNER/ADMIN/COLLABORATOR change), 'read-only-post' (POST issuing no change),
// 'module-open:<key>' (opens a module dashboard), 'inbox' (Finance inbox). Enforcement stays in the handlers; this table is the record.
export const ROUTE_RULES = Object.freeze([
  { method: 'GET', path: '/api/core/status', access: 'member' },
  { method: 'GET', path: '/api/core/modules', access: 'member' },
  { method: 'GET', path: '/api/core/decisions', access: 'member' },
  { method: 'GET', path: '/api/core/branding', access: 'member' },
  { method: 'POST', path: '/api/core/branding/check', access: 'writer' },
  { method: 'POST', path: '/api/core/branding/approve', access: 'writer' },
  { method: 'GET', path: '/api/core/campaigns', access: 'member' },
  { method: 'POST', path: '/api/core/campaigns', access: 'writer' },
  { method: 'GET', path: '/api/core/creation', access: 'member' },
  { method: 'POST', path: '/api/core/creation', access: 'writer' },
  { method: 'GET', path: '/api/core/finance/inbox', access: 'inbox' },
  { method: 'POST', path: '/api/core/finance/open', access: 'module-open:finance' },
  { method: 'POST', path: '/api/core/analytics/open', access: 'module-open:analytics' },
  { method: 'POST', path: '/api/core/growth/open', access: 'module-open:growth' },
  { method: 'POST', path: '/api/core/ask', access: 'read-only-post' },
  { method: 'POST', path: '/api/safety/check', access: 'read-only-post' },
  { method: 'POST', path: '/api/core/decisions', access: 'writer' },
  { method: 'POST', path: '/api/core/unknown-route', access: 'writer' },
]);
