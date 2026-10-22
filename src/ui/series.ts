// The dashboard's numbers for one limit (DetailVM): the whole window, the zoom "between the whole
// numbers", and where the window's points went. Numbers only; the webview formats them.
// Built from the estimator's public API, the ledger and the recorded history. Pure: no vscode, no Node.

import { windowLengthMs } from '../estimator';
import type { BucketEstimator, Estimate } from '../estimator';
import type { Ledger } from '../ledger';
import type { UsageEvent } from '../logReader';
import type { PointsIndex } from './points';
import type { DetailVM, Family, HistoryPoint, Lane, MixVM, Series, WindowSeries, ZoomSeries } from './types';

const MIN = 60_000, HOUR = 3_600_000;
const WINDOW_POINTS = 400, ZOOM_POINTS = 240, MAX_LANES = 6;
const SPANS = [30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR];
const EDGE_EPS = 0.006;      // the estimator widens every bound by 0.005: don't open a lane for that
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export interface DetailInput {
  key: string;
  est: BucketEstimator;
  e: Estimate;                              // est.estimate(now), unmodified
  idx: PointsIndex;                         // this bucket's index (updated here)
  ledger: Ledger;
  history: HistoryPoint[];                  // EstimateHistory.points(key, windowStart, now)
  polls: { t: number; ok: boolean }[];      // the poll log, any order
  rounding: 'floor' | 'round';
  now: number;
}

interface Run { from: number; to: number; v: number }   // consecutive readings of one official value
interface Tick { from: number; to: number; edge: number }

interface Frame {
  from: number; to: number;                 // the window (or the last window-length when its reset is unknown or past)
  live: boolean;                            // the window is current, so the estimate describes it
  off: number; width: number;               // a reading v means [v + off, v + off + width)
  runs: Run[];
  ticks: Tick[];                            // every crossed edge, oldest first
}

export function buildDetail(a: DetailInput): DetailVM {
  a.idx.update(a.ledger);
  const f = frameOf(a);
  return { key: a.key, window: windowSeries(a, f), zoom: zoomSeries(a, f), mix: mixOf(a, f) };
}

function frameOf(a: DetailInput): Frame {
  const len = windowLengthMs(a.key) ?? 5 * HOUR;
  const R = a.e.resetsAt ? Date.parse(a.e.resetsAt) : NaN;
  const live = isFinite(R) && R > a.now;
  const from = live ? R - len : a.now - len, to = live ? R : a.now;
  const st = a.est.toJSON();
  const off = st.precise ? 0 : a.rounding === 'round' ? -0.5 : 0, width = st.precise ? 0 : 1;

  const runs: Run[] = [];
  for (const r of (st.readings ?? []).slice()) {      // toJSON() hands out the live array
    if (!(r.t >= from && r.t <= a.now) || !isFinite(r.v)) continue;
    const last = runs[runs.length - 1];
    if (last && last.v === r.v) last.to = r.t;
    else runs.push({ from: r.t, to: r.t, v: r.v });
  }
  // A tick is the interval between the last reading of one run and the first of the next;
  // each whole-number edge crossed in it is one tick (a jump of 3 crosses three).
  const ticks: Tick[] = [];
  for (let j = 1; j < runs.length; j++) {
    const p = runs[j - 1], q = runs[j];
    for (let k = Math.floor(p.v + 1e-9) + 1; k <= Math.floor(q.v + 1e-9); k++) ticks.push({ from: p.to, to: q.from, edge: k + off });
  }
  return { from, to, live, off, width, runs, ticks };
}

function laneOf(r: Run, f: Frame, from = r.from): Lane {
  return { from: Math.max(from, r.from), to: r.to, lo: clamp(r.v + f.off, 0, 100), hi: clamp(r.v + f.off + f.width, 0, 100) };
}

/** The estimate is drawn only for a live, calibrated window. */
const drawable = (a: DetailInput, f: Frame) => f.live && a.idx.calibrated && a.e.kind !== 'official';

// ───────────────────────────── the whole window ─────────────────────────────

function windowSeries(a: DetailInput, f: Frame): WindowSeries {
  const calibrated = drawable(a, f);
  return {
    from: f.from, to: f.to, now: a.now,
    lanes: f.runs.map(r => laneOf(r, f)),
    est: calibrated ? reconstruct(a, f.from, Math.min(a.now, f.to)) : { t: [], v: [], s: [] },
    calibrated,
  };
}

/**
 * est(t) = value − points used since t, with σ(t) = σ + spread · points since t: the local
 * reconstruction anchored at now. The curve is monotone, so evenly spaced samples lose no extremes.
 */
