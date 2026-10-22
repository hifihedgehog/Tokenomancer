// Builds the ViewModel every surface renders, from Estimates the model already
// computed: this file never calls estimate(), so a clock-only rebuild is cheap.
// The builder keeps state only for seq and hysteresis (which limit binds,
// attention levels, run-out verdicts). Pure: no vscode, no Node.

import { windowLengthMs } from '../estimator';
import {
  Hold, Rounding, STATE_RUNE, STATE_WORD, bracketOf, captionText, displayValue, freshOf, headline, isWeekly, keyOrder,
  labels, num, paceText, spoken, spokenAge, spokenVerdict, stateOf, stateTip, verdictText, withheldText,
} from './present';
import { clock, span } from './time';
import type {
  Attention, BucketInput, BucketState, BucketVM, LoupeVM, MeterVM, ModelInput, PaceVM, UiConfig, Verdict, ViewModel,
} from './types';

export { staleAfterMs } from './present';

const MIN = 60_000;
const HOUR = 3_600_000;
const DWELL_MS = 10 * MIN;     // the shown limit changes at most this often within a class
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const cmp = (x: number, y: number) => (x < y ? -1 : x > y ? 1 : 0);

// ───────────────────────────── pace and verdict (§3.2.5) ─────────────────────────────

export interface PaceIn {
  key: string;
  state: BucketState;
  value: number;
  sigma?: number;
  rate?: number;                          // Estimate.ratePctPerHour: this computer, last 15 min
  windowStart?: number;
  resetsAt?: number;
  now: number;
  rounding: Rounding;
  exact: boolean;
}

export interface PaceOut { pace?: PaceVM; hold?: Hold; canRunOut: boolean }

const HELD: Partial<Record<BucketState, Hold>> = { calibrating: 'calibrating', loose: 'loose', stale: 'stale', idle: 'idle', reset: 'reset' };

/** Pace, projection and next tick; or why they're withheld. */
export function paceOf(o: PaceIn): PaceOut {
  const weekly = isWeekly(o.key);
  const len = windowLengthMs(o.key);
  const R = o.resetsAt, S = o.windowStart;
  // An average over the first day of a week has no nights in it and runs ~3× fast (critique P1-12).
  const canRunOut = !weekly || (S !== undefined && o.now - S >= 24 * HOUR);
  const held = (hold: Hold): PaceOut => ({ hold, canRunOut });
  if (o.state === 'limit') return { canRunOut };
  const h = HELD[o.state];
  if (h) return held(h);
  if (R === undefined || S === undefined || !len) return held('noReset');
  if (R <= o.now) return held('reset');

  const elapsedMs = o.now - S;
  const e = clamp(elapsedMs / len, 0, 1);
  const early: Hold = weekly ? 'weekEarly' : 'early';
  if (e < 0.03) return held(early);
  const v = o.value, r15 = o.rate;
  const rAvg = elapsedMs >= (weekly ? 6 * HOUR : 15 * MIN) ? v / (elapsedMs / HOUR) : undefined;
  // The 15-minute pace is never projected over days.
  const rates = weekly ? [rAvg] : [r15, rAvg];
  const known = rates.filter((r): r is number => r !== undefined);
  if (!known.length || (!weekly && (r15 ?? 0) <= 0.01 && rAvg === undefined)) return held(early);

  const low = Math.min(...known), high = Math.max(...known);
  const hours = (R - o.now) / HOUR;
  const pace: PaceVM = {
    low, high,
    projLow: Math.min(100, v + low * hours),
    projHigh: Math.min(100, v + high * hours),
    evenUse: 100 * e,
    evenGap: v - 100 * e,
  };
  if (r15 !== undefined) pace.r15 = r15;
  if (rAvg !== undefined) pace.rAvg = rAvg;
  if (pace.projHigh >= 100 && high > 0) {
    const at = (r: number) => o.now + (Math.max(0, 100 - v) / Math.max(r, 0.01)) * HOUR;
    pace.runOut = { from: at(high), to: at(low), mid: at((low + high) / 2) };
  }
  if (r15 !== undefined && r15 > 0.01) {
    const edge = o.exact || o.rounding === 'floor' ? Math.floor(v + 1e-9) + 1 : Math.floor(v + 0.5 + 1e-9) + 0.5;
    const s = o.sigma ?? 0;
    const at = (x: number) => o.now + (Math.max(0, edge - x) / r15) * HOUR;
    pace.nextTick = { from: at(v + s), to: at(v - s), edge };
  }
  return { pace, canRunOut };
}

