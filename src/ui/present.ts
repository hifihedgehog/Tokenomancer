// Copy and number rules every surface shares: labels, digits and the ±, value
// text, states, captions, pace and verdict sentences, headlines, reason lines
// and spoken text. Pure functions only: no vscode, no Node, because the webview
// bundle imports this file too. Strings are plain text; surfaces escape them.

import { age, clock, span, spokenClock, spokenSpan } from './time';
import type {
  Attention, BucketState, BucketVM, FreshInput, FreshState, FreshVM, Kind, LoupeVM, PaceVM, Rune, TimeFmt, UsageErrorKind, Verdict,
} from './types';

export type Rounding = 'floor' | 'round';

const MIN = 60_000;
const HOUR = 3_600_000;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const floorTo = (x: number, d: number) => Math.floor(x * 10 ** d + 1e-9) / 10 ** d;
const ceilTo = (x: number, d: number) => Math.ceil(x * 10 ** d - 1e-9) / 10 ** d;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** At most `d` decimals, trailing zeros dropped: 16 → "16", 60.5 → "60.5", 61.184 → "61.18". */
export function num(x: number, d = 2): string {
  return String(Number(x.toFixed(d)));
}

/** How many decimals a number carries: 16 → 0, 16.34 → 2. */
export function decimalsIn(x: number): number {
  for (let d = 0; d < 6; d++) if (Number(x.toFixed(d)) === x) return d;
  return 6;
}

/** Rounds an instant to a whole number of minutes, so an ETA never claims more precision than its pace. */
export function roundClock(t: number, minutes: number): number {
  const step = minutes * MIN;
  return Math.round(t / step) * step;
}

export const isWeekly = (key: string) => key.startsWith('seven_day');

// ───────────────────────────── labels ─────────────────────────────

const FAMILIES = new Set(['fable', 'mythos', 'opus', 'sonnet', 'haiku']);
const DROPPED = new Set(['seven', 'day', 'five', 'hour', 'oauth']);

/** "seven_day_oauth_apps" → "Apps", "extra_usage" → "Extra usage"; at most 12 characters. */
export function humanise(key: string): string {
  const words = key.split('_').filter(w => w && !DROPPED.has(w.toLowerCase()));
  if (!words.length) return key;
  const s = words.join(' ');
  const name = s.charAt(0).toUpperCase() + s.slice(1);
  return name.length > 12 ? `${name.slice(0, 11)}…` : name;
}

export interface Labels { short: string; long: string; spoken: string }

export function labels(key: string): Labels {
  if (key === 'five_hour') return { short: '5h', long: '5-hour', spoken: 'five-hour' };
  if (key === 'seven_day') return { short: 'wk', long: 'Weekly', spoken: 'weekly' };
  const name = humanise(key);
  // Model names are proper nouns; anything else reads as a common noun.
  const said = FAMILIES.has(name.split(' ')[0].toLowerCase()) ? name : name.toLowerCase();
  if (key.startsWith('seven_day_')) return { short: `${name} wk`, long: `${name} weekly`, spoken: `${said} weekly` };
  if (key.startsWith('five_hour_')) return { short: `${name} 5h`, long: `${name} 5-hour`, spoken: `${said} five-hour` };
  return { short: name, long: name, spoken: said };
}

/** five_hour, seven_day, other seven_day_* alphabetically, then everything else alphabetically. */
export function keyOrder(a: string, b: string): number {
  const rank = (k: string) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : k.startsWith('seven_day_') ? 2 : 3);
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

// ───────────────────────────── digits, ±, value text ─────────────────────────────

/** Decimals the uncertainty supports: the last digit's unit is the largest power of ten not above 2σ, capped at `max`. */
export function digitsFor(sigma: number | undefined, max: number, precision: 'adaptive' | 'fixed' = 'adaptive'): number {
  if (precision === 'fixed' || sigma === undefined || !(sigma > 0)) return max;
  return clamp(Math.ceil(-Math.log10(2 * sigma) - 1e-9), 0, max);
}

