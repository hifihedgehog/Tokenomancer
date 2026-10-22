// Sample data for screenshots and UI development: a scripted week of Claude Code traffic and the
// official readings it would have produced. Enabled only by TOKENOMANCER_DEMO=1 or the
// sample-data command; never touches real logs, credentials or saved calibration.
//
// Deterministic: the same scenario at any `now` (pin it with TOKENOMANCER_DEMO_NOW for screenshots).
// Run through the real estimator, it shows:
//  • 5-hour: pinned at ~70.4% (official 70), busy enough to run out ~40 min before the reset (A1)
//    but more than half an hour away from it (not A2);
//  • weekly: pinned at ~41.3%;
//  • Fable weekly: counted from the window start at ~33.5%, because this week's Fable use all
//    happened while VS Code was closed, so no Fable tick was ever watched;
//  • calibration learned over earlier sessions (last week and this week), dozens of samples each.

import { Ledger } from './ledger';
import { UsageEvent } from './logReader';
import { BucketEstimator, Reading } from './estimator';
import { TokenUsage, costParts, parseModel } from './pricing';
import { UsageResponse } from './usageApi';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;
const FIVE = 5 * HOUR;

type Mix = [model: string, share: number][];
const FABLE: Mix = [['claude-fable-5-1', 1]];
const MIXED: Mix = [['claude-fable-5-1', 0.6], ['claude-sonnet-5-5', 0.3], ['claude-haiku-5-5', 0.1]];
const WORK: Mix = [['claude-opus-5-5', 0.5], ['claude-sonnet-5-5', 0.4], ['claude-haiku-5-5', 0.1]];

/** A stretch of use. `ago` and `min` in minutes before now; `pace` divides the gaps between requests. */
interface Session { ago: number; min: number; mix: Mix; pace: number; watched: boolean; cont?: boolean }

const WEEK_AGO = (3 * 24 + 20) * 60 + 12;   // the weekly window opened 3d 20h 12m ago
const BURST = 15;                           // the last minutes run hotter: the 15-minute pace the estimator reports
const SESSIONS: Session[] = [
  { ago: 6 * 1440 + 240, min: 180, mix: MIXED, pace: 1.25, watched: true },   // last week, in VS Code
  { ago: 5 * 1440 + 120, min: 180, mix: MIXED, pace: 1.25, watched: true },
  { ago: WEEK_AGO - 30, min: 150, mix: FABLE, pace: 0.6, watched: false },    // this week: Fable in a terminal…
  { ago: 3 * 1440 + 120, min: 120, mix: WORK, pace: 1.5, watched: true },     // …everything else in VS Code
  { ago: 2 * 1440 + 1200, min: 180, mix: FABLE, pace: 0.6, watched: false },
  { ago: 1440 + 240, min: 150, mix: WORK, pace: 1.5, watched: true },
  { ago: 1320, min: 150, mix: FABLE, pace: 0.6, watched: false },
  { ago: 192, min: 40, mix: FABLE, pace: 0.5, watched: false },               // opens today's 5-hour window
  { ago: 152, min: 152 - BURST, mix: WORK, pace: 2, watched: true },
  { ago: BURST, min: BURST, mix: WORK, pace: 2.7, watched: true, cont: true },
];
const LIVE: Session = SESSIONS[SESSIONS.length - 1];

// Where each limit stands at `now`, and the 5-hour points of the last 15 minutes (31%/h).
const TARGET = { five: 70.42, burst: 7.75, week: 41.27, fable: 33.55 };
// How the simulated limit weighs token types relative to API prices (the estimator learns these).
const TRUE_FACTOR: Record<string, number> = { 'fable:read': 1.4, 'fable:out': 0.9, 'sonnet:read': 1.2, 'opus:out': 1.1 };
const PART = ['in', 'out', 'read'];

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

const iso = (t: number) => new Date(t).toISOString();

function eventOf(t: number, model: string, tokens: TokenUsage): UsageEvent {
  const parts = costParts(model, tokens);
  return { t, model, family: parseModel(model).family, wu: parts[0] + parts[1] + parts[2], parts, tokens, first: true };
}

/** The limit's own weighting of one event, in API-equivalent dollars. */
const trueCost = (e: UsageEvent) => e.parts.reduce((s, p, i) => s + p * (TRUE_FACTOR[`${e.family}:${PART[i]}`] ?? 1), 0);

