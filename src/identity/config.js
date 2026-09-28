// Nordla identity - session timing configuration (ADR 0004, D5). Holds NO secret: durations only.
//
//   NORDLA_SESSION_ABSOLUTE_HOURS   absolute lifetime of a session           default 12   (1..12: 12 hours is the accepted maximum)
//   NORDLA_SESSION_IDLE_MINUTES     expiry after inactivity                   default 120  (5..120, and never longer than the lifetime)
//   NORDLA_SESSION_TOUCH_MINUTES    minimum gap between two last_seen_at writes default 5 (1..10, and shorter than the inactivity window)
//
// Unset or blank = default. Anything else must be a plain whole number inside its bounds, otherwise loadIdentityConfig() throws and the
// service that calls it at start-up must refuse to start. Errors name the variable and its bounds, never repeat the value given.

export const IDENTITY_ENV = Object.freeze({
  absoluteHours: 'NORDLA_SESSION_ABSOLUTE_HOURS',
  idleMinutes: 'NORDLA_SESSION_IDLE_MINUTES',
  touchMinutes: 'NORDLA_SESSION_TOUCH_MINUTES',
});

export const IDENTITY_DEFAULTS = Object.freeze({ absoluteHours: 12, idleMinutes: 120, touchMinutes: 5 });
export const IDENTITY_BOUNDS = Object.freeze({
  absoluteHours: Object.freeze({ min: 1, max: 12 }),
  idleMinutes: Object.freeze({ min: 5, max: 120 }),
  touchMinutes: Object.freeze({ min: 1, max: 10 }),
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export class IdentityConfigError extends Error {
  constructor(variable, message) { super(message); this.name = 'IdentityConfigError'; this.code = 'IDENTITY_CONFIG_INVALID'; this.variable = variable; }
}

function readWhole(env, key) {
  const variable = IDENTITY_ENV[key];
  const { min, max } = IDENTITY_BOUNDS[key];
  const raw = env[variable];
  if (raw === undefined || raw === null || String(raw).trim() === '') return IDENTITY_DEFAULTS[key];
  const text = String(raw).trim();
  const value = /^\d{1,4}$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new IdentityConfigError(variable, `${variable} must be a whole number between ${min} and ${max} (default ${IDENTITY_DEFAULTS[key]}).`);
  }
  return value;
}

/**
 * The session timing of this service, validated. Call it once at start-up; an invalid value throws IdentityConfigError.
 * @param {Record<string, string|undefined>} [env]
 * @returns {Readonly<{ absoluteHours: number, idleMinutes: number, touchMinutes: number, absoluteMs: number, idleMs: number, touchMs: number }>}
 */
export function loadIdentityConfig(env = process.env) {
  const absoluteHours = readWhole(env, 'absoluteHours');
  const idleMinutes = readWhole(env, 'idleMinutes');
  const touchMinutes = readWhole(env, 'touchMinutes');
  if (idleMinutes > absoluteHours * 60) {
    throw new IdentityConfigError(IDENTITY_ENV.idleMinutes, `${IDENTITY_ENV.idleMinutes} cannot be longer than the session lifetime (${IDENTITY_ENV.absoluteHours}).`);
  }
  if (touchMinutes >= idleMinutes) {
    throw new IdentityConfigError(IDENTITY_ENV.touchMinutes, `${IDENTITY_ENV.touchMinutes} must be shorter than ${IDENTITY_ENV.idleMinutes}.`);
  }
  return Object.freeze({
    absoluteHours, idleMinutes, touchMinutes,
    absoluteMs: absoluteHours * HOUR, idleMs: idleMinutes * MINUTE, touchMs: touchMinutes * MINUTE,
  });
}