/** The ± rounded up, so it never understates and is never smaller than one unit of the last digit. */
export function pmText(sigma: number, d: number): string {
  const k = Math.max(1, Math.ceil(sigma * 10 ** d - 1e-9));
  return `±${(k / 10 ** d).toFixed(d)}`;
}

/** The official reading's bracket [lo, hi): floor 37 → [37, 38), round 37 → [36.5, 37.5); none when exact. */
export function bracketOf(official: number, rounding: Rounding, exact: boolean): [number, number] | undefined {
  if (exact) return undefined;
  return rounding === 'round' ? [official - 0.5, official + 0.5] : [official, official + 1];
}

/** "61.18%". Never rounds up across the official bracket's top edge, nor shows less than its bottom. */
export function valueText(v: number, d: number, bracket?: [number, number], official = 0): string {
  if (!isFinite(v)) return '—';
  let x = Number(v.toFixed(d));
  if (bracket && v < bracket[1] && x >= bracket[1]) x = bracket[1] - 10 ** -d;
  if (bracket && x < bracket[0]) x = bracket[0];
  if (official >= 100 || x >= 100) return '100%';
  return `${Math.max(0, x).toFixed(d)}%`;
}

/** The calibrating range: "16–17%", round mode "15.5–16.5%". */
export function bracketText(b: [number, number]): string {
  return `${num(Math.max(0, b[0]), 1)}–${num(Math.min(100, b[1]), 1)}%`;
}

/** A loose estimate as its proven range, rounded outward: "23.1–24.5%". */
export function looseText(lo: number, hi: number, d = 1): string {
  const a = floorTo(Math.max(0, lo), d), b = Math.min(100, ceilTo(hi, d));
  return `${a.toFixed(d)}–${b >= 100 ? '100' : b.toFixed(d)}%`;
}

/** A stale lower bound, rounded down: "≥61.1%". */
export function atLeastText(x: number, d: number): string {
  return `≥${floorTo(Math.max(0, x), d).toFixed(d)}%`;
}

export interface ValueIn {
  state: BucketState;
  value: number;
  sigma?: number;
  lo?: number;
  hi?: number;
  official: number;
  bracket?: [number, number];
  max: number;                            // tokenomancer.decimals
  precision: 'adaptive' | 'fixed';
  ageMs?: number;                         // since the last official reading
}

/** The value text, its ± (pinned, exact with σ and counted only) and the decimals used. */
export function displayValue(o: ValueIn): { text: string; pm?: string; digits: number } {
  // Exact without a fit has no σ: show the endpoint's own decimals, capped (critique P0-7).
  const d = o.sigma !== undefined ? digitsFor(o.sigma, o.max, o.precision) : Math.min(decimalsIn(o.official), o.max);
  switch (o.state) {
    case 'limit': return { text: '100%', digits: 0 };
    case 'idle': return { text: '0%', digits: 0 };
    case 'reset': return { text: '—', digits: 0 };
    case 'calibrating': {
      const b = o.bracket ?? [o.official, o.official + 1];
      return { text: bracketText(b), digits: decimalsIn(b[0]) ? 1 : 0 };
    }
    case 'stale': {
      // Unseen usage can only add, so a stale value is a lower bound, with fewer digits as it ages.
      const x = o.lo ?? o.bracket?.[0] ?? o.official;
      const base = o.lo !== undefined ? d : Math.min(decimalsIn(x), o.max);
      const ds = o.ageMs === undefined || o.ageMs > HOUR ? 0 : Math.min(base, 1);
      return { text: atLeastText(x, ds), digits: ds };
    }
    case 'loose': {
      const dl = Math.min(1, o.max);
      if (o.lo === undefined || o.hi === undefined) return { text: bracketText(o.bracket ?? [o.official, o.official + 1]), digits: 0 };
      return { text: looseText(o.lo, o.hi, dl), digits: dl };
    }
  }
  const text = valueText(o.value, d, o.bracket, o.official);
  const pm = o.sigma !== undefined ? pmText(o.sigma, d) : undefined;
  return { text: o.state === 'counted' ? `~${text}` : text, pm, digits: d };
}

// ───────────────────────────── states ─────────────────────────────