/** The demo's clock: TOKENOMANCER_DEMO_NOW (ISO) when set, else the real time. */
export function demoNow(env: Record<string, string | undefined> = process.env): number {
  const t = Date.parse(env.TOKENOMANCER_DEMO_NOW ?? '');
  return isFinite(t) ? t : Date.now();
}

export class DemoSource {
  private r = rng(3577); // chosen so the estimator lands on the scenario above at `now`, not just near it
  private mode = 0;
  private all: UsageEvent[] = [];
  private pending: UsageEvent[] = [];
  private times: number[] = [];
  private cumAll: number[] = [0];           // true cost of all events before index i
  private cumFable: number[] = [0];
  private fives: { start: number; end: number }[] = [];
  private cost = { five: 1, week: 1, fable: 1 };   // true dollars per point of each limit
  private liveSize = 1;                     // request size of the last stretch, kept for live requests
  private replay: { t: number; ok: boolean }[] = [];
  private nextReq: number;
  private readonly weekStart: number;
  /** Polls of the last 8 hours, replayed and live, for the "between the whole numbers" rug. */
  readonly pollLog: { t: number; ok: boolean }[] = [];

  constructor(private readonly now: number = Date.now(), readonly scenario: 'default' = 'default') {
    this.weekStart = now - WEEK_AGO * MIN;
    let t = -Infinity, watchedFrom = 0;
    SESSIONS.forEach((s, i) => {
      const start = now - s.ago * MIN, end = Math.min(now, start + s.min * MIN);
      t = s.cont ? Math.max(t, start) : start;
      if (!s.cont) watchedFrom = start;
      for (; t < end; t = this.after(t, s)) this.all.push(this.request(t, s));
      if (s.watched && !SESSIONS[i + 1]?.cont) this.schedulePolls(watchedFrom, s === LIVE ? now : end + 5 * MIN);
    });
    this.nextReq = t;
    this.calibrateTruth();
    for (const e of this.all) this.index(e);
  }

  /** Loads past events and replays the readings an open VS Code would have seen, oldest first. */
  bootstrap(ledger: Ledger, estimators: Map<string, BucketEstimator>,
    onReading?: (t: number, buckets: Record<string, { utilization: number; resets_at: string | null }>) => void) {
    ledger.add([...this.all]);
    this.pending = [];
    for (const p of this.replay) {
      this.logPoll(p.t, p.ok);
      if (!p.ok) continue;
      const raw: Record<string, { utilization: number; resets_at: string | null }> = {};
      for (const [k, rd] of this.readingsAt(p.t)) {
        let est = estimators.get(k);
        if (!est) { est = new BucketEstimator(k); estimators.set(k, est); }
        est.onReading(rd, p.t, ledger);
        raw[k] = { utilization: rd.utilization, resets_at: rd.resetsAt ?? null };
      }
      onReading?.(p.t, raw);
    }
  }

  /** New requests since the last call, as if Claude Code had just logged them. */
  scan(now = Date.now()): UsageEvent[] {
    this.generate(now);
    const out = this.pending;
    this.pending = [];
    return out;
  }

  async fetch(now = Date.now()): Promise<UsageResponse> {
    this.generate(now); // the reading counts everything sent before it; the next scan() returns those events
    const buckets = this.readingsAt(now);
    const raw: Record<string, unknown> = {};
    for (const [k, rd] of buckets) raw[k] = { utilization: rd.utilization, resets_at: rd.resetsAt };
    raw.seven_day_opus = null;
    raw.extra_usage = { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null };
    this.logPoll(now, true);
    return { buckets, raw };
  }

  // ── the script ──

  private request(t: number, s: Session, k = 1): UsageEvent {
    const r = this.r;
    if (r() < 0.04) this.mode = Math.floor(r() * 3);
    let x = r(), model = s.mix[0][0];
    for (const [m, p] of s.mix) { if (x < p) { model = m; break; } x -= p; }
    return eventOf(t, model, {
      input: Math.round((20 + r() * 400) * k),
      output: Math.round((this.mode === 1 ? 1800 : this.mode === 0 ? 350 : 900) * (0.3 + r() * 1.4) * k),
      cacheWrite5m: Math.round((r() < 0.15 ? 8000 + r() * 30000 : r() * 3000) * k),
      cacheWrite1h: 0,
      cacheRead: Math.round((this.mode === 0 ? 110_000 : 60_000) * (0.4 + r()) * k),
    });
  }

  /** The next request time: a few seconds to ~40 s, with an occasional break. */
  private after(t: number, s: Session): number {
    const r = this.r;
    return Math.round(t + (r() < 0.06 ? 90_000 + r() * 420_000 : 6000 + r() * 34_000) / s.pace);
  }

