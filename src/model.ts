// The live model behind every surface: local log events, official readings,
// one estimator per limit, and the recorded estimate history. It turns all of
// that into a ViewModel on demand. No vscode imports, so it is testable.

import { Ledger } from './ledger';
import { LogTailer, UsageEvent } from './logReader';
import { BucketEstimator, BucketPersist, Estimate, windowLengthMs } from './estimator';
import { Price } from './pricing';
import { PointsIndex } from './ui/points';
import { EstimateHistory } from './ui/history';
import { buildDetail } from './ui/series';
import { ViewModelBuilder } from './ui/viewModel';
import { BucketInput, DetailVM, FreshInput, LocalVM, ModelInput, UiConfig, ViewModel } from './ui/types';
import { Family } from './pricing';

export const HORIZON_MS = 8 * 24 * 3600_000; // weekly window plus a margin

export interface Reading { t: number; buckets: Record<string, { utilization: number; resets_at: string | null }> }

export interface ModelState { buckets: Record<string, BucketPersist>; history?: unknown; raw?: Record<string, { utilization: number; resetsAt: string | null; t: number }> }

export class Model {
  readonly ledger = new Ledger();
  readonly estimators = new Map<string, BucketEstimator>();
  history = new EstimateHistory();
  private points = new Map<string, PointsIndex>();
  private raw = new Map<string, { utilization: number; resetsAt: string | null; t: number }>();
  private extras = new Map<string, number>();
  private builder = new ViewModelBuilder();
  private memo = new Map<string, { k: string; e: Estimate }>();
  lastEstimateMs = 0;
  lastRaw?: unknown;

  constructor(private readonly o: {
    tailer?: LogTailer;
    events?: () => UsageEvent[];          // sample mode supplies events directly
    clock: () => number;
    sample: boolean;
  }) {}

  now() { return this.o.clock(); }
  get sample() { return this.o.sample; }

  restore(s: ModelState | undefined) {
    if (!s) return;
    for (const [k, v] of Object.entries(s.buckets ?? {})) this.estimators.set(k, new BucketEstimator(k, v));
    this.history = EstimateHistory.fromJSON(s.history);
    for (const [k, v] of Object.entries(s.raw ?? {})) {
      if (v && typeof v.utilization === 'number' && typeof v.t === 'number') this.raw.set(k, v);
    }
  }

  state(): ModelState {
    const buckets: Record<string, BucketPersist> = {};
    for (const [k, e] of this.estimators) buckets[k] = e.toJSON();
    return { buckets, history: this.history.toJSON(), raw: Object.fromEntries(this.raw) };
  }

  /** Reads new log lines. Returns true when anything was added. */
  scan(): boolean {
    const evs = this.o.events ? this.o.events() : this.o.tailer!.scan(this.now());
    if (!evs.length) return false;
    this.ledger.add(evs);
    this.ledger.prune(this.now() - HORIZON_MS);
    return true;
  }

  /** Feeds one official reading (taken at r.t) to every windowed bucket. */
  apply(r: Reading, rounding: UiConfig['rounding']) {
    this.extras.clear();
    for (const k of [...this.raw.keys()]) if (!(k in r.buckets) || r.buckets[k] == null) this.raw.delete(k); // limit no longer reported
    for (const [k, b] of Object.entries(r.buckets)) {
      if (typeof b?.utilization !== 'number' || !isFinite(b.utilization)) continue;
      if (windowLengthMs(k) === undefined) { this.extras.set(k, b.utilization); continue; }
      let est = this.estimators.get(k);
      if (!est) { est = new BucketEstimator(k); this.estimators.set(k, est); }
      est.onReading({ utilization: b.utilization, resetsAt: b.resets_at }, r.t, this.ledger, rounding);
      this.raw.set(k, { utilization: b.utilization, resetsAt: b.resets_at, t: r.t });
      this.memo.delete(k);
    }
    // Record the fresh estimate so the "between the whole numbers" chart shows how it tightened.
    for (const k of Object.keys(r.buckets)) {
      const e = this.estimate(k, rounding);
      if (e) this.history.record(k, this.now(), e, true);
    }
    this.history.prune(this.now() - HORIZON_MS);
  }

