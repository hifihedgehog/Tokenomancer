// What every local request cost one limit, in points, as a prefix sum, so "points used since t"
// is two binary searches. Per event it does exactly the estimator's arithmetic
// (predictZ(featuresOf([e]), wpp, g), in the same order), so the charts agree with estimate()
// to the last bit per event. Built only from the estimator's public API. Pure: no vscode, no Node.

import type { BucketEstimator } from '../estimator';
import type { Ledger } from '../ledger';
import type { UsageEvent } from '../logReader';
import type { Family } from '../pricing';

const PARTS = ['in', 'out', 'read'] as const;
const FAMILIES: Family[] = ['fable', 'mythos', 'opus', 'sonnet', 'haiku', 'other'];

export class PointsIndex {
  private key = '';                     // the fit the arrays were built for
  private wpp?: number;
  private g = new Map<string, [number, number, number]>();
  private ledger?: Ledger;
  private resorts = -1;
  private endAbs = 0;                   // ledger events indexed so far (absolute)
  private t = new Float64Array(256);    // times of the filtered events
  private c = new Float64Array(257);    // c[i] = points of filtered events before index i
  private lo = 0;                       // first live entry (entries before it were pruned)
  private n = 0;

  constructor(readonly est: BucketEstimator) {
    this.refit();
  }

  /** The estimator had a fit at the last update(); otherwise every count is 0. */
  get calibrated(): boolean { return this.wpp !== undefined; }

  /** Brings the index up to date: O(new events), or a rebuild after a refit, a resort or a new ledger. */
  update(ledger: Ledger) {
    const refit = this.refit();
    if (refit || ledger !== this.ledger || ledger.resorts !== this.resorts) {
      this.ledger = ledger;
      this.resorts = ledger.resorts;
      this.lo = this.n = 0;
      this.endAbs = ledger.pruned;
    }
    // Events before the ledger's first one were pruned: drop them from the front.
    const first = ledger.firstEventTime();
    this.lo = first === undefined ? this.n : this.lowerBound(first);
    if (this.lo > 4096 && this.lo > this.n / 2) this.compact();
    if (this.wpp !== undefined) {
      const filter = this.est.filter;
      ledger.forEachAbs(this.endAbs, e => { if (filter(e.family)) this.push(e); });
    }
    this.endAbs = ledger.endAbs;
  }

  /** Points of one event: Σ parts[i] / wpp · factor(family:part), for parts > 0, in order. */
  pointsOf(e: UsageEvent): number {
    const w = this.wpp;
    if (w === undefined) return 0;
    const g = this.factors(e.family), p = e.parts;
    let s = 0;
    for (let i = 0; i < 3; i++) if (p[i] > 0) s += (p[i] / w) * g[i];
    return s;
  }

  /** The same, split into [fresh input and cache writes, output, cache reads]. */
  partsOf(e: UsageEvent): [number, number, number] {
    const w = this.wpp;
    if (w === undefined) return [0, 0, 0];
    const g = this.factors(e.family), p = e.parts;
    return [p[0] > 0 ? (p[0] / w) * g[0] : 0, p[1] > 0 ? (p[1] / w) * g[1] : 0, p[2] > 0 ? (p[2] / w) * g[2] : 0];
  }

  /** Points of the limit's events with e.t < t. */
  cum(t: number): number {
    return this.c[this.lowerBound(t)] - this.c[this.lo];
  }

  /** Points used in [t, now). */
  since(t: number, now: number): number {
    return t < now ? this.c[this.lowerBound(now)] - this.c[this.lowerBound(t)] : 0;
  }

  /** Re-reads the estimator's fit; true when it changed. */
  private refit(): boolean {
    const wpp = this.est.wuPerPct;
    const key = wpp === undefined ? '' : `${wpp}|${this.est.features().map(([k, g]) => `${k}=${g}`).join(',')}`;
    if (key === this.key) return false;
    this.key = key;
    this.wpp = wpp;
    this.g.clear();
    if (wpp !== undefined) for (const f of FAMILIES) this.g.set(f, this.lookup(f));
    return true;
  }

  private lookup(f: string): [number, number, number] {
    return PARTS.map(p => this.est.factor(`${f}:${p}`)) as [number, number, number];
  }

  // Unknown families can't be cached: the table must stay the fit captured at the last update.
  private factors(f: string) { return this.g.get(f) ?? this.lookup(f); }

  /** Moves the live entries to the front. c keeps its running total; every count is a difference. */
  private compact() {
    this.t.copyWithin(0, this.lo, this.n);
    this.c.copyWithin(0, this.lo, this.n + 1);
    this.n -= this.lo;
    this.lo = 0;
  }

  private push(e: UsageEvent) {
    if (this.n === this.t.length) {
      const t = new Float64Array(this.t.length * 2), c = new Float64Array(this.t.length * 2 + 1);
      t.set(this.t);
      c.set(this.c);
      this.t = t;
      this.c = c;
    }
    this.t[this.n] = e.t;
    this.c[this.n + 1] = this.c[this.n] + this.pointsOf(e);
    this.n++;
  }

  /** First live index with time ≥ t. */
  private lowerBound(t: number): number {
    let lo = this.lo, hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
}