export const STATE_WORD: Record<BucketState, string> = {
  pinned: 'pinned', exact: 'exact', counted: 'counted', loose: 'loose', calibrating: 'calibrating',
  stale: 'last known', limit: 'limit', idle: 'idle', reset: 'reset',
};

export const STATE_RUNE: Record<BucketState, Rune> = {
  pinned: 'pinned', exact: 'pinned', counted: 'loose', loose: 'loose', calibrating: 'calibrating',
  stale: 'loose', limit: 'pinned', idle: 'pinned', reset: 'empty',
};

const KIND_STATE: Record<Kind, BucketState> = {
  official: 'calibrating', anchored: 'pinned', precise: 'exact', 'window-start': 'counted', 'lower-bound': 'loose',
};

export interface StateIn {
  kind: Kind;
  official: number;
  resetsAt?: number;                      // ms; undefined when unknown
  raw?: { utilization: number; resetsAt: string | null; t: number };
  stale: boolean;
  now: number;
}

/** §3.2.3, first match wins. A limit whose reset has passed is no longer a limit. */
export function stateOf(o: StateIn): BucketState {
  const resetPassed = o.resetsAt !== undefined && o.resetsAt < o.now - MIN && !(o.raw && o.raw.t > o.resetsAt);
  if (o.official >= 100 && !resetPassed) return 'limit';
  if (o.raw && o.raw.resetsAt === null && o.raw.utilization === 0) return 'idle';
  if (resetPassed) return 'reset';
  if (o.stale) return 'stale';
  return KIND_STATE[o.kind];
}

/** One or two sentences explaining a state, for chips and the hover. */
export function stateTip(state: BucketState, o: { unseen?: boolean; armed: boolean; ageMs?: number }): string {
  switch (state) {
    case 'pinned': return 'Pinned between two official ticks. The tightest reading.';
    case 'exact': return 'The usage endpoint returned decimals.';
    case 'counted': return 'Counted from the start of this window with your local logs. Tightens at the next tick.';
    case 'loose': return o.unseen
      ? 'Usage outside this computer (claude.ai, the Claude app, another device) moved the official number. Bounded loosely until the next tick.'
      : 'Bounded only by the official ticks. Tightens at the next tick.';
    case 'calibrating': return o.armed
      ? 'Learning what 1% costs. One tick seen; decimals appear after the next one while you use Claude Code here.'
      : 'Learning what 1% costs. Decimals appear after the official number ticks twice while you use Claude Code here.';
    case 'stale': return o.ageMs === undefined
      ? 'No official reading yet this session. Usage since the last one can only add, so this is a lower bound.'
      : `Official numbers haven't updated for ${spokenSpan(o.ageMs)}. Usage elsewhere since then can only add, so this is a lower bound.`;
    case 'limit': return 'The official number reached 100% for this window.';
    case 'idle': return 'No window is running. One starts with your next Claude message.';
    case 'reset': return 'This window has reset. The next official reading starts the new one.';
  }
}

// ───────────────────────────── freshness ─────────────────────────────

/** How old a reading may be before values become lower bounds: max(3 polls, 5 min). */
export function staleAfterMs(pollMs: number): number {
  return Math.max(3 * pollMs, 300_000);
}

const ERROR_STATE: Record<UsageErrorKind, FreshState> = {
  'no-credentials': 'signed-out', expired: 'expired', auth: 'auth', 'rate-limited': 'rate-limited', network: 'offline', format: 'format',
};

/** One sentence, plus the next try, explaining why numbers aren't current. */
export function reasonText(f: FreshInput, now: number, fmt: TimeFmt): string | undefined {
  const since = f.lastOkAt !== undefined ? ` since ${clock(f.lastOkAt, now, fmt)}` : ' meanwhile';
  const next = f.nextTryAt !== undefined && f.nextTryAt > now ? `; next try ${clock(f.nextTryAt, now, fmt)}` : '';
  const counting = `Counting local tokens${since}${next}.`;
  const code = f.error?.code;
  switch (f.error?.kind) {
    case 'rate-limited': return `Anthropic is rate-limiting the usage endpoint (${code ?? 'HTTP 429'}). ${counting}`;
    case 'network': return code?.startsWith('HTTP')
      ? `The usage endpoint returned an error (${code}). ${counting}`
      : `Can't reach api.anthropic.com${code ? ` (${code})` : ''}. ${counting}`;
    case 'expired': return "Claude Code's sign-in token expired; it refreshes the next time you send Claude a message. Counting local tokens meanwhile.";
    case 'auth': return `The usage endpoint refused the sign-in${code ? ` (${code})` : ''}. Send a message in Claude Code to refresh it.`;
    case 'no-credentials': return `Looked for a Claude Code sign-in in ${f.claudeDir}. Sign in to Claude Code and this fills in by itself.`;
    case 'format': return 'The usage endpoint answered in an unexpected format. Token counts still work; percentages are paused.';
  }
  return undefined;
}

