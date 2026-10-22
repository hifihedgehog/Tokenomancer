import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../ledger';
import { BucketEstimator } from '../estimator';
import { UsageEvent } from '../logReader';
import { Family } from '../pricing';
import { PointsIndex } from '../ui/points';

const MIN = 60_000, HOUR = 3_600_000;
const PART = ['in', 'out', 'read'];
const Z = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

const mkEv = (t: number, family: Family, parts: [number, number, number]): UsageEvent =>
  ({ t, model: `claude-${family}`, family, wu: parts[0] + parts[1] + parts[2], parts, tokens: { ...Z, output: 1 }, first: true });

/** Four hours of mixed traffic polled every minute, with a limit that weighs tokens unlike API prices. */
function simulate(seed = 3, key = 'five_hour') {
  const r = rng(seed);
  const ledger = new Ledger(), est = new BucketEstimator(key);
  const T0 = Date.UTC(2026, 9, 21, 9), resetsAt = new Date(T0 + 5 * HOUR).toISOString();
  const weigh: Record<string, number> = { 'fable:read': 1.6, 'fable:out': 0.8, 'sonnet:read': 1.3 };
  let truth = 0, next = T0 + 5000;
  const events: UsageEvent[] = [];
  for (let t = T0; t < T0 + 4 * HOUR; t += 1000) {
    if (t >= next) {
      const family: Family = r() < 0.6 ? 'fable' : r() < 0.8 ? 'sonnet' : 'haiku';
      const k = family === 'fable' ? 1 : 0.25;
      const parts: [number, number, number] = [r() < 0.3 ? 0 : 0.01 * r() * k, 0.03 * r() * k, 0.03 * (0.5 + r()) * k];
      const e = mkEv(t, family, parts);
      ledger.add([e]);
      events.push(e);
      if (!key.includes('fable') || family === 'fable') truth += parts.reduce((s, p, i) => s + p * (weigh[`${family}:${PART[i]}`] ?? 1), 0) / 0.3;
      next = t + 8000 + r() * 30000;
    }
    if ((t - T0) % MIN === 0) est.onReading({ utilization: Math.floor(truth), resetsAt }, t + 1, ledger);
  }
  return { ledger, est, events, now: T0 + 4 * HOUR, T0 };
}

/** The estimator's own featuresOf([e]), re-implemented. */
function featuresOf(e: UsageEvent): Record<string, number> {
  const z: Record<string, number> = {};
  for (let i = 0; i < 3; i++) if (e.parts[i] > 0) { const k = `${e.family}:${PART[i]}`; z[k] = (z[k] ?? 0) + e.parts[i]; }
  return z;
}

test('pointsOf is bit-identical to the estimator\'s predictZ(featuresOf([e]))', () => {
  const { ledger, est, events } = simulate();
  const idx = new PointsIndex(est);
  idx.update(ledger);
  assert.ok(idx.calibrated && est.sampleCount > 20);
  assert.ok(est.features().some(([, g]) => Math.abs(g - 1) > 0.05), 'the fit has real corrections');
  const wpp = est.wuPerPct!;
  const fit = (est as any).fit();
  const direct = (e: UsageEvent) => {
    let p = 0;
    for (let i = 0; i < 3; i++) if (e.parts[i] > 0) p += (e.parts[i] / wpp) * est.factor(`${e.family}:${PART[i]}`);
    return p;
  };
  // A zero part, a missing family factor and an unknown family follow the same rules.
  const odd = [mkEv(1, 'fable', [0, 0.02, 0.01]), mkEv(2, 'opus', [0.01, 0.02, 0.03]), { ...mkEv(3, 'fable', [0.01, 0, 0]), family: 'zeta' as Family }];
  for (const e of [...events, ...odd]) {
    const p = idx.pointsOf(e);
    assert.equal(p, direct(e));
    assert.equal(p, (est as any).predictZ(featuresOf(e), fit.wpp, fit.g));
    const parts = idx.partsOf(e);
    assert.equal(parts[0] + parts[1] + parts[2], p, 'the parts add up to the same bits');
  }
});

test('since() agrees with the pace estimate() reports, at several moments', () => {
  const { ledger, est, now } = simulate();
  const idx = new PointsIndex(est);
  idx.update(ledger);
  for (const t of [now, now - 7 * MIN, now - 40 * MIN, now - 95 * MIN]) {
    const E = est.estimate(t, ledger);
    const mine = idx.since(t - 15 * MIN, t) * 4;
    assert.ok(Math.abs(mine - E.ratePctPerHour!) < 1e-9 * Math.max(1, E.ratePctPerHour!), `${mine} vs ${E.ratePctPerHour}`);
  }
  assert.equal(idx.since(now, now), 0);
  assert.equal(idx.since(now + MIN, now), 0);
});

