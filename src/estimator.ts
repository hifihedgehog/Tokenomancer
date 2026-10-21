// Turns coarse official utilization readings plus exact local token usage
// into a fine-grained estimate.
//
// Method (per limit bucket):
//  1. Calibrate: each time the official number moves up by >= 1 point, the
//     weighted units (WU) logged locally since the previous move tell us what
//     1% costs. We keep a running median of these samples.
//  2. Anchor: the moment the number changes, we know where we are almost
//     exactly (e.g. it just became 37 -> we're at ~37.0).
//  3. Interpolate: estimate = anchor + WU since anchor / WU-per-1%, clamped
//     to what the official number allows.

import { ALL, FamilyFilter, Ledger } from './ledger';
import { Family } from './pricing';

export type Rounding = 'floor' | 'round';

export interface Reading {
  utilization: number; // 0-100
  resetsAt?: string | null;
}

interface Point { pct: number; t: number }

export interface BucketPersist {
  samples: number[];
  lastOfficial?: number;
  lastPollAt?: number;
  resetsAt?: string | null;
  anchor?: Point & { exact: boolean };
  calStart?: Point;
  precise?: boolean;
}

export type EstimateKind =
  | 'official'      // no calibration yet: official number only
  | 'precise'       // the endpoint itself returned decimals
  | 'anchored'      // interpolated from a tick seen live (best)
  | 'window-start'  // interpolated from the start of the window (no tick seen yet)
  | 'lower-bound';  // only a lower bound is known

export interface Estimate {
  key: string;
  official: number;
  value: number;
  kind: EstimateKind;
  wuPerPct?: number;
  samples: number;
  spread?: number;      // relative spread of samples (MAD / median)
  ratePctPerHour?: number;
  minutesToNextPct?: number;
  minutesTo100?: number;
  resetsAt?: string | null;
  windowStart?: number;
}

const MAX_SAMPLES = 40;
const MAX_TICK_GAP_MS = 5 * 60_000; // poll gaps longer than this make tick timing unreliable
const DRIFT_LOW = 0.4; // sample < 40% of median => usage happened elsewhere

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

export class BucketEstimator {
  readonly filter: FamilyFilter;
  private st: BucketPersist;

  constructor(readonly key: string, persisted?: BucketPersist) {
    this.filter = filterForKey(key);
    this.st = persisted ? { ...persisted, samples: [...(persisted.samples ?? [])] } : { samples: [] };
  }

  toJSON(): BucketPersist { return { ...this.st, samples: [...this.st.samples] }; }

  resetCalibration() { this.st.samples = []; }

  get wuPerPct(): number | undefined { return median(this.st.samples); }

  /** Feed one official reading. */
  onReading(r: Reading, now: number, ledger: Ledger, rounding: Rounding = 'floor') {
    const v = r.utilization;
    const st = this.st;
    if (!isInt(v)) st.precise = true;

    const prev = st.lastOfficial;
    const prevAt = st.lastPollAt;
    const resetChanged = !!(st.resetsAt && r.resetsAt && Math.abs(Date.parse(st.resetsAt) - Date.parse(r.resetsAt)) > 60_000);

    if (prev === undefined || prevAt === undefined) {
      // First reading (or first since install).
      st.anchor = { pct: v, t: now, exact: !!st.precise };
      st.calStart = undefined;
    } else if (resetChanged || v < prev - 0.5) {
      // New window. Calibration samples remain valid; anchors do not.
      st.anchor = { pct: v, t: now, exact: !!st.precise };
      st.calStart = undefined;
    } else if (v > prev + 1e-9) {
      const gap = now - prevAt;
      const reliable = gap <= MAX_TICK_GAP_MS;
      // In integer mode the change happened somewhere between the two polls.
      const tickT = st.precise ? now : prevAt + gap / 2;
      if (reliable) {
        if (st.calStart && v - st.calStart.pct >= 1 - 1e-9) {
          this.addSample(ledger.wu(st.calStart.t, tickT, this.filter) / (v - st.calStart.pct));
          st.calStart = { pct: v, t: tickT };
        } else if (!st.calStart) {
          st.calStart = { pct: v, t: tickT };
        }
        st.anchor = { pct: v, t: tickT, exact: true };
      } else {
        st.anchor = { pct: v, t: now, exact: !!st.precise };
        st.calStart = undefined;
      }
    } else if (st.precise) {
      // Precise mode: every reading is an exact anchor.
      st.anchor = { pct: v, t: now, exact: true };
      if (!st.calStart) st.calStart = { pct: v, t: now };
    }

    st.lastOfficial = v;
    st.lastPollAt = now;
    st.resetsAt = r.resetsAt ?? st.resetsAt;
  }

  private addSample(s: number) {
    if (!(s > 0) || !isFinite(s)) return; // all usage was elsewhere
    const m = this.wuPerPct;
    if (m !== undefined && this.st.samples.length >= 3 && s < m * DRIFT_LOW) return; // unseen usage
    this.st.samples.push(s);
    if (this.st.samples.length > MAX_SAMPLES) this.st.samples.shift();
  }

  estimate(now: number, ledger: Ledger, rounding: Rounding = 'floor'): Estimate {
    const st = this.st;
    const official = st.lastOfficial ?? 0;
    const wpp = this.wuPerPct;
    const len = windowLengthMs(this.key);
    const windowStart = len && st.resetsAt ? Date.parse(st.resetsAt) - len : undefined;
    const base: Estimate = {
      key: this.key, official, value: official, kind: st.precise ? 'precise' : 'official',
      samples: st.samples.length, resetsAt: st.resetsAt, windowStart,
    };
    if (wpp) {
      base.wuPerPct = wpp;
      const mad = median(st.samples.map(s => Math.abs(s - wpp)));
      base.spread = mad !== undefined ? mad / wpp : undefined;
    }
    if (!wpp || !st.anchor) return base;

    // Range the official number allows.
    const lo = st.precise ? official : rounding === 'round' ? official - 0.5 : official;
    const hi = st.precise ? official + 1 : rounding === 'round' ? official + 0.49 : official + 0.99;
    const clamp = (x: number) => Math.min(hi, Math.max(lo, x));
    const shift = !st.precise && rounding === 'round' ? -0.5 : 0; // a tick to N means crossing N-0.5

    let value: number;
    let kind: EstimateKind;
    if (st.anchor.exact) {
      value = st.anchor.pct + shift + ledger.wu(st.anchor.t, now, this.filter) / wpp;
      kind = st.precise ? 'precise' : 'anchored';
    } else if (windowStart !== undefined && windowStart < now) {
      value = ledger.wu(windowStart, now, this.filter) / wpp;
      kind = 'window-start';
      // If that undershoots, usage happened elsewhere; fall back to a lower bound.
      if (value < lo) {
        value = st.anchor.pct + shift + ledger.wu(st.anchor.t, now, this.filter) / wpp;
        kind = 'lower-bound';
      }
    } else {
      value = st.anchor.pct + shift + ledger.wu(st.anchor.t, now, this.filter) / wpp;
      kind = 'lower-bound';
    }
    base.value = clamp(value);
    base.kind = kind;

    // Pace over the last 15 minutes.
    const winMs = 15 * 60_000;
    const rate = (ledger.wu(now - winMs, now, this.filter) / wpp) * (3600_000 / winMs);
    base.ratePctPerHour = rate;
    if (rate > 0.01) {
      const next = Math.floor(base.value + 1e-9) + 1;
      base.minutesToNextPct = ((next - base.value) / rate) * 60;
      base.minutesTo100 = (Math.max(0, 100 - base.value) / rate) * 60;
    }
    return base;
  }
}