/** Freshness of the official numbers: live ≤ 2 polls + 15 s, delayed ≤ staleAfter, stale beyond. */
export function freshOf(f: FreshInput, now: number, pollMs: number, fmt: TimeFmt): FreshVM {
  const ageMs = f.lastOkAt !== undefined ? Math.max(0, now - f.lastOkAt) : undefined;
  // With no reading this session, anything cached is of unknown age: a lower bound.
  const stale = ageMs === undefined || ageMs > staleAfterMs(pollMs);
  const state: FreshState = f.error ? ERROR_STATE[f.error.kind]
    : ageMs === undefined ? 'starting'
    : ageMs <= 2 * pollMs + 15_000 ? 'live'
    : stale ? 'stale' : 'delayed';
  const reason = reasonText(f, now, fmt) ?? (stale && f.lastOkAt !== undefined
    ? `No new official reading since ${clock(f.lastOkAt, now, fmt)}. Values are lower bounds until the next one.`
    : undefined);
  return {
    state, stale, lastOkAt: f.lastOkAt,
    ageText: ageMs !== undefined ? age(ageMs, 'hover') : undefined,
    nextTryAt: f.nextTryAt,
    nextTryText: f.nextTryAt !== undefined && f.nextTryAt > now ? clock(f.nextTryAt, now, fmt) : undefined,
    reason, code: f.error?.code, refreshing: f.refreshing, role: f.role,
  };
}

// ───────────────────────────── pace, verdict, caption ─────────────────────────────

/** Why pace is withheld; each has its own sentence. */
export type Hold = 'early' | 'weekEarly' | 'calibrating' | 'loose' | 'stale' | 'idle' | 'reset' | 'noReset';

export function withheldText(h: Hold): string {
  switch (h) {
    case 'early': return 'Pace appears after a few minutes of use';
    case 'weekEarly': return 'Pace appears 6 hours into the week';
    case 'calibrating': return 'Pace appears once calibrated';
    case 'loose': return 'Pace appears after the next official tick';
    case 'stale': return 'Pace resumes with the next official reading';
    case 'idle': return 'No window running; one starts with your next message';
    case 'reset': return 'Window reset; waiting for the next reading';
    case 'noReset': return "Pace needs a reset time, which the endpoint didn't send";
  }
}

function minutesRange(fromMs: number, toMs: number): string {
  const a = fromMs / MIN, b = toMs / MIN;
  if (b < 1) return '<1 min';
  if (b - a < 1) return `~${b < 60 ? `${Math.round((a + b) / 2)} min` : span((fromMs + toMs) / 2)}`;
  if (b < 60) return `${Math.max(1, Math.round(a))}–${Math.round(b)} min`;
  return `${span(fromMs)}–${span(toMs)}`;
}

/** "15.8 pts ahead of even use", "1 pt below even use", "on even use". */
export function evenText(gap: number): string {
  const n = num(Math.abs(gap), 1);
  if (n === '0') return 'on even use';
  return `${n} ${n === '1' ? 'pt' : 'pts'} ${gap > 0 ? 'ahead of' : 'below'} even use`;
}

/** "next 1% in 25–27 min · 15.8 pts ahead of even use", or the withheld sentence. */
export function paceText(p: PaceVM | undefined, now: number, held: string): string {
  if (!p) return held;
  const next = p.nextTick ? `next 1% in ${minutesRange(p.nextTick.from - now, p.nextTick.to - now)}`
    : p.r15 !== undefined ? 'no use here in the last 15 min' : '';
  return next ? `${next} · ${evenText(p.evenGap)}` : upperFirst(evenText(p.evenGap));
}

