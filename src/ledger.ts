// Time-ordered store of usage events with range queries.

import { Family, TokenUsage } from './pricing';
import { UsageEvent } from './logReader';

export type FamilyFilter = (f: Family) => boolean;
export const ALL: FamilyFilter = () => true;

export class Ledger {
  private events: UsageEvent[] = [];
  private _version = 0;
  private _pruned = 0;
  private _resorts = 0;

  /** +1 on every add() or prune() that changes the events. */
  get version() { return this._version; }
  /** Events ever removed from the front by prune(). */
  get pruned() { return this._pruned; }
  /** +1 whenever add() inserted events before existing ones, so later events moved. */
  get resorts() { return this._resorts; }
  /** Absolute index one past the last event (pruned + size): what forEachAbs continues from. */
  get endAbs() { return this._pruned + this.events.length; }

  add(evs: UsageEvent[]) {
    if (!evs.length) return;
    const batch = isSorted(evs) ? evs : [...evs].sort((a, b) => a.t - b.t);
    const E = this.events;
    // Events from several files can interleave. New ones usually land at the end; otherwise merge
    // them into the tail, keeping earlier events first on equal times (as a stable sort would).
    const at = E.length && batch[0].t < E[E.length - 1].t ? this.upperBound(batch[0].t) : E.length;
    if (at === E.length) {
      for (const e of batch) E.push(e); // not push(...batch): spreading overflows the stack above ~125k events
    } else {
      const tail = E.splice(at);
      let i = 0, j = 0;
      while (i < tail.length && j < batch.length) E.push(tail[i].t <= batch[j].t ? tail[i++] : batch[j++]);
      while (i < tail.length) E.push(tail[i++]);
      while (j < batch.length) E.push(batch[j++]);
      this._resorts++;
    }
    this._version++;
  }

  prune(before: number) {
    const i = this.lowerBound(before);
    if (i === 0) return;
    this.events.splice(0, i);
    this._pruned += i;
    this._version++;
  }

  get size() { return this.events.length; }

  /** Weighted units in [from, to). */
  wu(from: number, to: number, filter: FamilyFilter = ALL): number {
    let s = 0;
    this.forEach(from, to, e => { s += e.wu; }, filter);
    return s;
  }

  /** Tokens in [from, to); `requests` counts API requests, not the streamed lines that repeat them. */
  tokens(from: number, to: number, filter: FamilyFilter = ALL): TokenUsage & { requests: number } {
    const t = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, requests: 0 };
    this.forEach(from, to, e => {
      t.input += e.tokens.input;
      t.output += e.tokens.output;
      t.cacheWrite5m += e.tokens.cacheWrite5m;
      t.cacheWrite1h += e.tokens.cacheWrite1h;
      t.cacheRead += e.tokens.cacheRead;
      if (e.first !== false) t.requests++;
    }, filter);
    return t;
  }

  /** API requests in [from, to): events that aren't a later line of an already-counted request. */
  requests(from: number, to: number, filter: FamilyFilter = ALL): number {
    let n = 0;
    this.forEach(from, to, e => { if (e.first !== false) n++; }, filter);
    return n;
  }

  /** WU per model family in [from, to). */
  byFamily(from: number, to: number, filter: FamilyFilter = ALL): Map<Family, number> {
    const m = new Map<Family, number>();
    this.forEach(from, to, e => { m.set(e.family, (m.get(e.family) ?? 0) + e.wu); }, filter);
    return m;
  }

  /** Events in [from, to) passing the filter, in time order. */
  eventsIn(from: number, to: number, filter: FamilyFilter = ALL): UsageEvent[] {
    const out: UsageEvent[] = [];
    this.forEach(from, to, e => { out.push(e); }, filter);
    return out;
  }

  /** Calls fn for each event in [from, to) passing the filter, in time order, without copying. */
  forEach(from: number, to: number, fn: (e: UsageEvent) => void, filter: FamilyFilter = ALL) {
    const E = this.events;
    for (let i = this.lowerBound(from); i < E.length && E[i].t < to; i++) if (filter(E[i].family)) fn(E[i]);
  }

  /** Calls fn for each event whose absolute index (see endAbs) is ≥ fromAbs. */
  forEachAbs(fromAbs: number, fn: (e: UsageEvent, abs: number) => void) {
    const E = this.events;
    for (let i = Math.max(0, fromAbs - this._pruned); i < E.length; i++) fn(E[i], this._pruned + i);
  }

  firstEventTime(): number | undefined {
    return this.events.length ? this.events[0].t : undefined;
  }

  lastEventTime(): number | undefined {
    return this.events.length ? this.events[this.events.length - 1].t : undefined;
  }

  /** First index with t ≥ the given time. */
  private lowerBound(t: number): number {
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** First index with t > the given time. */
  private upperBound(t: number): number {
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].t <= t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
}

function isSorted(evs: UsageEvent[]) {
  for (let i = 1; i < evs.length; i++) if (evs[i].t < evs[i - 1].t) return false;
  return true;
}