  private schedulePolls(from: number, to: number) {
    // Today's polls fall on whole minutes before now, so a live poll at now continues the cadence.
    const first = to - Math.floor((to - from - MIN) / MIN) * MIN;
    for (let t = first; t < to; t += MIN) this.replay.push({ t, ok: t !== this.now - 47 * MIN }); // one network blip today
  }

  /**
   * Scales the truth so that the limits stand at their targets at `now`: the last minutes'
   * requests (and later live ones) are resized to give the burst pace, then each limit's
   * cost per point is solved.
   */
  private calibrateTruth() {
    const now = this.now, five = now - 192 * MIN, burst = now - BURST * MIN;
    const sum = (from: number, to: number, fable = false) => this.all
      .filter(e => e.t >= from && e.t < to && (!fable || e.family === 'fable')).reduce((s, e) => s + trueCost(e), 0);
    const k = this.liveSize = (TARGET.burst / (TARGET.five - TARGET.burst)) * sum(five, burst) / sum(burst, now);
    this.all = this.all.map(e => e.t < burst ? e : eventOf(e.t, e.model, {
      input: Math.round(e.tokens.input * k), output: Math.round(e.tokens.output * k),
      cacheWrite5m: Math.round(e.tokens.cacheWrite5m * k), cacheWrite1h: 0, cacheRead: Math.round(e.tokens.cacheRead * k),
    }));
    this.cost = {
      five: sum(five, now) / TARGET.five,
      week: sum(this.weekStart, now) / TARGET.week,
      fable: sum(this.weekStart, now, true) / TARGET.fable,
    };
  }

  /** Appends an event to the running sums, and opens a 5-hour window at the first request after the last one ended. */
  private index(e: UsageEvent) {
    this.times.push(e.t);
    this.cumAll.push(this.cumAll[this.cumAll.length - 1] + trueCost(e));
    this.cumFable.push(this.cumFable[this.cumFable.length - 1] + (e.family === 'fable' ? trueCost(e) : 0));
    const w = this.fives[this.fives.length - 1];
    if (!w || e.t >= w.end) this.fives.push({ start: e.t, end: e.t + FIVE });
  }

  /** Live requests up to `to`, at the last stretch's pace. At the 5-hour limit, the user waits for the reset. */
  private generate(to: number) {
    let t = this.nextReq;
    while (t < to) {
      const w = this.fiveAt(t);
      if (w && this.points(this.cumAll, w.start, t) / this.cost.five >= 100) { t = w.end + 2 * MIN; continue; }
      const e = this.request(t, LIVE, this.liveSize);
      this.all.push(e);
      this.pending.push(e);
      this.index(e);
      t = this.after(t, LIVE);
    }
    this.nextReq = t;
  }

  private readingsAt(t: number): Map<string, Reading> {
    const at = (cost: number, end: number): Reading => ({ utilization: Math.min(100, Math.floor(cost)), resetsAt: iso(end) });
    const m = new Map<string, Reading>();
    const w = this.fiveAt(t);
    m.set('five_hour', w ? at(this.points(this.cumAll, w.start, t) / this.cost.five, w.end) : { utilization: 0, resetsAt: null });
    const ws = this.weekStart + Math.floor((t - this.weekStart) / WEEK) * WEEK;
    m.set('seven_day', at(this.points(this.cumAll, ws, t) / this.cost.week, ws + WEEK));
    m.set('seven_day_fable', at(this.points(this.cumFable, ws, t) / this.cost.fable, ws + WEEK));
    return m;
  }

  /** The 5-hour window holding t, if one is open. */
  private fiveAt(t: number) {
    for (let i = this.fives.length - 1; i >= 0; i--) {
      if (this.fives[i].start <= t) return t < this.fives[i].end ? this.fives[i] : undefined;
    }
    return undefined;
  }

  /** True cost of the events in [from, to). */
  private points(cum: number[], from: number, to: number): number {
    return cum[this.lowerBound(to)] - cum[this.lowerBound(from)];
  }

  private lowerBound(t: number): number {
    let lo = 0, hi = this.times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.times[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  private logPoll(t: number, ok: boolean) {
    const L = this.pollLog;
    L.push({ t, ok });
    let drop = 0;
    while (drop < L.length && (L[drop].t < t - 8 * HOUR || L.length - drop > 1000)) drop++;
    if (drop) L.splice(0, drop);
  }
}