/** Run-out clocks round to 5 min (5-hour) or 30 min (weekly kinds). */
export const runOutClock = (key: string, t: number) => roundClock(t, isWeekly(key) ? 30 : 5);

/**
 * "lands ~62–71% by 15:06". When even the low pace reaches 100 but the verdict isn't "runs out"
 * (a weekly average under a day old), it only "could reach 100%": never a run-out claim in disguise.
 */
function lands(p: PaceVM, reset: string, spoken = false): string {
  const a = Math.round(p.projLow), b = Math.round(p.projHigh);
  const pct = spoken ? ' percent' : '%';
  if (a >= 100) return `could reach 100${pct} before ${reset}`;
  const range = a === b ? `${a}` : spoken ? `${a} to ${b}` : `${a}–${b}`;
  return spoken ? `lands around ${range}${pct} by ${reset}` : `lands ~${range}${pct} by ${reset}`;
}

export interface VerdictIn { key: string; verdict: Verdict; pace?: PaceVM; resetsAt?: number; now: number; fmt: TimeFmt; held: string }

/** Card and glance verdict: "Runs out ~Sat 13:30 — 1d 19h before reset", "Lands ~62–71% by 15:06", … */
export function verdictText(o: VerdictIn): string {
  const R = o.resetsAt;
  const at = (t: number) => clock(t, o.now, o.fmt);
  switch (o.verdict) {
    case 'limited': return R !== undefined ? `Limit reached · resets ${at(R)} (in ${span(R - o.now)})` : 'Limit reached';
    case 'withheld': return o.held;
    case 'runsOut': {
      const mid = runOutClock(o.key, o.pace!.runOut!.mid);
      return R === undefined || R - mid < 5 * MIN ? `Runs out ~${at(mid)}, around its reset` : `Runs out ~${at(mid)} — ${span(R - mid)} before reset`;
    }
    default: return upperFirst(lands(o.pace!, at(R!)));
  }
}

export interface CaptionIn {
  state: BucketState;
  lo?: number; hi?: number;
  bracket?: [number, number];
  sigma?: number;
  value: string;                          // the display value text
  unseen?: boolean;
  armed: boolean;
  resetsAt?: number;
  ageMs?: number;
  now: number;
  fmt: TimeFmt;
}

/** The Loupe caption. Bounds round outward, so they never claim more than is proven. */
export function captionText(o: CaptionIn): string {
  const bounds = o.lo !== undefined && o.hi !== undefined ? ` · bounds ${floorTo(o.lo, 2).toFixed(2)}–${ceilTo(o.hi, 2).toFixed(2)}%` : '';
  switch (o.state) {
    case 'pinned': return `Pinned between official ticks${bounds}`;
    case 'exact': return `Decimals from the endpoint${o.sigma !== undefined ? bounds : ''}`;
    case 'counted': return 'Counted from the window start; tightens at the next tick';
    case 'loose': return `Loose: somewhere in ${o.value}${o.unseen ? ' (usage elsewhere)' : ' until the next tick'}`;
    case 'calibrating': return `Somewhere in ${o.value} · calibrating, ${o.armed ? 'one tick seen' : 'waiting for two ticks'}`;
    case 'stale': return `At least ${o.value.slice(1)} · ${o.ageMs !== undefined ? age(o.ageMs, 'hover') : 'no reading yet this session'}`;
    case 'limit': return o.resetsAt !== undefined ? `Limit reached · resets ${clock(o.resetsAt, o.now, o.fmt)}` : 'Limit reached';
    case 'idle': return 'No window running';
    case 'reset': return o.resetsAt !== undefined ? `Window reset at ${clock(o.resetsAt, o.now, o.fmt)} · waiting for the next reading` : 'Window reset · waiting for the next reading';
  }
}

// ───────────────────────────── spoken text (§3.5) ─────────────────────────────

