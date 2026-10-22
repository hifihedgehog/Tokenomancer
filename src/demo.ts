// Sample data for screenshots and UI development: a few days of realistic
// Claude Code traffic and the official readings it would have produced.
// Enabled only by the TOKENOMANCER_DEMO=1 environment variable; never touches
// real logs, credentials or saved calibration.

import { Ledger } from './ledger';
import { UsageEvent } from './logReader';
import { BucketEstimator, Reading } from './estimator';
import { Family, TokenUsage, costParts, parseModel } from './pricing';
import { UsageResponse } from './usageApi';

interface Truth { key: string; costPerPct: number; family?: Family; windows: { start: number; resetsAt: string }[] }

const MODELS: [string, number][] = [['claude-fable-5-1', 0.62], ['claude-sonnet-5-5', 0.28], ['claude-haiku-5-5', 0.10]];
// How the simulated limit weighs token types relative to API prices.
const TRUE_FACTOR: Record<string, number> = { 'fable:read': 1.4, 'fable:out': 0.9, 'sonnet:read': 1.2 };
const PART = ['in', 'out', 'read'];

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

export class DemoSource {
  private r = rng(20261021);
  private all: UsageEvent[] = [];
  private pending: UsageEvent[] = [];
  private truths: Truth[];
  private sessions: [number, number][] = []; // when VS Code was open and polling
  private nextReq: number;
  private mode = 0;

  constructor(private readonly now: number = Date.now()) {
    const fiveStart = now - (3 * 60 + 12) * 60_000;
    const weekStart = now - (3 * 24 + 20) * 3600_000;
    const iso = (t: number) => new Date(t).toISOString();
    const week = [{ start: weekStart, resetsAt: iso(weekStart + 7 * 24 * 3600_000) }];
    const five: Truth['windows'] = [];
    // Earlier sessions this week, each opening its own 5-hour window, then today's session up to now.
    for (const [dayAgo, startH, hours] of [[3, 9.5, 3.2], [2, 13, 2.5], [2, 20, 1.5], [1, 10, 4]] as const) {
      const day = new Date(now - dayAgo * 24 * 3600_000);
      day.setHours(0, 0, 0, 0);
      const s = Math.max(+day + startH * 3600_000, weekStart + 60_000);
      const e = s + hours * 3600_000;
      five.push({ start: s, resetsAt: iso(s + 5 * 3600_000) });
      this.sessions.push([s + 2 * 60_000, e + 10 * 60_000]);
      this.nextReq = s + 60_000;
      this.generate(this.nextReq, e);
    }
    five.push({ start: fiveStart, resetsAt: iso(fiveStart + 5 * 3600_000) });
    this.sessions.push([fiveStart + 2 * 60_000, now]);
    this.truths = [
      { key: 'five_hour', costPerPct: 0.5, windows: five },
      { key: 'seven_day', costPerPct: 5.4, windows: week },
      { key: 'seven_day_fable', costPerPct: 3.7, family: 'fable', windows: week },
    ];
    this.nextReq = fiveStart + 4 * 60_000;
    this.generate(this.nextReq, now);
  }

  /** Loads past events and replays the readings an open VS Code would have seen today. */
  bootstrap(ledger: Ledger, estimators: Map<string, BucketEstimator>) {
    ledger.add([...this.all]);
    this.pending = [];
    for (const [from, to] of this.sessions) {
      for (let t = from; t < to; t += 60_000) {
        for (const [k, rd] of this.readingsAt(t)) {
          let est = estimators.get(k);
          if (!est) { est = new BucketEstimator(k); estimators.set(k, est); }
          est.onReading(rd, t, ledger);
        }
      }
    }
  }

  /** New requests since the last call, as if Claude Code had just logged them. */
  scan(now = Date.now()): UsageEvent[] {
    this.generate(this.nextReq, now);
    const out = this.pending;
    this.pending = [];
    return out;
  }

  async fetch(now = Date.now()): Promise<UsageResponse> {
    const buckets = this.readingsAt(now);
    const raw: Record<string, unknown> = {};
    for (const [k, rd] of buckets) raw[k] = { utilization: rd.utilization, resets_at: rd.resetsAt };
    raw.seven_day_opus = null;
    raw.extra_usage = { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null };
    return { buckets, raw };
  }

  private readingsAt(t: number): Map<string, Reading> {
    const m = new Map<string, Reading>();
    for (const tr of this.truths) {
      const w = [...tr.windows].reverse().find(w => w.start <= t);
      if (!w) continue;
      let pts = 0;
      for (const e of this.all) {
        if (e.t < w.start || e.t >= t) continue;
        if (tr.family && e.family !== tr.family) continue;
        pts += e.parts.reduce((s, p, i) => s + p * (TRUE_FACTOR[`${e.family}:${PART[i]}`] ?? 1), 0) / tr.costPerPct;
      }
      m.set(tr.key, { utilization: Math.min(100, Math.floor(pts)), resetsAt: w.resetsAt });
    }
    return m;
  }

  private generate(from: number, to: number) {
    const r = this.r;
    let t = Math.max(from, this.nextReq ?? from);
    while (t < to) {
      if (r() < 0.04) this.mode = Math.floor(r() * 3);
      let x = r(), model = MODELS[0][0];
      for (const [m, p] of MODELS) { if (x < p) { model = m; break; } x -= p; }
      const tokens: TokenUsage = {
        input: Math.round(20 + r() * 400),
        output: Math.round((this.mode === 1 ? 1800 : this.mode === 0 ? 350 : 900) * (0.3 + r() * 1.4)),
        cacheWrite5m: r() < 0.15 ? Math.round(8000 + r() * 30000) : Math.round(r() * 3000),
        cacheWrite1h: 0,
        cacheRead: Math.round((this.mode === 0 ? 110_000 : 60_000) * (0.4 + r())),
      };
      const parts = costParts(model, tokens);
      const ev: UsageEvent = { t: Math.round(t), model, family: parseModel(model).family, wu: parts[0] + parts[1] + parts[2], parts, tokens };
      this.all.push(ev);
      this.pending.push(ev);
      t += r() < 0.06 ? 90_000 + r() * 420_000 : 6000 + r() * 34_000; // occasional breaks
    }
    this.nextReq = t;
  }
}