function reconstruct(a: DetailInput, t0: number, t1: number): Series {
  const out: Series = { t: [], v: [], s: [] };
  const sigma = a.e.sigma ?? 0, spread = a.e.spread ?? 0;
  const n = t1 > t0 ? Math.min(WINDOW_POINTS, Math.max(2, Math.ceil((t1 - t0) / 15_000) + 1)) : 1;
  for (let i = 0; i < n; i++) {
    const t = i === n - 1 ? t1 : Math.round(t0 + ((t1 - t0) * i) / (n - 1));
    const q = a.idx.since(t, a.now);
    out.t.push(t);
    out.v.push(Math.max(0, a.e.value - q));
    out.s.push(sigma + spread * q);
  }
  return out;
}

// ───────────────────────────── between the whole numbers ─────────────────────────────

function zoomSeries(a: DetailInput, f: Frame): ZoomSeries {
  const now = a.now, off = f.off;
  const up = (x: number) => off + Math.ceil(x - off - EDGE_EPS);
  const down = (x: number) => off + Math.floor(x - off + EDGE_EPS);
  const lowest = off, highest = 100 - off;   // round mode's brackets run from [-0.5, 0.5) to [99.5, 100.5)

  // Span: back to the start of the second-most-recent tick interval, 30 min – 6 h, snapped up.
  const starts = [...new Set(f.ticks.map(k => k.from))];
  const ref = starts.length ? starts[Math.max(0, starts.length - 2)] : now - SPANS[SPANS.length - 1];
  const want = clamp(now - ref, SPANS[0], SPANS[SPANS.length - 1]);
  let from = Math.max(f.from, now - (SPANS.find(s => s >= want) ?? want));

  let hist = recorded(a, f, from);
  const lanes = f.runs.filter(r => r.to >= from).map(r => laneOf(r, f, from));

  // y: whole lanes around everything shown, ±2σ clipped to the proven bounds, up to the next edge.
  const lows: number[] = [], highs: number[] = [];
  for (const p of hist) {
    lows.push(p.flat ? p.lo : Math.max(p.v - 2 * p.s, p.lo));
    highs.push(p.flat ? p.hi : Math.min(p.v + 2 * p.s, p.hi));
  }
  for (const l of lanes) { lows.push(l.lo); highs.push(l.hi); }
  const top = hist.length ? hist[hist.length - 1].v : lanes.length ? lanes[lanes.length - 1].lo : a.e.value;
  highs.push(down(top) + 1);
  const yMax = clamp(up(Math.max(...highs)), lowest + 1, highest);
  let yMin = clamp(down(Math.min(...lows, yMax - 1)), lowest, yMax - 1);
  if (yMax - yMin > MAX_LANES) {
    // Fast use: the span covers more lanes than fit. Show the newest six and start where the
    // estimate entered them (the tick into the bottom lane), so the chart isn't half empty.
    yMin = yMax - MAX_LANES;
    const ticks = f.ticks.filter(k => k.edge <= yMin + 1e-9).map(k => k.from);
    const below = ticks.length ? ticks : hist.filter(p => p.v < yMin).map(p => p.t);
    if (below.length) {
      from = Math.max(from, now - Math.ceil((now - Math.max(...below)) / MIN) * MIN);
      hist = recorded(a, f, from);
    }
  }
  const inY = (v: number) => v >= yMin - 1e-9 && v <= yMax + 1e-9;
  const laneInY = (l: Lane) => (l.lo === l.hi ? inY(l.lo) : l.hi > yMin + 1e-9 && l.lo < yMax - 1e-9);

  const edges: number[] = [];
  for (let x = yMin; x <= yMax + 1e-9; x++) edges.push(Math.round(x * 2) / 2);
  const shown = thin(hist.filter(p => inY(p.v)), from, now);
  const okT: number[] = [], failed: number[] = [];
  for (const p of a.polls) if (p.t >= from && p.t <= now) (p.ok ? okT : failed).push(p.t);
  for (const r of f.runs) okT.push(r.from, r.to);   // readings the estimator kept are successful polls too

  return {
    from, to: now, yMin, yMax, edges,
    lanes: lanes.filter(l => l.to >= from && laneInY(l)).map(l => ({ ...l, from: Math.max(from, l.from) })),
    // Clipped to the span: the charts draw in data coordinates without a clip path.
    ticks: f.ticks.filter(k => k.to > from && k.from <= now && inY(k.edge)).map(k => ({ ...k, from: Math.max(from, k.from) })),
    polls: dedupe(okT.filter(t => t >= from && t <= now)),
    failed: dedupe(failed),
    hist: {
      t: shown.map(p => p.t), v: shown.map(p => p.v), s: shown.map(p => p.s),
      lo: shown.map(p => p.lo), hi: shown.map(p => p.hi), flat: shown.map(p => p.flat),
    },
  };
}