/** "61.18 percent used, plus or minus 0.03", "between 16 and 17 percent used, official whole number", … */
export function spokenValue(state: BucketState, value: string, pm?: string): string {
  const n = value.replace(/[~≥%]/g, '');
  const [a, b] = n.split('–');
  const pmPart = pm ? `, plus or minus ${pm.replace('±', '')}` : '';
  switch (state) {
    case 'counted': return `about ${n} percent used${pmPart}`;
    case 'loose': return `between ${a} and ${b} percent used`;
    case 'calibrating': return `between ${a} and ${b} percent used, official whole number`;
    case 'stale': return `at least ${n} percent used`;
    case 'reset': return 'reset, waiting for a new reading';
    default: return `${n} percent used${pmPart}`;
  }
}

/** "Claude weekly limit: 61.18 percent used, plus or minus 0.03, pinned" (no final period). */
export function spoken(spokenLabel: string, state: BucketState, value: string, pm?: string): string {
  if (state === 'limit') return `Claude ${spokenLabel} limit reached`;
  if (state === 'reset') return `Claude ${spokenLabel} limit: ${spokenValue(state, value)}`;
  return `Claude ${spokenLabel} limit: ${spokenValue(state, value, pm)}, ${STATE_WORD[state]}`;
}

export interface SpokenFullIn {
  key: string; state: BucketState; verdict: Verdict; pace?: PaceVM; resetsAt?: number;
  armed: boolean; held: string; ageMs?: number; now: number; fmt: TimeFmt;
}

/** The verdict as a sentence for screen readers. */
export function spokenVerdict(o: SpokenFullIn): string {
  const R = o.resetsAt;
  const at = (t: number) => spokenClock(t, o.now, o.fmt);
  const how = isWeekly(o.key) ? 'At your average pace this week' : 'At this pace';
  switch (o.verdict) {
    case 'limited': return R !== undefined ? `Resets at ${at(R)}, in ${spokenSpan(R - o.now)}` : '';
    case 'runsOut': {
      const mid = runOutClock(o.key, o.pace!.runOut!.mid);
      const lead = R === undefined || R - mid < 5 * MIN ? 'around when it resets' : `${spokenSpan(R - mid)} before it resets`;
      return `${how} it reaches 100 percent around ${at(mid)}, ${lead}`;
    }
    case 'withheld':
      if (o.state === 'calibrating') return o.armed ? 'Decimals appear after the next official tick' : 'Decimals appear after two official ticks while you use Claude Code here';
      return o.state === 'stale' || o.state === 'reset' || o.state === 'idle' ? '' : o.held;
    default: return `${how} it ${lands(o.pace!, at(R!), true)}`;
  }
}

/** "Official reading 1 minute ago", "Official numbers not updated for 12 minutes". */
export function spokenAge(ageMs: number | undefined, stale: boolean): string {
  if (ageMs === undefined) return 'No official reading yet this session';
  if (stale) return `Official numbers not updated for ${spokenSpan(ageMs)}`;
  return ageMs < MIN ? 'Official reading just now' : `Official reading ${spokenSpan(ageMs)} ago`;
}

// ───────────────────────────── image alt text (§4.4) ─────────────────────────────

/** "Weekly: 61.18 percent used; 45 percent of the window elapsed; projected 62 to 71 percent at reset." */
export function meterAlt(b: BucketVM): string {
  const used = b.state === 'reset' ? 'reset' : spokenValue(b.state, b.text.value, b.text.pm);
  const el = b.elapsed !== undefined ? `; ${Math.round(b.elapsed * 100)} percent of the window elapsed` : '';
  const [lo, hi] = b.pace ? [Math.round(b.pace.projLow), Math.round(b.pace.projHigh)] : [];
  const proj = b.pace ? `; projected ${lo === hi ? lo : `${lo} to ${hi}`} percent at reset` : '';
  return `${b.long}: ${used}${el}${proj}.`;
}