export interface VerdictIn { state: BucketState; pace?: PaceVM; canRunOut: boolean; resetsAt?: number; wasRunsOut: boolean }

/** limited › withheld › runsOut (both paces agree) › tight (≥ 90 at the high pace) › steady. */
export function verdictOf(o: VerdictIn): Verdict {
  if (o.state === 'limit') return 'limited';
  const p = o.pace;
  if (!p) return 'withheld';
  // Once it says "runs out", it keeps saying so until the middle estimate is 15 min past the reset.
  const stays = o.wasRunsOut && p.runOut !== undefined && o.resetsAt !== undefined && p.runOut.mid < o.resetsAt + 15 * MIN;
  if (o.canRunOut && (p.projLow >= 100 || stays)) return 'runsOut';
  return p.projHigh >= 90 ? 'tight' : 'steady';
}

export interface AttentionIn { state: BucketState; value: number; pace?: PaceVM; canRunOut: boolean; verdict: Verdict }

/** §3.2.7 with hysteresis on A2 (enter 97 / exit 96, 30 / 45 min) and A1 at ≥ 90 when pace is withheld. */
export function attentionOf(o: AttentionIn, prev: Attention): Attention {
  if (o.state === 'limit') return 3;
  if (o.state === 'idle' || o.state === 'reset') return 0;
  const v = o.value;
  const high = o.canRunOut ? o.pace?.high : undefined;
  const hoursLeft = high !== undefined && high > 0 ? Math.max(0, 100 - v) / high : undefined;
  const urgent = v >= 97 || (o.pace !== undefined && o.pace.projHigh >= 100 && hoursLeft !== undefined && hoursLeft <= 0.5);
  const calm = v < 96 && (hoursLeft === undefined || hoursLeft > 0.75);
  if (urgent || (prev >= 2 && !calm)) return 2;
  if (o.verdict === 'runsOut') return 1;
  if (o.verdict === 'withheld' && (v >= 90 || (prev >= 1 && v >= 89))) return 1;
  return 0;
}

// ───────────────────────────── binding order (§3.2.6) ─────────────────────────────

/** 0 limited · 1 urgent · 2 runs out · 3 others · 4 calibrating, idle or reset under 80 · 5 reset (excluded). */
export function rankOf(b: BucketVM, allReset = false): number {
  if (b.state === 'reset' && !allReset) return 5;
  if (b.verdict === 'limited') return 0;
  if (b.attention >= 2) return 1;
  if (b.verdict === 'runsOut') return 2;
  if ((b.state === 'calibrating' || b.state === 'idle' || b.state === 'reset') && b.value < 80) return 4;
  return 3;
}

const score = (b: BucketVM) => b.pace?.projHigh ?? b.value;

export function bindingOrder(list: BucketVM[]): BucketVM[] {
  const allReset = list.length > 0 && list.every(b => b.state === 'reset');
  const ranked = list.map(b => ({ b, r: rankOf(b, allReset) }));
  ranked.sort(({ b: a, r: ra }, { b, r: rb }) =>
    cmp(ra, rb)
    || (ra === 0 ? cmp(b.resetsAt ?? 0, a.resetsAt ?? 0) : 0)
    || (ra === 1 || ra === 2 ? cmp(a.pace?.runOut?.mid ?? Infinity, b.pace?.runOut?.mid ?? Infinity) : 0)
    || (ra >= 3 ? cmp(score(b), score(a)) : 0)
    || cmp(b.value, a.value)
    || keyOrder(a.key, b.key));
  return ranked.map(x => x.b);
}

// ───────────────────────────── meter and Loupe (§4.4) ─────────────────────────────

type ArtIn = Pick<BucketVM, 'state' | 'value' | 'sigma' | 'lo' | 'hi' | 'bracket' | 'official' | 'pace' | 'elapsed' | 'attention'>;

export function meterOf(b: ArtIn): MeterVM {
  const fill = clamp(meterValue(b), 0, 100);
  const m: MeterVM = { fill, tone: b.attention >= 3 ? 'crit' : b.attention >= 2 ? 'warn' : 'accent' };
  if (b.pace && b.pace.projHigh > fill + 0.05) m.ghost = [fill, Math.min(100, b.pace.projHigh)];
  if (b.elapsed !== undefined) m.elapsed = b.elapsed * 100;
  return m;
}

