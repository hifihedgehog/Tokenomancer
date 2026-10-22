// Turns coarse official utilization readings plus exact local token usage
// into a fine-grained estimate.
//
// Method (per limit bucket):
//  1. Calibrate. Between two ticks of the official number, the requests logged
//     locally cost N points. Each crossing lies somewhere in its poll interval,
//     so half of each end interval is counted (no model assumptions, so the
//     calibration can't just confirm itself). From many intervals we learn what
//     1% costs and a correction factor per model and token type (fresh input,
//     output, cache reads), starting from Anthropic's API price ratios.
//  2. Bound. Every official reading says "at that moment you were between N
//     and N+1". Pushed forward by the predicted cost of every request since,
//     each reading bounds where you are now. The reading just before a tick and
//     the one just after it pin the value tightly; intersecting all of them
//     gives the range.
//  3. Estimate. Within that range, the predicted total since the window began
//     is the point estimate (or the middle of the range if usage happened
//     elsewhere).

import { ALL, FamilyFilter, Ledger } from './ledger';
import { UsageEvent } from './logReader';
import { Family } from './pricing';

export type Rounding = 'floor' | 'round';

export interface Reading {
  utilization: number; // 0-100
  resetsAt?: string | null;
}

/** One calibration interval: API-price cost per feature, and the points it moved. */
export interface Sample { z: Record<string, number>; d: number; e?: number } // e: 1σ error of d from locating its two ends

export interface BucketPersist {
  samples: Sample[];
  lastOfficial?: number;
  lastPollAt?: number;
  resetsAt?: string | null;
  readings?: { t: number; v: number }[];
  calStart?: { pct: number; t: number; iFrom?: number; iTo?: number }; // iFrom..iTo: poll interval holding the crossing
  precise?: boolean;
}

export type EstimateKind =
  | 'official'      // no calibration yet: official number only
  | 'precise'       // the endpoint itself returned decimals
  | 'anchored'      // pinned between recent ticks (best)
  | 'window-start'  // interpolated from the start of the window (no tick seen yet)
  | 'lower-bound';  // usage elsewhere moved the number; only loosely bounded

export interface Estimate {
  key: string;
  official: number;
  value: number;
  kind: EstimateKind;
  sigma?: number;       // 1-sigma uncertainty, in points
  wuPerPct?: number;
  samples: number;
  spread?: number;      // relative error of the fitted model on past intervals
  ratePctPerHour?: number;
  minutesToNextPct?: number;
  minutesTo100?: number;
  resetsAt?: string | null;
  windowStart?: number;
  lo?: number;          // proven bounds on the current value, in points (set once calibrated)
  hi?: number;
  unseen?: boolean;     // the official number jumped past what local usage explains
}

const MAX_SAMPLES = 60;
const MAX_READINGS = 600;
const MAX_GAP_UNCALIBRATED_MS = 5 * 60_000;
const MAX_GAP_CALIBRATED_MS = 30 * 60_000;
const DRIFT_LOW = 0.4;     // interval predicted < 40% of what moved => usage happened elsewhere
const RIDGE = 0.2;         // pull toward API price ratios (small: data wins once it exists)
const PARTS = ['in', 'out', 'read'] as const;

export function windowLengthMs(key: string): number | undefined {
  if (key.startsWith('five_hour')) return 5 * 3600_000;
  if (key.startsWith('seven_day')) return 7 * 24 * 3600_000;
  return undefined;
}

export function filterForKey(key: string): FamilyFilter {
  const k = key.toLowerCase();
  const fams: Family[] = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];
  const hit = fams.find(f => k.includes(f));
  return hit ? (f: Family) => f === hit : ALL;
}

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const isInt = (x: number) => Math.abs(x - Math.round(x)) < 1e-6;
const sumZ = (z: Record<string, number>) => Object.values(z).reduce((a, b) => a + b, 0);

function featuresOf(evs: UsageEvent[]): Record<string, number> {
  const z: Record<string, number> = {};
  for (const e of evs) {
    for (let i = 0; i < 3; i++) {
      if (e.parts[i] > 0) {
        const k = `${e.family}:${PARTS[i]}`;
        z[k] = (z[k] ?? 0) + e.parts[i];
      }
    }
  }
  return z;
}