/** "Weekly between 61 and 62 percent: estimate 61.18, plus or minus 0.03, pinned." */
export function loupeAlt(b: BucketVM, l: LoupeVM = b.loupe): string {
  const [a, z] = l.edgeLabels;
  const est = l.tick !== undefined ? `estimate ${b.text.value.replace(/[~%]/g, '')}` : spokenValue(b.state, b.text.value);
  const pm = l.tick !== undefined && b.text.pm ? `, plus or minus ${b.text.pm.replace('±', '')}` : '';
  return `${b.long} between ${a} and ${z} percent: ${est}${pm}, ${b.text.state}.`;
}

// ───────────────────────────── headline (§4.3) ─────────────────────────────

export interface Headline { strong: string; rest: string; tone: 'neutral' | 'warn' | 'crit' }

const toneOf = (a: Attention): Headline['tone'] => (a >= 3 ? 'crit' : a >= 1 ? 'warn' : 'neutral');

function emptyHeadline(f: FreshVM): Headline {
  const h = (strong: string, rest = ''): Headline => ({ strong, rest, tone: 'neutral' });
  switch (f.state) {
    case 'starting': return h('Reading your plan usage…');
    case 'signed-out': return h('No Claude Code sign-in found');
    case 'format': return h('The usage endpoint answered in an unexpected format');
    case 'expired': return h('Waiting for Claude Code to refresh its sign-in');
    case 'offline': case 'rate-limited': case 'auth': return h("Can't read plan usage yet", f.nextTryText ? `next try ${f.nextTryText}` : '');
    default: return h('No plan limits in the latest reading');
  }
}

/** The one-line summary. `buckets` is in binding order, the binding limit first. */
export function headline(buckets: BucketVM[], f: FreshVM, now: number, fmt: TimeFmt): Headline {
  if (!buckets.length) return emptyHeadline(f);
  const at = (t: number) => clock(t, now, fmt);
  const maxAtt = Math.max(...buckets.map(b => b.attention)) as Attention;

  const lim = buckets.find(b => b.verdict === 'limited');
  if (lim) {
    const R = lim.resetsAt;
    return { strong: `${lim.long} limit reached`, rest: R !== undefined ? `resets ${at(R)} (in ${span(R - now)})` : '', tone: 'crit' };
  }
  if (f.state === 'starting') return { strong: 'Reading your plan usage…', rest: '', tone: toneOf(maxAtt) };
  if (f.stale) {
    const rest = f.lastOkAt !== undefined ? `official numbers not updated for ${spokenSpan(now - f.lastOkAt)}` : 'no official reading yet this session';
    return { strong: 'Last known', rest, tone: maxAtt >= 2 ? 'warn' : 'neutral' };
  }
  const run = buckets.find(b => b.verdict === 'runsOut');
  if (run) {
    const mid = runOutClock(run.key, run.pace!.runOut!.mid), R = run.resetsAt!;
    const how = isWeekly(run.key) ? 'at your average pace this week' : 'at this pace';
    const lead = R - mid < 5 * MIN ? 'around when it resets' : `${span(R - mid)} before it resets`;
    return { strong: `${run.long} runs out ~${at(mid)}`, rest: `${lead}, ${how}`, tone: toneOf(run.attention) };
  }
  const tight = buckets.find(b => b.verdict === 'tight');
  if (tight) return { strong: 'Tight', rest: `${tight.long} ${lands(tight.pace!, at(tight.resetsAt!))}`, tone: toneOf(tight.attention) };

  const live = buckets.filter(b => b.state !== 'reset');
  const b = buckets[0];
  if (!live.length) return { strong: `${b.long} window reset`, rest: 'waiting for the next reading', tone: 'neutral' };
  if (live.every(x => x.state === 'calibrating')) {
    return { strong: 'Calibrating', rest: "showing Anthropic's whole numbers until the next ticks", tone: toneOf(maxAtt) };
  }
  if (b.verdict === 'steady') {
    const rest = live.every(x => x.verdict === 'steady') ? 'every limit lasts until its reset' : `${b.long} lasts until its reset at this pace`;
    return { strong: 'On track', rest, tone: 'neutral' };
  }
  if (b.state === 'idle') return { strong: 'No window running', rest: 'one starts with your next Claude message', tone: 'neutral' };
  return { strong: `${b.long} is your highest limit`, rest: lowerFirst(b.text.pace), tone: toneOf(b.attention) };
}
