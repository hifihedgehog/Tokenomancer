// The estimate as it stood over time: at every applied official reading and at most once a minute
// in between. The "between the whole numbers" chart draws this record, so it shows the estimate
// genuinely tightening at each tick, which a curve reconstructed backwards from now cannot.
// Pure: no vscode, no Node.

import type { Estimate } from '../estimator';
import type { HistoryPoint, Kind } from './types';

const MIN = 60_000;
const CAP = 1000;   // per key: ~16 h at one point a minute, more while idle (constant runs keep only their ends)
const KINDS: ReadonlySet<string> = new Set<Kind>(['official', 'precise', 'anchored', 'window-start', 'lower-bound']);

const fin = (x: unknown): x is number => typeof x === 'number' && isFinite(x);

function pointOf(t: number, e: Estimate): HistoryPoint {
  const p: HistoryPoint = { t, v: e.value, s: fin(e.sigma) ? e.sigma : 0, kind: e.kind, official: e.official };
  if (fin(e.lo)) p.lo = e.lo;
  if (fin(e.hi)) p.hi = e.hi;
  return p;
}

const same = (a: HistoryPoint, b: HistoryPoint) =>
  a.v === b.v && a.s === b.s && a.lo === b.lo && a.hi === b.hi && a.kind === b.kind && a.official === b.official;

/** First index with t ≥ the given time. */
function lowerBound(list: HistoryPoint[], t: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export class EstimateHistory {
  private m = new Map<string, HistoryPoint[]>();

  /**
   * Records the estimate at `now`. Skipped (false) within a minute of the last point unless forced
   * or the kind or official number changed. A run of identical estimates keeps only its first and
   * last point, so an idle evening costs two points, not hundreds.
   */
  record(key: string, now: number, e: Estimate, force = false): boolean {
    if (!fin(now) || !fin(e.value) || !fin(e.official) || !KINDS.has(e.kind)) return false;
    const p = pointOf(now, e);
    let list = this.m.get(key);
    if (!list) this.m.set(key, list = []);
    const n = list.length, last = list[n - 1];
    if (last && now < last.t) {           // out of order (another window's older reading): slot it in
      const i = lowerBound(list, now);
      list.splice(i, list[i]?.t === now ? 1 : 0, p);
    } else if (last && now === last.t) {
      list[n - 1] = p;
    } else {
      if (last && !force && now - last.t < MIN && last.kind === p.kind && last.official === p.official) return false;
      if (n >= 2 && same(last, p) && same(list[n - 2], p)) list[n - 1] = p;
      else list.push(p);
    }
    if (list.length > CAP) list.splice(0, list.length - CAP);
    return true;
  }

  /** Recorded points with from ≤ t ≤ to, oldest first (copies). */
  points(key: string, from: number, to: number): HistoryPoint[] {
    const list = this.m.get(key) ?? [];
    const out: HistoryPoint[] = [];
    for (let i = lowerBound(list, from); i < list.length && list[i].t <= to; i++) out.push({ ...list[i] });
    return out;
  }

  /** Drops points older than `before` and caps each key at its newest 1000. */
  prune(before: number) {
    for (const [k, list] of this.m) {
      const i = Math.max(lowerBound(list, before), list.length - CAP);
      if (i > 0) list.splice(0, i);
      if (!list.length) this.m.delete(k);
    }
  }

  keys(): string[] { return [...this.m.keys()]; }

  /** For saving: numbers kept to 1e-4 points, far below anything shown, which keeps the state small. */
  toJSON(): Record<string, HistoryPoint[]> {
    const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
    const out: Record<string, HistoryPoint[]> = {};
    for (const [k, list] of this.m) {
      out[k] = list.map(p => {
        const q: HistoryPoint = { t: p.t, v: r4(p.v), s: r4(p.s), kind: p.kind, official: p.official };
        if (p.lo !== undefined) q.lo = r4(p.lo);
        if (p.hi !== undefined) q.hi = r4(p.hi);
        return q;
      });
    }
    return out;
  }

  /** Restores saved history, dropping anything malformed instead of failing. */
  static fromJSON(o: unknown): EstimateHistory {
    const h = new EstimateHistory();
    if (!o || typeof o !== 'object' || Array.isArray(o)) return h;
    for (const [k, raw] of Object.entries(o as Record<string, unknown>)) {
      if (!Array.isArray(raw)) continue;
      const list: HistoryPoint[] = [];
      for (const x of raw as any[]) {
        if (!x || typeof x !== 'object' || !fin(x.t) || !fin(x.v) || !fin(x.official) || !KINDS.has(x.kind)) continue;
        const p: HistoryPoint = { t: x.t, v: x.v, s: fin(x.s) && x.s >= 0 ? x.s : 0, kind: x.kind, official: x.official };
        if (fin(x.lo)) p.lo = x.lo;
        if (fin(x.hi)) p.hi = x.hi;
        list.push(p);
      }
      if (!list.length) continue;
      list.sort((a, b) => a.t - b.t);
      h.m.set(k, list.filter((p, i) => i === list.length - 1 || list[i + 1].t !== p.t).slice(-CAP));
    }
    return h;
  }
}
