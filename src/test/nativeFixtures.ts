// Fixture view models for the native text surfaces' tests and screenshots: the
// sample scenario built from real Estimates (DemoSource + BucketEstimator), and
// synthetic edge cases fed through the same ViewModelBuilder.

import { BucketEstimator, Estimate, windowLengthMs } from '../estimator';
import { Ledger } from '../ledger';
import { DemoSource } from '../demo';
import { ViewModelBuilder } from '../ui/viewModel';
import type { BucketInput, FreshInput, LocalVM, ModelInput, TimeFmt, UiConfig, ViewModel } from '../ui/types';

export const GB: TimeFmt = { locale: 'en-GB', timeZone: 'Europe/London' };
export const NOW = Date.parse('2026-10-22T13:12:00+01:00');
export const MIN = 60_000, HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();

export const cfg = (o: Partial<UiConfig> = {}): UiConfig => ({
  decimals: 2, precision: 'adaptive', rounding: 'floor', show: 'all', customKeys: [], uncertainty: 'off',
  icon: 'rune', highlight: 'nearLimit', graphics: 'images', pollMs: 60_000, time: GB, ...o,
});

export const LOCAL: LocalVM = {
  from: NOW - 3 * HOUR, to: NOW, label: 'This 5-hour window here', requests: 412, usd: 23.17,
  byFamily: [{ family: 'fable', usd: 19.0, share: 0.82 }, { family: 'sonnet', usd: 3.48, share: 0.15 }, { family: 'haiku', usd: 0.69, share: 0.03 }],
  tokens: { input: 50_900, output: 273_000, cacheWrite: 1_180_000, cacheRead: 12_800_000 },
};

/** An Estimate as the estimator would shape it; the window follows resetsAt. */
export function est(key: string, o: Partial<Estimate> & { resetIn?: number } = {}): Estimate {
  const { resetIn = 3 * HOUR, ...rest } = o;
  const R = NOW + resetIn;
  return {
    key, official: 44, value: 44.27, kind: 'anchored', samples: 10, sigma: 0.012, lo: 44.24, hi: 44.3, unseen: false,
    wuPerPct: 0.5, spread: 0.05, ratePctPerHour: 5, resetsAt: iso(R), windowStart: R - windowLengthMs(key)!, ...rest,
  };
}

export const bucket = (e: Estimate, raw: Partial<NonNullable<BucketInput['raw']>> = {}, now = NOW): BucketInput => ({
  key: e.key, estimate: e, armed: true, corrections: [],
  raw: { utilization: e.official, resetsAt: e.resetsAt ?? null, t: now - 30_000, ...raw },
});

export interface InputOpts {
  now?: number; cfg?: Partial<UiConfig>; fresh?: Partial<FreshInput>; extras?: ModelInput['extras']; local?: LocalVM; sample?: boolean;
}

export function input(buckets: BucketInput[], o: InputOpts = {}): ModelInput {
  const now = o.now ?? NOW;
  return {
    now, cfg: cfg(o.cfg), buckets, extras: o.extras ?? [], local: o.local ?? LOCAL, sample: o.sample ?? false,
    fresh: { lastOkAt: now - 30_000, refreshing: false, role: 'fetcher', claudeDir: '/home/me/.claude', ...o.fresh },
  };
}

export const build = (buckets: BucketInput[], o: InputOpts = {}): ViewModel => new ViewModelBuilder().build(input(buckets, o));

/** The sample scenario's real Estimates at NOW, as model.ts would gather them. */
export async function demoBuckets(now = NOW): Promise<{ buckets: BucketInput[]; ests: Map<string, BucketEstimator>; ledger: Ledger; raw: unknown }> {
  const demo = new DemoSource(now);
  const ledger = new Ledger();
  const ests = new Map<string, BucketEstimator>();
  demo.bootstrap(ledger, ests);
  const res = await demo.fetch(now);
  const buckets: BucketInput[] = [];
  for (const [key, rd] of res.buckets) {
    const e = ests.get(key);
    if (!e || windowLengthMs(key) === undefined) continue;
    e.onReading(rd, now, ledger);
    buckets.push({
      key, estimate: e.estimate(now, ledger),
      raw: { utilization: rd.utilization, resetsAt: rd.resetsAt ?? null, t: now },
      armed: e.toJSON().calStart?.iFrom !== undefined, corrections: e.features(),
    });
  }
  return { buckets, ests, ledger, raw: res.raw };
}

/**
 * The spec's scenario (§4.6) at Thu 22 Oct 2026 13:12: Weekly 61.18 pinned and running out on
 * Saturday (A1), Fable weekly 38.42 counted, 5-hour 44.27 pinned. Plus states it never reaches,
 * each shaped the way the estimator would shape it.
 */
export function edgeBuckets() {
  const five = (o: Parameters<typeof est>[1] = {}) => est('five_hour', { resetIn: 1 * HOUR + 54 * MIN, ...o });
  const week = (o: Parameters<typeof est>[1] = {}) => est('seven_day', { resetIn: 3 * 24 * HOUR + 20 * HOUR, ...o });
  const fable = (o: Parameters<typeof est>[1] = {}) => est('seven_day_fable', { resetIn: 3 * 24 * HOUR + 20 * HOUR, ...o });
  return {
    pinned5: bucket(five({ official: 44, value: 44.27, sigma: 0.012, lo: 44.24, hi: 44.3, ratePctPerHour: 6 })),
    pinnedWk: bucket(week({ official: 61, value: 61.18, sigma: 0.026, lo: 61.15, hi: 61.22, ratePctPerHour: 2, wuPerPct: 5.41, spread: 0.04 })),
    countedFable: bucket(fable({ kind: 'window-start', official: 38, value: 38.42, sigma: 0.12, lo: 38.0, hi: 38.99, ratePctPerHour: 1.5 })),
    looseWk: bucket(week({ kind: 'lower-bound', official: 23, value: 23.6, sigma: 0.4, lo: 23.12, hi: 24.47, unseen: true })),
    calibrating5: bucket(five({ kind: 'official', official: 16, value: 16, sigma: undefined, lo: undefined, hi: undefined, samples: 0, wuPerPct: undefined, spread: undefined })),
    exact5: bucket(five({ kind: 'precise', official: 16.34, value: 16.34, sigma: undefined, lo: undefined, hi: undefined })),
    urgent5: bucket(five({ official: 92, value: 92.41, sigma: 0.012, lo: 92.38, hi: 92.44, ratePctPerHour: 14, resetIn: 50 * MIN })),
    limit5: bucket(five({ official: 100, value: 100, sigma: undefined, lo: undefined, hi: undefined, resetIn: 1 * HOUR + 12 * MIN })),
    idle5: bucket(five({ official: 0, value: 0, ratePctPerHour: 0 }), { resetsAt: null }),
  };
}
