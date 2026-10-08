// SocleCreateAuthorization: the representation of a decision ALREADY taken elsewhere (the future Socle) that allows the
// preparation of creative work for ONE Push of ONE Decision Package.
//
// M3 builds NO mini-Socle: there is no function here that creates, issues, grants or approves an authorization, and none can
// be derived from a Push, a package or a Brand Context. This module only validates a FORM and its coherence with the original
// Package and Push. It authenticates nobody and decides nothing; the object must come from a trusted server-side Socle adapter.

import { MKT_ERROR as E } from './understand-constants.js';
import {
  CREATE_AUTHORIZATION_SCOPE, CREATE_AUTHORIZATION_STATUS, M3_ERROR as Z,
} from './m3-constants.js';
import { safeRef } from './m3-validation.js';
import {
  closedObject, deepFreeze, enumValue, fail, isPlainObject, isoTimestamp, toMs,
} from './understand-validation.js';

const KEYS = ['authorization_ref', 'decision_ref', 'package_ref', 'push_ref', 'scope', 'status', 'authorized_at', 'expires_at'];

/**
 * @param {object} input the authorization, as supplied by a trusted Socle adapter
 * @param {object} p { decisionPackage, push } - the ORIGINAL (already re-validated) package and Push it must match
 *
 * Rules: scope is exactly CREATE and status exactly APPROVED (nothing else in V1); package_ref == package.package_id;
 * push_ref == push.push_id; authorized_at <= expires_at <= push.expires_at and <= package.expires_at.
 * Staleness (asOf >= expires_at) is a LIVE property, evaluated by the create gate, never stored here.
 */
export function normalizeSocleCreateAuthorization(input, { decisionPackage, push } = {}) {
  if (!isPlainObject(decisionPackage) || !isPlainObject(push)) {
    fail(E.INVALID_FIELD, 'an authorization is validated against its original package and Push', { field: 'authorization' });
  }
  closedObject(input, KEYS, 'authorization');

  const scope = enumValue(input.scope, { CREATE: CREATE_AUTHORIZATION_SCOPE }, 'authorization.scope', Z.AUTH_INVALID_SCOPE);
  const status = enumValue(input.status, { APPROVED: CREATE_AUTHORIZATION_STATUS }, 'authorization.status', Z.AUTH_INVALID_STATUS);

  const packageRef = safeRef(input.package_ref, 'authorization.package_ref');
  if (packageRef !== decisionPackage.package_id) fail(Z.AUTH_PACKAGE_MISMATCH, 'authorization.package_ref is not the Decision Package it is used with');
  const pushRef = safeRef(input.push_ref, 'authorization.push_ref');
  if (pushRef !== push.push_id) fail(Z.AUTH_PUSH_MISMATCH, 'authorization.push_ref is not the Push it is used with');

  const authorizedAt = isoTimestamp(input.authorized_at, 'authorization.authorized_at');
  const expiresAt = isoTimestamp(input.expires_at, 'authorization.expires_at');
  if (toMs(authorizedAt) > toMs(expiresAt)) fail(Z.AUTH_INVALID_WINDOW, 'authorization.authorized_at cannot be after expires_at');
  if (toMs(expiresAt) > toMs(push.expires_at)) fail(Z.AUTH_OUTLIVES_PUSH, 'an authorization cannot outlive its Push');
  if (toMs(expiresAt) > toMs(decisionPackage.expires_at)) fail(Z.AUTH_OUTLIVES_PACKAGE, 'an authorization cannot outlive its Decision Package');

  return deepFreeze({
    authorization_ref: safeRef(input.authorization_ref, 'authorization.authorization_ref'),
    decision_ref: safeRef(input.decision_ref, 'authorization.decision_ref'),
    package_ref: packageRef,
    push_ref: pushRef,
    scope,
    status,
    authorized_at: authorizedAt,
    expires_at: expiresAt,
  });
}
