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
const PART = ['in', 'out', 'read'];
const mkEv = (t: number, family: Family, parts: [number, number, number]): UsageEvent =>
  ({ t, model: `claude-${family}`, family, wu: parts[0] + parts[1] + parts[2], parts, tokens: { ...Z, output: 1 } });

interface SimOpts {
  key?: string;
  costPerPct: number;                   // true API-equivalent $ per point (at API price ratios)
  trueFactor?: Record<string, number>;  // how the real limit weighs each feature vs API prices
  rounding?: Rounding;
  precise?: boolean;
  unseen?: { atMin: number; pct: number }[]; // usage on another device (per window)
  familyFilter?: Family;
  windows?: number;                     // consecutive 5-hour windows; measure in the last
  pollSec?: number;
  seed?: number;
}

/**
 * Realistic Claude Code traffic: a request every ~20 s with gaps, each with a
 * large cached prompt, some fresh input and a variable reply. The work mode and
 * model mix change every ~40 minutes, so the weights are identifiable.
 */
function simulate(o: SimOpts) {
  const r = rng(o.seed ?? 7);
  const key = o.key ?? 'five_hour';
  const windows = o.windows ?? 3;
  const pollMs = (o.pollSec ?? 60) * 1000;
  const f = (k: string) => o.trueFactor?.[k] ?? 1;
  const ledger = new Ledger();
  const est = new BucketEstimator(key);
  const errs: number[] = [], naive: number[] = [], sig: number[] = [];
  let truePct = 0;

  for (let w = 0; w < windows; w++) {
    const T0 = Date.UTC(2026, 9, 21, 0, 0, 0) + w * 5 * 3600_000;
    const weekly = key.startsWith('seven_day');
    const resetsAt = weekly ? new Date(Date.UTC(2026, 9, 21) + 7 * 864e5).toISOString() : new Date(T0 + 5 * 3600_000).toISOString();
    if (!weekly) truePct = 0;
    let lastOfficial = Math.floor(truePct);
    let mode = 0, fam: Family = 'fable';
    const unseen = [...(o.unseen ?? [])];
    let nextReq = T0 + 5000;
    for (let t = T0; t < T0 + 4.5 * 3600_000; t += 1000) {
      if ((t - T0) % (40 * 60_000) === 0) { mode = Math.floor(r() * 3); fam = r() < 0.65 ? 'fable' : 'sonnet'; }
      if (t >= nextReq) {
        const big = fam === 'fable' ? 1 : 0.2; // sonnet is ~5x cheaper per token
        const read = (mode === 0 ? 0.04 : mode === 1 ? 0.015 : 0.025) * (0.5 + r()) * big;  // cache reads
        const out = (mode === 1 ? 0.08 : mode === 0 ? 0.01 : 0.03) * (0.3 + r() * 1.4) * big; // reply
        const inp = (mode === 2 ? 0.03 : 0.008) * (0.3 + r()) * big;                           // fresh input + writes
        const parts: [number, number, number] = [inp, out, read];
        ledger.add([mkEv(t, fam, parts)]);
        if (!o.familyFilter || o.familyFilter === fam) {
          truePct += parts.reduce((s, p, i) => s + p * f(`${fam}:${PART[i]}`), 0) / o.costPerPct;
        }
        nextReq = t + (r() < 0.1 ? 120_000 + r() * 600_000 : 8000 + r() * 30_000); // occasional breaks
      }
      while (unseen.length && t >= T0 + unseen[0].atMin * 60_000) truePct += unseen.shift()!.pct;
      if ((t - T0) % pollMs === 0) {
        const off = o.precise ? Math.round(truePct * 1000) / 1000
          : o.rounding === 'round' ? Math.round(truePct) : Math.floor(truePct);
        lastOfficial = off;
        est.onReading({ utilization: off, resetsAt }, t + 1, ledger, o.rounding ?? 'floor');
      }
      // measure at random moments in the last window, after its first tick
      if (w === windows - 1 && t > T0 + 20 * 60_000 && r() < 0.01) {
        const e = est.estimate(t, ledger, o.rounding ?? 'floor');
        errs.push(Math.abs(e.value - truePct));
        sig.push(e.sigma ?? 1);
        naive.push(Math.abs((o.rounding === 'round' || o.precise ? lastOfficial : lastOfficial + 0.5) - truePct));
        const floorLo = o.precise ? lastOfficial : o.rounding === 'round' ? lastOfficial - 0.5 : lastOfficial;
        assert.ok(e.value >= floorLo - 1e-9, 'never below what the official number allows');
      }
    }
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sorted = [...errs].sort((a, b) => a - b);
  const res = {
    mae: mean(errs), p90: sorted[Math.floor(sorted.length * 0.9)], naiveMae: mean(naive),
    within05: errs.filter(e => e <= 0.05).length / errs.length,
    meanSigma: mean(sig), samples: est.sampleCount, est, truePct,
  };
  if (process.env.SIMLOG) {
    console.log(JSON.stringify({ key, ...o, est: undefined, n: errs.length, mae: +res.mae.toFixed(4), p90: +res.p90.toFixed(3),
      within05: +res.within05.toFixed(2), naive: +res.naiveMae.toFixed(3), sigma: +res.meanSigma.toFixed(3), samples: res.samples,
      factors: Object.fromEntries(est.features().map(([k, g]) => [k, +g.toFixed(2)])) }));
  }
  return res;
}

// How a real limit might weigh things differently from API prices.
const MISMATCH = { 'fable:read': 3, 'fable:out': 0.7, 'sonnet:read': 2, 'sonnet:out': 0.8 };

test('weights match API prices: hundredths-level accuracy', () => {
  const s = simulate({ costPerPct: 2 });
  assert.ok(s.mae < 0.02, `mae ${s.mae}`);
  assert.ok(s.p90 < 0.035, `p90 ${s.p90}`);
  assert.ok(s.mae < s.naiveMae / 10, `mae ${s.mae} vs naive ${s.naiveMae}`);
});

test('real weights differ from API prices: learned corrections stay within a few hundredths', () => {
  const s = simulate({ costPerPct: 2, trueFactor: MISMATCH, windows: 6 });
  assert.ok(s.mae < 0.045, `mae ${s.mae}`);
  assert.ok(s.p90 < 0.09, `p90 ${s.p90}`);
  // the true ratio of cache-read to output weight is 3 / 0.7 ≈ 4.3 (API prices say 1)
  const ratio = s.est.factor('fable:read') / s.est.factor('fable:out');
  assert.ok(ratio > 3.5 && ratio < 5, `learned read/out ratio ${ratio}`);
});

test('round rounding mode', () => {
  const s = simulate({ costPerPct: 2, rounding: 'round' });
  assert.ok(s.mae < 0.03, `mae ${s.mae}`);
});

test('slower polling costs precision but stays well ahead of the official number', () => {
  const s = simulate({ costPerPct: 2, pollSec: 300 });
  assert.ok(s.mae < 0.08, `mae ${s.mae}`);
  assert.ok(s.mae < s.naiveMae / 3, `mae ${s.mae} vs naive ${s.naiveMae}`);
});

test('usage on another device is rejected from calibration and clamped', () => {
  const s = simulate({ costPerPct: 2, unseen: [{ atMin: 90, pct: 3 }, { atMin: 200, pct: 1.5 }] });
  assert.ok(s.mae < 0.1, `mae ${s.mae}`);
  const clean = simulate({ costPerPct: 2 });
  assert.ok(Math.abs(s.est.wuPerPct! - clean.est.wuPerPct!) / clean.est.wuPerPct! < 0.1, 'calibration not polluted');
});

test('per-model bucket counts only that model', () => {
  const s = simulate({ costPerPct: 1.5, key: 'seven_day_fable', familyFilter: 'fable' });
  assert.ok(s.mae < 0.03, `mae ${s.mae}`);
});

test('reported uncertainty is honest (covers most errors)', () => {
  const s = simulate({ costPerPct: 2, trueFactor: MISMATCH, seed: 11 });
  assert.ok(s.mae < s.meanSigma * 1.5, `mae ${s.mae} vs sigma ${s.meanSigma}`);
});

test('precise endpoint values are used directly', () => {
  const s = simulate({ costPerPct: 2, precise: true });
  assert.ok(s.mae < 0.02, `mae ${s.mae}`);
});

test('a window reset drops the anchor but keeps calibration', () => {
  const ledger = new Ledger();
  const z = { 'fable:out': 0.5 };
  const est = new BucketEstimator('five_hour', { samples: [{ z, d: 1 }, { z, d: 1 }, { z, d: 1 }] });
  const t = Date.UTC(2026, 9, 21, 20, 0, 0);
  est.onReading({ utilization: 40, resetsAt: new Date(t + 3600_000).toISOString() }, t, ledger);
  const t2 = t + 3600_000 + 60_000;
  est.onReading({ utilization: 0, resetsAt: new Date(t2 + 5 * 3600_000 - 60_000).toISOString() }, t2, ledger);
  ledger.add([mkEv(t2 + 1000, 'fable', [0, 0.25, 0])]);
  const e = est.estimate(t2 + 5000, ledger);
  assert.ok(Math.abs(est.wuPerPct! - 0.5) < 1e-9);
  assert.ok(Math.abs(e.value - 0.5) < 0.02, `value ${e.value}`);
  assert.equal(e.kind, 'window-start');
});

test('before any calibration, only the official number is shown', () => {
  const est = new BucketEstimator('five_hour');
  est.onReading({ utilization: 15, resetsAt: new Date(Date.now() + 3600_000).toISOString() }, Date.now(), new Ledger());
  const e = est.estimate(Date.now(), new Ledger());
  assert.equal(e.kind, 'official');
  assert.equal(e.value, 15);
});

test('old-format saved state is discarded safely', () => {
  const est = new BucketEstimator('five_hour', { samples: [0.5, 0.5] as any });
  assert.equal(est.sampleCount, 0);
});
