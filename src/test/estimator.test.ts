import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../ledger';
import { BucketEstimator, Rounding } from '../estimator';
import { UsageEvent } from '../logReader';
import { Family } from '../pricing';

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

const Z = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
const ev = (t: number, wu: number, family: Family = 'fable'): UsageEvent => ({ t, model: `claude-${family}`, family, wu, tokens: { ...Z, output: 1 } });

interface SimOpts {
  costPerPct: number;
  key?: string;
  rounding?: Rounding;
  precise?: boolean;
  unseenAt?: number;     // minutes into the window
  unseenPct?: number;
  familyFilter?: Family; // only these events count toward the bucket
}

/** Simulates 4 hours of Claude Code use with 60-second polling. Returns errors after warm-up. */
function simulate(o: SimOpts) {
  const r = rng(42);
  const key = o.key ?? 'five_hour';
  const T0 = Date.UTC(2026, 9, 21, 18, 0, 0);
  const resetsAt = new Date(T0 + 5 * 3600_000).toISOString();
  const ledger = new Ledger();
  const est = new BucketEstimator(key);
  let truePct = 0;
  let unseenDone = false;
  const errs: number[] = [];
  const naive: number[] = [];
  let lastOfficial = 0;
  const step = 20_000; // a request every 20 s
  for (let t = T0; t < T0 + 4 * 3600_000; t += step) {
    // bursty usage: some minutes idle
    if (r() < 0.75) {
      const fam: Family = r() < 0.8 ? 'fable' : 'sonnet';
      const wu = 0.004 + r() * 0.03;
      ledger.add([ev(t + r() * 1000, wu, fam)]);
      if (!o.familyFilter || o.familyFilter === fam) truePct += wu / o.costPerPct;
    }
    if (o.unseenAt !== undefined && !unseenDone && t >= T0 + o.unseenAt * 60_000) {
      truePct += o.unseenPct!; // used on another device: no local events
      unseenDone = true;
    }
    if ((t - T0) % 60_000 === 0) {
      const off = o.precise ? Math.round(truePct * 1000) / 1000
        : o.rounding === 'round' ? Math.round(truePct) : Math.floor(truePct);
      lastOfficial = off;
      est.onReading({ utilization: off, resetsAt }, t + 2000, ledger, o.rounding ?? 'floor');
    }
    // measure halfway between polls, after 75 min of warm-up
    if ((t - T0) % 60_000 === 40_000 && t > T0 + 75 * 60_000) {
      const e = est.estimate(t, ledger, o.rounding ?? 'floor');
      errs.push(Math.abs(e.value - truePct));
      naive.push(Math.abs((o.rounding === 'round' ? lastOfficial : lastOfficial + 0.5) - truePct));
      assert.ok(o.precise || e.value >= lastOfficial - (o.rounding === 'round' ? 0.5 : 0) - 1e-9, 'never below what the official number allows');
    }
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  if (process.env.SIMLOG) console.log(JSON.stringify({ key, rounding: o.rounding, unseen: o.unseenPct, precise: o.precise, n: errs.length, mae: +mean(errs).toFixed(4), max: +Math.max(...errs).toFixed(3), naive: +mean(naive).toFixed(3), wpp: est.wuPerPct, samples: est.toJSON().samples.length, truePct: +truePct.toFixed(2) }));
  return { mae: mean(errs), max: Math.max(...errs), naiveMae: mean(naive), est, truePct };
}

test('floor rounding: tenth-of-a-percent accuracy, ~5x better than the official number', () => {
  const s = simulate({ costPerPct: 0.5 });
  assert.ok(Math.abs(s.est.wuPerPct! - 0.5) / 0.5 < 0.05, `calibrated 1% = ${s.est.wuPerPct}`);
  assert.ok(s.mae < 0.06, `mae ${s.mae}`);
  assert.ok(s.max < 0.2, `max ${s.max}`);
  assert.ok(s.mae < s.naiveMae / 4, `mae ${s.mae} vs naive ${s.naiveMae}`);
});

test('round rounding mode', () => {
  const s = simulate({ costPerPct: 0.5, rounding: 'round' });
  assert.ok(s.mae < 0.06, `mae ${s.mae}`);
});

test('usage on another device is rejected from calibration and clamped in the estimate', () => {
  const s = simulate({ costPerPct: 0.5, unseenAt: 150, unseenPct: 3 });
  assert.ok(Math.abs(s.est.wuPerPct! - 0.5) / 0.5 < 0.08, `calibrated 1% = ${s.est.wuPerPct}`);
  assert.ok(s.mae < 0.1, `mae ${s.mae}`);
});

test('per-model bucket counts only that model', () => {
  const s = simulate({ costPerPct: 0.8, key: 'seven_day_fable', familyFilter: 'fable' });
  assert.ok(Math.abs(s.est.wuPerPct! - 0.8) / 0.8 < 0.05, `calibrated 1% = ${s.est.wuPerPct}`);
  assert.ok(s.mae < 0.06, `mae ${s.mae}`);
});

test('precise endpoint values are shown as-is', () => {
  const s = simulate({ costPerPct: 0.5, precise: true });
  assert.ok(s.mae < 0.03, `mae ${s.mae}`);
});

test('a window reset drops the anchor but keeps calibration', () => {
  const ledger = new Ledger();
  const est = new BucketEstimator('five_hour', { samples: [0.5, 0.5, 0.5] });
  const t = Date.UTC(2026, 9, 21, 20, 0, 0);
  est.onReading({ utilization: 40, resetsAt: new Date(t + 3600_000).toISOString() }, t, ledger);
  const t2 = t + 3600_000 + 60_000;
  est.onReading({ utilization: 0, resetsAt: new Date(t2 + 5 * 3600_000 - 60_000).toISOString() }, t2, ledger);
  ledger.add([ev(t2 + 1000, 0.25)]);
  const e = est.estimate(t2 + 5000, ledger);
  assert.equal(est.wuPerPct, 0.5);
  assert.ok(Math.abs(e.value - 0.5) < 0.01, `value ${e.value}`);
  assert.equal(e.kind, 'window-start');
});

test('before any calibration, only the official number is shown', () => {
  const est = new BucketEstimator('five_hour');
  est.onReading({ utilization: 15, resetsAt: new Date(Date.now() + 3600_000).toISOString() }, Date.now(), new Ledger());
  const e = est.estimate(Date.now(), new Ledger());
  assert.equal(e.kind, 'official');
  assert.equal(e.value, 15);
});