test('est(t) = value − since(t) never decreases with t', () => {
  const { ledger, est, now, T0 } = simulate();
  const idx = new PointsIndex(est);
  idx.update(ledger);
  const v = est.estimate(now, ledger).value;
  let prev = -Infinity;
  for (let t = T0 - HOUR; t <= now; t += 37_000) {
    const x = v - idx.since(t, now);
    assert.ok(x >= prev - 1e-12);
    prev = x;
  }
  assert.ok(Math.abs(idx.cum(now) - idx.since(T0 - HOUR, now)) < 1e-9);
});

test('incremental updates equal a full rebuild, through appends, a resort, a prune and a refit', () => {
  const { ledger, est, events, now, T0 } = simulate();
  const L = new Ledger(), inc = new PointsIndex(est);
  const same = (exact: boolean) => {
    const full = new PointsIndex(est);
    full.update(L);
    for (let t = T0 - MIN; t <= now + MIN; t += 61_000) {
      if (exact) assert.equal(inc.cum(t), full.cum(t));
      else assert.ok(Math.abs(inc.since(t, now) - full.since(t, now)) < 1e-9, `since(${t})`);
    }
  };
  for (let i = 0; i < events.length; i += 50) { L.add(events.slice(i, i + 50)); inc.update(L); }
  same(true);
  inc.update(L); // nothing new: a no-op
  same(true);

  L.add([mkEv(T0 + 30 * MIN + 1, 'fable', [0.5, 0.5, 0.5])]); // lands mid-ledger
  assert.equal(L.resorts, 1);
  inc.update(L);
  same(true);

  L.prune(T0 + HOUR);
  inc.update(L);
  same(false);
  assert.equal(inc.cum(T0 + HOUR), 0, 'pruned events no longer count');

  // A refit (one more tick) changes the factors: the index rebuilds from them.
  const fitOf = () => JSON.stringify([est.wuPerPct, est.features()]);
  const before = fitOf();
  const nowR = now + 20 * MIN;
  let truth = est.toJSON().lastOfficial!;
  for (let t = now; t < nowR; t += MIN) {
    const e = mkEv(t + 500, 'fable', [0.02, 0.05, 0.08]);
    ledger.add([e]);
    L.add([e]);
    truth += 0.1;
    est.onReading({ utilization: Math.floor(truth + 0.4), resetsAt: est.toJSON().resetsAt }, t + 1000, ledger);
  }
  assert.notEqual(fitOf(), before, 'the fit changed');
  inc.update(L);
  same(true);

  est.resetCalibration();
  inc.update(L);
  assert.equal(inc.calibrated, false);
  assert.equal(inc.since(T0, nowR), 0);
  assert.equal(inc.pointsOf(events[0]), 0);
});

test('a large prune compacts the arrays without changing any count', () => {
  const est = new BucketEstimator('five_hour', { samples: [{ z: { 'fable:out': 0.5, 'fable:read': 0.2 }, d: 1 }, { z: { 'fable:out': 0.3, 'fable:read': 0.6 }, d: 1 }, { z: { 'fable:out': 0.4 }, d: 1 }] });
  const L = new Ledger();
  L.add(Array.from({ length: 12_000 }, (_, i) => mkEv(i * 1000, 'fable', [0, 0.01 + (i % 7) * 0.001, 0.02])));
  const idx = new PointsIndex(est);
  idx.update(L);
  L.prune(8000 * 1000);
  idx.update(L);
  const full = new PointsIndex(est);
  full.update(L);
  for (let t = 7000 * 1000; t <= 12_001 * 1000; t += 333_000) {
    assert.ok(Math.abs(idx.since(t, 12_001_000) - full.since(t, 12_001_000)) < 1e-9);
  }
  L.add([mkEv(13_000_000, 'fable', [0, 0.05, 0])]);
  idx.update(L);
  assert.ok(Math.abs(idx.since(12_500_000, 13_000_001) - idx.pointsOf(mkEv(0, 'fable', [0, 0.05, 0]))) < 1e-12);
});

test('a per-model limit counts only that model', () => {
  const { ledger, est, events, now } = simulate(5, 'seven_day_fable');
  const idx = new PointsIndex(est);
  idx.update(ledger);
  assert.ok(idx.calibrated);
  const fable = events.filter(e => e.family === 'fable').reduce((s, e) => s + idx.pointsOf(e), 0);
  assert.ok(Math.abs(idx.since(-Infinity, now + 1) - fable) < 1e-9);
  assert.ok(events.some(e => e.family !== 'fable'));
});