  /** Estimate for one bucket, memoised until the ledger, readings or the minute change. */
  estimate(key: string, rounding: UiConfig['rounding']): Estimate | undefined {
    const est = this.estimators.get(key);
    if (!est) return undefined;
    const now = this.now();
    const j = est.toJSON();
    const k = `${this.ledger.version}|${j.readings?.length ?? 0}|${j.lastPollAt}|${est.sampleCount}|${rounding}|${Math.floor(now / 60_000)}`;
    const hit = this.memo.get(key);
    if (hit && hit.k === k) return hit.e;
    const t0 = performanceNow();
    const e = est.estimate(now, this.ledger, rounding);
    this.lastEstimateMs = Math.max(this.lastEstimateMs * 0.8, performanceNow() - t0);
    this.memo.set(key, { k, e });
    return e;
  }

  /** Keys the estimators know about that the latest reading (or the saved one) still reports. */
  private liveKeys(): string[] {
    return [...this.estimators.keys()].filter(k => this.raw.has(k) && windowLengthMs(k) !== undefined);
  }

  viewModel(cfg: UiConfig, fresh: FreshInput): ViewModel {
    const now = this.now();
    const buckets: BucketInput[] = [];
    for (const k of this.liveKeys()) {
      const e = this.estimate(k, cfg.rounding);
      if (!e) continue;
      const est = this.estimators.get(k)!;
      buckets.push({ key: k, estimate: e, raw: this.raw.get(k), armed: est.toJSON().calStart?.iFrom !== undefined, corrections: est.features() });
      if (!this.sample) this.history.record(k, now, e);
    }
    const input: ModelInput = {
      now, cfg, buckets,
      extras: [...this.extras].map(([key, utilization]) => ({ key, utilization })),
      fresh, local: this.local(buckets), sample: this.sample,
    };
    return this.builder.build(input);
  }

  /** This 5-hour window on this computer (or the last 5 hours when there is no window). */
  private local(buckets: BucketInput[]): LocalVM {
    const now = this.now();
    const five = buckets.find(b => b.key === 'five_hour')?.estimate;
    const ws = five?.windowStart;
    const inWindow = ws !== undefined && ws <= now && now - ws <= 5 * 3600_000;
    const from = inWindow ? ws! : now - 5 * 3600_000;
    const t = this.ledger.tokens(from, now);
    const usd = this.ledger.wu(from, now);
    const fam = [...this.ledger.byFamily(from, now)].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    return {
      from, to: now,
      label: inWindow ? 'This 5-hour window here' : 'The last 5 hours here',
      requests: this.ledger.requests(from, now),
      usd,
      byFamily: fam.map(([family, v]) => ({ family: family as Family, usd: v, share: usd > 0 ? v / usd : 0 })),
      tokens: { input: t.input, output: t.output, cacheWrite: t.cacheWrite5m + t.cacheWrite1h, cacheRead: t.cacheRead },
    };
  }

  detail(key: string, cfg: UiConfig, polls: { t: number; ok: boolean }[]): DetailVM | undefined {
    const est = this.estimators.get(key);
    const e = this.estimate(key, cfg.rounding);
    if (!est || !e) return undefined;
    let idx = this.points.get(key);
    if (!idx) { idx = new PointsIndex(est); this.points.set(key, idx); }
    idx.update(this.ledger);
    const now = this.now();
    const from = e.windowStart ?? now - (windowLengthMs(key) ?? 5 * 3600_000);
    return buildDetail({ key, est, e, idx, ledger: this.ledger, history: this.history.points(key, from, now), polls, rounding: cfg.rounding, now });
  }

  resetCalibration() {
    for (const e of this.estimators.values()) e.resetCalibration();
    this.memo.clear();
  }

  /** Diagnostics for the full report. */
  diagnostics(rounding: UiConfig['rounding']) {
    return [...this.estimators].map(([key, est]) => ({
      key, estimate: this.estimate(key, rounding), samples: est.sampleCount, wuPerPct: est.wuPerPct,
      corrections: est.features(), raw: this.raw.get(key),
    }));
  }
}

const performanceNow = () => (globalThis.performance ? globalThis.performance.now() : Date.now());