function meterValue(b: ArtIn): number {
  switch (b.state) {
    case 'limit': return 100;
    case 'idle': case 'reset': return 0;
    case 'calibrating': return b.bracket?.[0] ?? b.official;
    case 'stale': return b.lo ?? b.bracket?.[0] ?? b.official;
    default: return b.value;
  }
}

const LOUPE_MODE: Record<BucketState, LoupeVM['mode']> = {
  pinned: 'graded', exact: 'graded', counted: 'graded', loose: 'flat', calibrating: 'range', stale: 'atLeast',
  limit: 'none', idle: 'none', reset: 'none',
};

/** A magnified scale 1–2 official brackets wide, with the estimate's bands clipped to its proven bounds. */
export function loupeOf(b: ArtIn, rounding: Rounding): LoupeVM {
  const mode = LOUPE_MODE[b.state];
  const v = b.value, s = b.sigma;
  const off = b.bracket ? b.bracket[0] - Math.floor(b.bracket[0]) : 0;   // edges sit at off + k
  const below = (x: number) => off + Math.floor(x - off + 1e-9);
  const above = (x: number) => off + Math.ceil(x - off - 1e-9);
  // Round mode's brackets run from [-0.5, 0.5) to [99.5, 100.5).
  const [lowest, highest] = b.bracket && rounding === 'round' ? [-0.5, 100.5] : [0, 100];
  const bracket = b.bracket ?? [below(v), below(v) + 1];
  const atLeast = b.lo ?? bracket[0];

  const ext: [number, number] =
    mode === 'graded' ? [b.lo ?? v - 2 * (s ?? 0), b.hi ?? v + 2 * (s ?? 0)]
    : mode === 'flat' ? [b.lo ?? v, b.hi ?? v]
    : mode === 'atLeast' ? [atLeast, atLeast]
    : bracket;
  let from = below(ext[0]), to = above(ext[1]);
  if (to - from > 2) { from = off + Math.round(v - off) - 1; to = from + 2; }   // too wide: centre two brackets on v
  if (mode === 'atLeast' && atLeast - from > 0.7) to = from + 2;
  if (to - from < 1) to = from + 1;
  if (from < lowest) { to += lowest - from; from = lowest; }
  if (to > highest) { from -= to - highest; to = highest; }

  const edges: number[] = [];
  for (let x = from; x <= to + 1e-9; x++) edges.push(Number(x.toFixed(1)));
  const l: LoupeVM = { mode, from, to, edges, edgeLabels: [num(from, 1), num(to, 1)] };
  const clip = (a: number, z: number): [number, number] => {
    const lo = Math.max(a, b.lo ?? -Infinity, from), hi = Math.min(z, b.hi ?? Infinity, to);
    return [Math.min(lo, hi), hi];
  };
  const over = (a: number, z: number) => {
    if (Math.max(a, b.lo ?? -Infinity) < from - 1e-9) l.overL = true;
    if (Math.min(z, b.hi ?? Infinity) > to + 1e-9) l.overR = true;
  };
  switch (mode) {
    case 'graded':
      if (s !== undefined) {
        l.band1 = clip(v - s, v + s);
        l.band2 = clip(v - 2 * s, v + 2 * s);
        over(v - 2 * s, v + 2 * s);
      }
      l.tick = clamp(v, from, to);
      break;
    case 'flat':
      l.band2 = clip(b.lo ?? v, b.hi ?? v);
      over(b.lo ?? v, b.hi ?? v);
      l.tick = clamp(v, from, to);
      break;
    case 'range':
      l.band2 = [Math.max(from, bracket[0]), Math.min(to, bracket[1])];
      break;
    case 'atLeast':
      l.band2 = [clamp(atLeast, from, to), to];
      l.overR = true;
      break;
  }
  return l;
}

// ───────────────────────────── the builder ─────────────────────────────

interface Memory { win?: number; attention: Attention; runsOut: boolean }

function resetOf(b: BucketInput): number | undefined {
  // The endpoint's latest word wins: a null resets_at means the reset time is unknown.
  const iso = b.raw ? b.raw.resetsAt : b.estimate.resetsAt;
  const t = iso ? Date.parse(iso) : NaN;
  return isFinite(t) ? t : undefined;
}