interface Rec { t: number; v: number; s: number; lo: number; hi: number; flat: boolean }

/**
 * Recorded estimates in this window from `from` on, plus the current one at now. Readings-only
 * points (calibrating) are left out: there was no estimate to draw. The last point before `from`
 * is carried forward to it, so the line starts at the left edge.
 */
function recorded(a: DetailInput, f: Frame, from: number): Rec[] {
  const rec = (t: number, p: Pick<HistoryPoint, 'v' | 's' | 'lo' | 'hi' | 'kind'>): Rec => ({
    t, v: p.v, s: p.s, lo: p.lo ?? p.v - 2 * p.s, hi: p.hi ?? p.v + 2 * p.s, flat: p.kind === 'lower-bound',
  });
  const out: Rec[] = [];
  let before: HistoryPoint | undefined;
  for (const p of a.history) {
    if (p.kind === 'official' || !(p.t >= f.from && p.t < a.now) || !isFinite(p.v)) continue;
    if (p.t < from) { if (!before || p.t >= before.t) before = p; continue; }
    out.push(rec(p.t, p));
  }
  out.sort((x, y) => x.t - y.t);
  if (before && (!out.length || out[0].t > from)) out.unshift(rec(from, before));
  if (drawable(a, f)) out.push(rec(a.now, { v: a.e.value, s: a.e.sigma ?? 0, lo: a.e.lo, hi: a.e.hi, kind: a.e.kind }));
  return out;
}

/** At most ZOOM_POINTS: the first point, then the newest point in each time bin. */
function thin(pts: Rec[], from: number, to: number): Rec[] {
  if (pts.length <= ZOOM_POINTS) return pts;
  const w = Math.max(1, (to - from) / (ZOOM_POINTS - 2));   // bins 0 … ZOOM_POINTS − 2, plus the first point
  const out = [pts[0]];
  let bin = -1;
  for (let i = 1; i < pts.length; i++) {
    const b = Math.floor((pts[i].t - from) / w);
    if (b === bin) out[out.length - 1] = pts[i];
    else { out.push(pts[i]); bin = b; }
  }
  return out;
}

/** Sorted, with polls within 2 s of the previous one dropped (a reading and its log entry). */
function dedupe(ts: number[]): number[] {
  const out: number[] = [];
  for (const t of [...ts].sort((x, y) => x - y)) if (!out.length || t - out[out.length - 1] > 2000) out.push(t);
  return out;
}

// ───────────────────────────── where it went ─────────────────────────────

const PART_NAMES = ['in', 'out', 'read'] as const;

function mixOf(a: DetailInput, f: Frame): MixVM {
  const from = f.from, to = Math.min(a.now, f.to);
  const pts = a.idx.calibrated;
  // Dollars per family and part in one pass; points follow per family, as points are linear in each part.
  const fam = new Map<Family, { usd: number; parts: [number, number, number]; requests: number }>();
  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let usd = 0;
  a.ledger.forEach(from, to, e => {
    let row = fam.get(e.family);
    if (!row) fam.set(e.family, row = { usd: 0, parts: [0, 0, 0], requests: 0 });
    for (let i = 0; i < 3; i++) if (e.parts[i] > 0) row.parts[i] += e.parts[i];
    row.usd += e.wu;
    if (e.first !== false) row.requests++;
    tokens.input += e.tokens.input;
    tokens.output += e.tokens.output;
    tokens.cacheWrite += e.tokens.cacheWrite5m + e.tokens.cacheWrite1h;
    tokens.cacheRead += e.tokens.cacheRead;
    usd += e.wu;
  }, a.est.filter);
  const pv = [0, 0, 0], pu = [0, 0, 0];
  const byFamily = [...fam].map(([family, r]) => {
    const p = pts ? a.idx.partsOf({ family, parts: r.parts } as UsageEvent) : r.parts;
    for (let i = 0; i < 3; i++) { pv[i] += p[i]; pu[i] += r.parts[i]; }
    return { family, value: p[0] + p[1] + p[2], usd: r.usd, requests: r.requests };
  });
  const mix: MixVM = {
    unit: pts ? 'pts' : 'usd',
    from, to,
    byFamily: byFamily.filter(r => r.value > 0 || r.usd > 0).sort((x, y) => y.value - x.value || y.usd - x.usd),
    byPart: PART_NAMES.map((part, i) => ({ part, value: pv[i], usd: pu[i] })),
    tokens,
    requests: a.ledger.requests(from, to, a.est.filter),
    usd,
  };
  const wpp = a.est.wuPerPct;
  if (wpp !== undefined) mix.wuPerPct = wpp;
  return mix;
}
