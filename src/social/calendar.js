// The 14-day editorial calendar. Pure functions over posts: no I/O, no clock of its own.
//
//   Europe/Brussels is the owner's wall clock; every stored instant is UTC. The change of hour (2026-10-25, 03:00 -> 02:00) falls inside
//   the 14 days of the trip, so conversions go through Intl and are round-trip checked: a wall time that does not exist is refused,
//   one that exists twice takes the first (summer) occurrence.
//
//   buildCalendar   groups posts by Brussels day and sorts them into the five buckets the owner reads:
//                   programmable (approved) · awaiting approval · needs correction · missing assets · already published
//   proposeSchedule suggests dates for posts that have none, with no repeated subject back to back and one "piece" per slot.
//                   It only SUGGESTS: applying a date is an edit, which voids any approval - the owner approves the date too.

import { POST_STATE as S, TIMEZONE } from './constants.js';
import { hasValidApproval } from './workflow.js';
import { readinessProblems } from './post.js';

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const partsOf = (ms) => Object.fromEntries(fmt.formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));

/** Minutes east of UTC that Brussels is at this instant (60 in winter, 120 in summer). */
export function brusselsOffsetMinutes(utcMs) {
  const p = partsOf(utcMs);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

/** '2026-10-25' + '18:00' (Brussels wall clock) -> UTC ISO. Throws for a wall time that does not exist (spring-forward gap). */
export function brusselsToUtc(date, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m || !t) throw new RangeError('date must be YYYY-MM-DD and time HH:MM');
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], t[1], t[2]].map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const candidates = new Set([wall - 120 * 60_000, wall - 60 * 60_000]); // summer, then winter offset
  for (const guess of [...candidates].sort((a, b) => a - b)) { // earliest first: the summer reading of an ambiguous hour
    const p = partsOf(guess);
    if (p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi) return new Date(guess).toISOString();
  }
  throw new RangeError(`${date} ${time} does not exist in ${TIMEZONE}`);
}

export function brusselsParts(isoUtc) {
  const p = partsOf(Date.parse(isoUtc));
  const two = (n) => String(n).padStart(2, '0');
  return { date: `${p.year}-${two(p.month)}-${two(p.day)}`, time: `${two(p.hour)}:${two(p.minute)}` };
}
const WEEKDAY_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
export const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const BUCKET = Object.freeze({
  PROGRAMMABLE: 'programmable', AWAITING_APPROVAL: 'awaiting_approval', NEEDS_CORRECTION: 'needs_correction', MISSING_ASSET: 'missing_asset', PUBLISHED: 'published', CANCELLED: 'cancelled',
});

/** Which of the owner's five questions does this post answer? */
export function bucketOf(post, { confirmed = [] } = {}) {
  const problems = readinessProblems(post, { confirmed });
  switch (post.state) {
    case S.PUBLISHED: case S.VERIFIED: case S.PUBLISHING: return BUCKET.PUBLISHED;
    case S.CANCELLED: return BUCKET.CANCELLED;
    case S.APPROVED: case S.SCHEDULED: return hasValidApproval(post) && !problems.length ? BUCKET.PROGRAMMABLE : BUCKET.NEEDS_CORRECTION;
    case S.READY_FOR_REVIEW: return BUCKET.AWAITING_APPROVAL;
    case S.NEEDS_CHANGES: case S.REJECTED: case S.ERROR: case S.PUBLICATION_UNKNOWN: return BUCKET.NEEDS_CORRECTION;
    default: return problems.includes('ASSET_MISSING') ? BUCKET.MISSING_ASSET : BUCKET.NEEDS_CORRECTION; // DRAFT
  }
}

export function buildCalendar({
  posts, from, days = 14, confirmed = [],
}) {
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const grid = new Map(dates.map((d) => [d, []]));
  const buckets = Object.fromEntries(Object.values(BUCKET).map((b) => [b, []]));
  const unplaced = [];
  for (const post of posts) {
    const bucket = bucketOf(post, { confirmed });
    buckets[bucket].push(post.id);
    if (!post.publish_at) { unplaced.push(post.id); continue; }
    const { date, time } = brusselsParts(post.publish_at);
    if (grid.has(date)) grid.get(date).push({ post_id: post.id, time, platform: post.platform, format: post.format, state: post.state, bucket, subject: post.subject.label || post.subject.ref });
  }
  return {
    timezone: TIMEZONE,
    from,
    to: dates.at(-1),
    days: dates.map((date) => ({ date, weekday: WEEKDAY_FR[weekdayOf(date)], entries: grid.get(date).sort((a, b) => a.time.localeCompare(b.time)) })),
    buckets,
    unplaced,
  };
}

/** The slot dates of a cadence inside the window, as Brussels wall times converted to UTC. Past or too-near slots are dropped. */
export function slotsOf({
  from, days = 14, weekdays = [1, 3, 5, 0], time = '18:00', nowMs, minLeadMs = 2 * 3600_000,
}) {
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(from, i);
    if (!weekdays.includes(weekdayOf(date))) continue;
    const at = brusselsToUtc(date, time);
    if (Date.parse(at) >= nowMs + minLeadMs) out.push({ date, publish_at: at });
  }
  return out;
}

/**
 * Suggest a date for every post that has none. One "piece" (a proposal, possibly offered to Instagram AND Facebook) takes one slot, so a
 * visual is not shown twice in the same week on the same channel; consecutive slots never repeat a subject when an alternative exists.
 * Returns { assignments: [{ post_id, publish_at }], leftover: [post_id] }  (more pieces than slots). Never touches a post.
 */
export function proposeSchedule({
  posts, from, days = 14, nowMs, cadence = {},
}) {
  const slots = slotsOf({ from, days, nowMs, ...cadence });
  const taken = new Set(posts.filter((p) => p.publish_at && ![S.CANCELLED].includes(p.state)).map((p) => brusselsParts(p.publish_at).date));
  const free = slots.filter((s) => !taken.has(s.date));
  const pieces = new Map();
  for (const p of posts.filter((x) => !x.publish_at && ![S.CANCELLED, S.PUBLISHED, S.VERIFIED].includes(x.state))) {
    const key = p.origin?.proposal_id ?? p.id;
    if (!pieces.has(key)) pieces.set(key, []);
    pieces.get(key).push(p);
  }
  const queue = [...pieces.values()];
  const assignments = [];
  let previousSubject = null;
  for (const slot of free) {
    if (!queue.length) break;
    let idx = queue.findIndex((piece) => piece[0].subject.ref !== previousSubject);
    if (idx < 0) idx = 0;
    const [piece] = queue.splice(idx, 1);
    for (const p of piece) assignments.push({ post_id: p.id, publish_at: slot.publish_at });
    previousSubject = piece[0].subject.ref;
  }
  return { assignments, leftover: queue.flat().map((p) => p.id) };
}