export class ViewModelBuilder {
  private seq = 0;
  private bound?: { key: string; at: number };
  private mem = new Map<string, Memory>();

  build(input: ModelInput): ViewModel {
    const { now, cfg } = input;
    const fresh = freshOf(input.fresh, now, cfg.pollMs, cfg.time);
    const ageMs = input.fresh.lastOkAt !== undefined ? Math.max(0, now - input.fresh.lastOkAt) : undefined;
    const list = input.buckets.map(b => this.bucket(b, input, fresh.stale, ageMs));
    for (const k of [...this.mem.keys()]) if (!list.some(b => b.key === k)) this.mem.delete(k);

    const buckets = this.bind(bindingOrder(list), now);
    const notes: string[] = [];
    const extras = input.extras.map(x => ({ key: x.key, label: labels(x.key).long, text: `${num(x.utilization)}%` }));
    return {
      v: 1,
      seq: ++this.seq,
      now,
      sample: input.sample,
      fmt: cfg.time,
      rounding: cfg.rounding,
      pollMs: cfg.pollMs,
      display: { uncertainty: cfg.uncertainty, icon: cfg.icon, highlight: cfg.highlight, graphics: cfg.graphics, show: cfg.show },
      fresh,
      headline: headline(buckets, fresh, now, cfg.time),
      reasons: fresh.reason ? [fresh.reason] : [],
      bindingKey: buckets[0]?.key,
      buckets,
      shown: shownKeys(cfg, buckets, new Set(extras.map(x => x.key)), notes),
      extras,
      local: input.local,
      notes,
    };
  }

  private bucket(b: BucketInput, input: ModelInput, stale: boolean, ageMs?: number): BucketVM {
    const { now, cfg } = input, fmt = cfg.time, E = b.estimate, key = b.key;
    const max = clamp(Math.round(cfg.decimals) || 0, 0, 3);
    const lab = labels(key);
    const len = windowLengthMs(key);
    const R = resetOf(b);
    const exact = E.kind === 'precise';
    const official = b.raw?.utilization ?? E.official;
    const state = stateOf({ kind: E.kind, official, resetsAt: R, raw: b.raw, stale, now });
    // Idle means no window: whatever the estimator still carries from the last one doesn't apply.
    const idle = state === 'idle';
    const value = idle ? 0 : E.value;
    const sigma = idle ? undefined : E.sigma, lo = idle ? undefined : E.lo, hi = idle ? undefined : E.hi;
    const windowStart = idle ? undefined : E.windowStart ?? (R !== undefined && len ? R - len : undefined);
    const bracket = bracketOf(official, cfg.rounding, exact);
    const shown = displayValue({ state, value, sigma, lo, hi, official, bracket, max, precision: cfg.precision, ageMs });

    const { pace, hold, canRunOut } = paceOf({
      key, state, value, sigma, rate: E.ratePctPerHour, windowStart, resetsAt: R, now, rounding: cfg.rounding, exact,
    });
    const m = this.memory(key, windowStart);
    const verdict = verdictOf({ state, pace, canRunOut, resetsAt: R, wasRunsOut: m.runsOut });
    const attention = attentionOf({ state, value, pace, canRunOut, verdict }, m.attention);
    m.runsOut = verdict === 'runsOut';
    m.attention = attention;

    const held = hold ? withheldText(hold) : '';
    const elapsed = windowStart !== undefined && len && state !== 'reset' ? clamp((now - windowStart) / len, 0, 1) : undefined;
    const vm: BucketVM = {
      key, short: lab.short, long: lab.long, spokenLabel: lab.spoken,
      kind: E.kind, state, rune: STATE_RUNE[state],
      official, value, sigma, lo, hi, bracket,
      digits: shown.digits,
      windowMs: len, windowStart, resetsAt: R, elapsed,
      pace, verdict, attention,
      binding: false,
      calib: { samples: E.samples, armed: b.armed, wuPerPct: E.wuPerPct, spread: E.spread },
      meter: { fill: 0, tone: 'accent' },
      loupe: { mode: 'none', from: 0, to: 1, edges: [0, 1], edgeLabels: ['0', '1'] },
      text: {
        value: shown.text,
        pm: shown.pm,
        official: `${num(official)}%`,
        state: STATE_WORD[state],
        stateTip: stateTip(state, { unseen: E.unseen, armed: b.armed, ageMs }),
        caption: captionText({ state, lo, hi, bracket, sigma, value: shown.text, unseen: E.unseen, armed: b.armed, resetsAt: R, ageMs, now, fmt }),
        // A limit's verdict already says when it resets; the pace line has nothing to add.
        pace: state === 'limit' ? '' : paceText(pace, now, held),
        verdict: verdictText({ key, verdict, pace, resetsAt: R, now, fmt, held }),
        resetsAt: R !== undefined && !idle ? clock(R, now, fmt) : undefined,
        resetsIn: R !== undefined && R > now && !idle ? span(R - now) : undefined,
        spoken: spoken(lab.spoken, state, shown.text, shown.pm),
        spokenFull: '',
      },
    };
    vm.text.spokenFull = [
      vm.text.spoken,
      spokenVerdict({ key, state, verdict, pace, resetsAt: R, armed: b.armed, held, ageMs, now, fmt }),
      spokenAge(ageMs, stale),
    ].filter(Boolean).join('. ');
    vm.meter = meterOf(vm);
    vm.loupe = loupeOf(vm, cfg.rounding);
    return vm;
  }