/** Solves A x = b for a small dense system (Gaussian elimination, partial pivoting). */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Standard normal pdf/cdf (Abramowitz–Stegun erf approximation, |err| < 1.5e-7).
const phi = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
function Phi(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Mean and sd of N(mu, sd²) restricted to [a, b]. */
export function truncNormal(mu: number, sd: number, a: number, b: number): { mean: number; sd: number } {
  if (b - a < 1e-9) return { mean: a, sd: 0 };
  const al = (a - mu) / sd, be = (b - mu) / sd;
  const Z = Phi(be) - Phi(al);
  if (Z < 1e-9) return { mean: mu < a ? a : b, sd: Math.min(sd, (b - a) / Math.sqrt(12)) }; // guess far outside: nearest bound
  const pa = phi(al), pb = phi(be);
  const mean = mu + sd * (pa - pb) / Z;
  const ea = isFinite(al) ? al * pa : 0, eb = isFinite(be) ? be * pb : 0;
  const v = sd * sd * (1 + (ea - eb) / Z - ((pa - pb) / Z) ** 2);
  return { mean: Math.min(b, Math.max(a, mean)), sd: Math.sqrt(Math.max(0, v)) };
}

export class BucketEstimator {
  readonly filter: FamilyFilter;
  private st: BucketPersist;
  private model?: { wpp: number; g: Record<string, number>; relErr: number; sysErr: number };

  constructor(readonly key: string, persisted?: BucketPersist) {
    this.filter = filterForKey(key);
    const ok = Array.isArray(persisted?.samples) && persisted!.samples.every(s => typeof s === 'object' && s && 'z' in s);
    this.st = persisted && ok ? { ...persisted, samples: persisted.samples.map(s => ({ z: { ...s.z }, d: s.d, e: s.e })) } : { samples: [] };
  }

  toJSON(): BucketPersist { return { ...this.st, samples: this.st.samples.map(s => ({ z: { ...s.z }, d: s.d, e: s.e })) }; }

  resetCalibration() { this.st.samples = []; this.model = undefined; }

  get sampleCount() { return this.st.samples.length; }

  /** API-equivalent dollars per 1% (before learned corrections). */
  get wuPerPct(): number | undefined { return this.fit()?.wpp; }

  /** Learned correction factor for a feature such as "fable:read" (1 = API price ratio). */
  factor(feature: string): number { return this.fit()?.g[feature] ?? 1; }

  /** Learned correction factors, e.g. [["fable:read", 1.8], ...]. */
  features(): [string, number][] { return Object.entries(this.fit()?.g ?? {}).sort(); }

  private fit() {
    if (this.model) return this.model;
    const S = this.st.samples;
    if (!S.length) return undefined;
    // Weight each interval by how precisely its ends were located (plus a floor for model noise).
    const wt = S.map(smp => 1 / ((smp.e ?? 0.05) ** 2 + 0.02 ** 2));
    const good = S.filter((_, i) => wt[i] >= 0.5 * Math.max(...wt));
    const wpp = median((good.length >= 3 ? good : S).map(smp => sumZ(smp.z) / smp.d))!;
    // Ridge regression for multiplicative corrections g_k:
    //   d_i ≈ Σ_k (z_ik / wpp) g_k,  penalising λ Σ_k (g_k − s)²  with a free common scale s.
    // Factors with little data follow the shared scale instead of staying at API prices.
    const keys = [...new Set(S.flatMap(s => Object.keys(s.z)))].sort();
    const n = keys.length;
    const N = n + 1; // unknowns: g_0..g_{n-1}, s
    const A = Array.from({ length: N }, () => new Array(N).fill(0));
    const b = new Array(N).fill(0);
    const wMean = wt.reduce((a, b) => a + b, 0) / wt.length;
    S.forEach((smp, i) => {
      const w = wt[i] / wMean;
      const a = keys.map(k => (smp.z[k] ?? 0) / wpp);
      for (let j = 0; j < n; j++) {
        b[j] += w * a[j] * smp.d;
        for (let k = 0; k < n; k++) A[j][k] += w * a[j] * a[k];
      }
    });
    for (let j = 0; j < n; j++) { A[j][j] += RIDGE; A[j][n] -= RIDGE; A[n][j] -= RIDGE; A[n][n] += RIDGE; }
    A[n][n] += 1e-6; b[n] += 1e-6; // tiny anchor of s to 1 keeps the system well-posed
    const sol = solve(A, b);
    const x = sol ? sol.slice(0, n) : keys.map(() => 1);
    const g: Record<string, number> = {};
    keys.forEach((k, i) => { g[k] = Math.min(5, Math.max(0.2, isFinite(x[i]) ? x[i] : 1)); });
    // In-sample relative error, inflated for the number of fitted factors.
    const rel = S.map(smp => (this.predictZ(smp.z, wpp, g) - smp.d) / smp.d);
    const dof = Math.max(1, S.length - Math.min(n, S.length - 1));
    const wSum = wt.reduce((a, b) => a + b, 0);
    const relErr = Math.sqrt((rel.reduce((a, r, i) => a + wt[i] * r * r, 0) / wSum) * (S.length / dof));
    // Part of that is just not knowing where in its poll interval each tick happened;
    // what's left is the model's systematic error, which is what accumulates over time.
    const locVar = S.reduce((a, smp, i) => a + wt[i] * ((smp.e ?? 0) / smp.d) ** 2, 0) / wSum;
    // Plus uncertainty in the fitted factors themselves (~ relErr·√(params/samples)).
    const nEff = wSum * wSum / wt.reduce((a, w) => a + w * w, 0);
    const paramVar = relErr * relErr * Math.min(1, (n + 1) / Math.max(1, nEff));
    const sysErr = Math.max(0.01, Math.sqrt(Math.max(0, relErr * relErr - locVar) + paramVar));
    this.model = { wpp, g, relErr, sysErr };
    return this.model;
  }

  private predictZ(z: Record<string, number>, wpp: number, g: Record<string, number>) {
    let p = 0;
    for (const [k, v] of Object.entries(z)) p += (v / wpp) * (g[k] ?? 1);
    return p;
  }

  private addIntervalSample(ledger: Ledger, aFrom: number, aTo: number, bFrom: number, bTo: number, d: number) {
    const za = featuresOf(ledger.eventsIn(aFrom, aTo, this.filter));
    const zm = featuresOf(ledger.eventsIn(aTo, bFrom, this.filter));
    const zb = featuresOf(ledger.eventsIn(bFrom, bTo, this.filter));
    const z: Record<string, number> = { ...zm };
    for (const [k, v] of Object.entries(za)) z[k] = (z[k] ?? 0) + v / 2;
    for (const [k, v] of Object.entries(zb)) z[k] = (z[k] ?? 0) + v / 2;
    if (!(sumZ(z) > 0) || !(d > 0)) return; // all usage was elsewhere
    // Each crossing sits uniformly somewhere in its poll interval: σ = width/√12 per end.
    const m = this.fit();
    const scale = m?.wpp ?? sumZ(z) / d;
    const e = Math.max(0.001, Math.hypot(sumZ(za), sumZ(zb)) / Math.sqrt(12) / scale);
    if (m && this.st.samples.length >= 3 && this.predictZ(z, m.wpp, m.g) < d * DRIFT_LOW) return; // unseen usage
    this.st.samples.push({ z, d, e });
    if (this.st.samples.length > MAX_SAMPLES) this.st.samples.shift();
    this.model = undefined;
  }

  /** Keep only the first and last reading of each run of equal values: those carry all the information. */
  private remember(t: number, v: number) {
    const R = (this.st.readings ??= []);
    const n = R.length;
    if (n >= 2 && R[n - 1].v === v && R[n - 2].v === v) R[n - 1] = { t, v };
    else R.push({ t, v });
    if (R.length > MAX_READINGS) R.splice(0, R.length - MAX_READINGS);
  }

  /** Feed one official reading. */
  onReading(r: Reading, now: number, ledger: Ledger, rounding: Rounding = 'floor') {
    const v = r.utilization;
    const st = this.st;
    if (!isInt(v)) st.precise = true;
    const shift = !st.precise && rounding === 'round' ? -0.5 : 0; // a tick to N means crossing N-0.5

    const prev = st.lastOfficial;
    const prevAt = st.lastPollAt;
    const resetChanged = !!(st.resetsAt && r.resetsAt && Math.abs(Date.parse(st.resetsAt) - Date.parse(r.resetsAt)) > 60_000);

    if (prev === undefined || prevAt === undefined || resetChanged || v < prev - 0.5) {
      // First reading, or a new window: calibration stays, readings don't.
      st.readings = [];
      st.calStart = undefined;
      if (st.precise) st.calStart = { pct: v, t: now, iFrom: now, iTo: now };
    } else if (st.precise) {
      if (st.calStart && v - st.calStart.pct >= 1 - 1e-9) {
        this.addIntervalSample(ledger, st.calStart.t, st.calStart.t, now, now, v - st.calStart.pct);
        st.calStart = { pct: v, t: now, iFrom: now, iTo: now };
      } else if (!st.calStart) st.calStart = { pct: v, t: now, iFrom: now, iTo: now };
    } else if (v > prev + 1e-9) {
      const target = v + shift;
      const gap = now - prevAt;
      const maxGap = this.fit() ? MAX_GAP_CALIBRATED_MS : MAX_GAP_UNCALIBRATED_MS;
      const local = ledger.eventsIn(prevAt, now, this.filter).length > 0;
      if (!local || gap > maxGap) {
        st.calStart = undefined; // moved by usage elsewhere, or we weren't watching
      } else {
        // Calibration never uses the model to place crossings (that would only confirm the model).
        if (st.calStart?.iFrom !== undefined) this.addIntervalSample(ledger, st.calStart.iFrom, st.calStart.iTo!, prevAt, now, target - st.calStart.pct);
        st.calStart = { pct: target, t: now, iFrom: prevAt, iTo: now };
      }
    }

    this.remember(now, v);
    st.lastOfficial = v;
    st.lastPollAt = now;
    st.resetsAt = r.resetsAt ?? st.resetsAt;
  }

  estimate(now: number, ledger: Ledger, rounding: Rounding = 'floor'): Estimate {
    const st = this.st;
    const official = st.lastOfficial ?? 0;
    const m = this.fit();
    const len = windowLengthMs(this.key);
    const windowStart = len && st.resetsAt ? Date.parse(st.resetsAt) - len : undefined;
    const base: Estimate = {
      key: this.key, official, value: official, kind: st.precise ? 'precise' : 'official',
      samples: st.samples.length, resetsAt: st.resetsAt, windowStart,
    };
    if (m) { base.wuPerPct = m.wpp; base.spread = m.sysErr; }
    const R = st.readings ?? [];
    if (!m || !R.length) return base;

    // Predicted points for every request from the earliest useful time up to now,
    // so that "points since time t" is a lookup.
    const from = Math.min(R[0].t, windowStart ?? Infinity);
    const evs = ledger.eventsIn(from, now, this.filter);
    const times = evs.map(e => e.t);
    const cum: number[] = [0];
    for (const e of evs) cum.push(cum[cum.length - 1] + this.predictZ(featuresOf([e]), m.wpp, m.g));
    const total = cum[cum.length - 1];
    const sinceT = (t: number) => { // points from t to now
      let lo = 0, hi = times.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
      return total - cum[lo];
    };

    // Each reading says: at its time we were in [v, v+1) (floor) / [v-.5, v+.5) (round) / exactly v.
    // Pushed forward by the predicted points since, each bounds where we are now.
    // Intersect them, newest information winning when they disagree.
    const width = st.precise ? 0 : 1;
    const off = st.precise ? 0 : rounding === 'round' ? -0.5 : 0;
    let L = -Infinity, U = Infinity, unseen = false;
    for (const rd of R) {
      const q = sinceT(rd.t);
      const tol = m.sysErr * q + 0.005;
      const lo = rd.v + off + q - tol;
      const hi = rd.v + off + width + q + tol;
      if (lo > U) { L = lo; U = hi; unseen = true; }   // jumped past what local usage explains
      else if (hi < L) { L = lo; U = hi; }              // local usage over-predicted; trust newer
      else { L = Math.max(L, lo); U = Math.min(U, hi); }
    }
    // Never below what the latest official number allows.
    const floorNow = official + off;
    L = Math.max(L, floorNow);
    if (U < L) U = L;
    base.lo = L; base.hi = U; base.unseen = unseen;

    // Inside the bounds, the count from the window start is the best point estimate when it fits.
    const ws = windowStart !== undefined && windowStart <= R[0].t ? sinceT(windowStart) : undefined;
    let value: number, kind: EstimateKind, sigma: number;
    const w = U - L;
    if (st.precise) {
      value = (L + U) / 2; kind = 'precise'; sigma = w / 2;
    } else if (!unseen && ws !== undefined) {
      // Window-start count as a normal guess, restricted to the proven bounds.
      const sd = m.sysErr * ws + 0.01;
      const t = truncNormal(ws, sd, L, U);
      value = t.mean;
      kind = w < 0.75 ? 'anchored' : 'window-start';
      sigma = t.sd;
    } else {
      value = (L + U) / 2;
      kind = w < 0.75 ? 'anchored' : 'lower-bound';
      sigma = w / Math.sqrt(12);
      if (kind === 'lower-bound') value = L + Math.min(w, 1) * 0.5;
    }
    base.value = value;
    base.kind = kind;
    base.sigma = Math.max(sigma, 0.001);

    // Pace over the last 15 minutes.
    const winMs = 15 * 60_000;
    const rate = sinceT(now - winMs) * (3600_000 / winMs);
    base.ratePctPerHour = rate;
    if (rate > 0.01) {
      const next = Math.floor(base.value + 1e-9) + 1;
      base.minutesToNextPct = ((next - base.value) / rate) * 60;
      base.minutesTo100 = (Math.max(0, 100 - base.value) / rate) * 60;
    }
    return base;
  }
}
