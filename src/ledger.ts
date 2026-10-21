// Time-ordered store of usage events with range queries.

import { Family, TokenUsage } from './pricing';
import { UsageEvent } from './logReader';

export type FamilyFilter = (f: Family) => boolean;
export const ALL: FamilyFilter = () => true;

export class Ledger {
  private events: UsageEvent[] = [];

  add(evs: UsageEvent[]) {
    if (!evs.length) return;
    const lastT = this.events.length ? this.events[this.events.length - 1].t : -Infinity;
    this.events.push(...evs);
    // Events from several files can interleave; keep sorted.
    if (evs.some(e => e.t < lastT) || !isSorted(evs)) this.events.sort((a, b) => a.t - b.t);
  }

  prune(before: number) {
    const i = this.lowerBound(before);
    if (i > 0) this.events.splice(0, i);
  }

  get size() { return this.events.length; }

  /** Weighted units in [from, to). */
  wu(from: number, to: number, filter: FamilyFilter = ALL): number {
    let s = 0;
    for (let i = this.lowerBound(from); i < this.events.length && this.events[i].t < to; i++) {
      const e = this.events[i];
      if (filter(e.family)) s += e.wu;
    }
    return s;
  }

  tokens(from: number, to: number, filter: FamilyFilter = ALL): TokenUsage & { requests: number } {
    const t = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, requests: 0 };
    for (let i = this.lowerBound(from); i < this.events.length && this.events[i].t < to; i++) {
      const e = this.events[i];
      if (!filter(e.family)) continue;
      t.input += e.tokens.input;
      t.output += e.tokens.output;
      t.cacheWrite5m += e.tokens.cacheWrite5m;
      t.cacheWrite1h += e.tokens.cacheWrite1h;
      t.cacheRead += e.tokens.cacheRead;
      t.requests++;
    }
    return t;
  }

  /** WU per model family in [from, to). */
  byFamily(from: number, to: number): Map<Family, number> {
    const m = new Map<Family, number>();
    for (let i = this.lowerBound(from); i < this.events.length && this.events[i].t < to; i++) {
      const e = this.events[i];
      m.set(e.family, (m.get(e.family) ?? 0) + e.wu);
    }
    return m;
  }

  /** Events in [from, to) passing the filter, in time order. */
  eventsIn(from: number, to: number, filter: FamilyFilter = ALL): UsageEvent[] {
    const out: UsageEvent[] = [];
    for (let i = this.lowerBound(from); i < this.events.length && this.events[i].t < to; i++) {
      if (filter(this.events[i].family)) out.push(this.events[i]);
    }
    return out;
  }

  lastEventTime(): number | undefined {
    return this.events.length ? this.events[this.events.length - 1].t : undefined;
  }

  private lowerBound(t: number): number {
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
}

function isSorted(evs: UsageEvent[]) {
  for (let i = 1; i < evs.length; i++) if (evs[i].t < evs[i - 1].t) return false;
  return true;
}