  /** Per-bucket hysteresis memory, forgotten when a new window starts. */
  private memory(key: string, win?: number): Memory {
    let m = this.mem.get(key);
    const same = m && (m.win === win || (m.win !== undefined && win !== undefined && Math.abs(m.win - win) <= MIN));
    if (!m || !same) {
      m = { win, attention: 0, runsOut: false };
      this.mem.set(key, m);
    }
    return m;
  }

  /** Puts the limit that binds first at the front, switching away from the incumbent only for a clear reason. */
  private bind(sorted: BucketVM[], now: number): BucketVM[] {
    if (!sorted.length) { this.bound = undefined; return sorted; }
    const allReset = sorted.every(b => b.state === 'reset');
    const top = sorted[0];
    const inc = this.bound && sorted.find(b => b.key === this.bound!.key);
    let pick = top;
    if (inc && inc !== top && rankOf(inc, allReset) < 5) {
      const ri = rankOf(inc, allReset), rt = rankOf(top, allReset);
      // An urgent class (limited, A2, runs out) takes over at once. A calmer class change waits out
      // the dwell; within classes 3–4 the challenger also needs a 5-pt lead. Within classes 0–2 the
      // order is by time (reset, run-out), where a points margin means nothing, so the dwell alone applies.
      const dwelt = now - this.bound!.at >= DWELL_MS || now < this.bound!.at;
      const better = rt < ri ? rt <= 2 || dwelt : dwelt && (rt <= 2 || score(top) >= score(inc) + 5);
      if (!better) pick = inc;
    }
    if (this.bound?.key !== pick.key) this.bound = { key: pick.key, at: now };
    pick.binding = true;
    return [pick, ...sorted.filter(b => b !== pick)];
  }
}

/** The keys the status bar shows, per `show`. Unknown custom keys become notes. */
function shownKeys(cfg: UiConfig, ordered: BucketVM[], windowless: Set<string>, notes: string[]): string[] {
  if (!ordered.length) return [];
  const first = ordered[0].key;
  const rest = ordered.slice(1);
  switch (cfg.show) {
    case 'binding': return [first];
    case 'pair': {
      const second = first !== 'five_hour' ? rest.find(b => b.key === 'five_hour') ?? rest[0] : rest.find(b => b.state !== 'reset') ?? rest[0];
      return second ? [first, second.key] : [first];
    }
    case 'all':
      // A side limit that is idle at 0% with no window says nothing; the core two always show.
      return ordered.filter(b => b.state !== 'idle' || b.key === 'five_hour' || b.key === 'seven_day').map(b => b.key).sort(keyOrder);
    case 'custom': {
      const live = ordered.map(b => b.key);
      const keys = cfg.customKeys.filter((k, i) => live.includes(k) && cfg.customKeys.indexOf(k) === i);
      for (const k of cfg.customKeys) {
        if (live.includes(k)) continue;
        notes.push(windowless.has(k)
          ? `Status Bar Buckets lists "${k}", which has no time window, so the status bar leaves it out.`
          : `Status Bar Buckets lists "${k}", which the usage endpoint didn't return (it returned ${[...live].sort(keyOrder).join(', ')}).`);
      }
      if (keys.length) return keys;
      if (cfg.customKeys.length) notes.push('None of the Status Bar Buckets matched, so the status bar shows the limit that binds first.');
      return [first];
    }
  }
}
