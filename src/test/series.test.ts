import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../ledger';
import { BucketEstimator, Rounding } from '../estimator';
import { UsageEvent } from '../logReader';
import { Family } from '../pricing';
import { PointsIndex } from '../ui/points';
import { EstimateHistory } from '../ui/history';
import { buildDetail, DetailInput } from '../ui/series';
import type { HistoryPoint } from '../ui/types';

const MIN = 60_000, HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 22, 9);
const Z = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
const mkEv = (t: number, parts: [number, number, number], family: Family = 'fable', first = true): UsageEvent =>
  ({ t, model: `claude-${family}`, family, wu: parts[0] + parts[1] + parts[2], parts, tokens: { ...Z, input: 3, output: 10, cacheRead: 100 }, first });

// A fit where 1 point costs exactly $0.5 of Fable output (no learned corrections).
const CALIBRATED = { samples: [{ z: { 'fable:out': 0.5 }, d: 1 }, { z: { 'fable:out': 1 }, d: 2 }, { z: { 'fable:out': 0.25 }, d: 0.5 }] };

/**
 * One event per minute (at :30) worth `pts` points, a poll every minute on the minute, the
 * official number = floor(points so far), and the estimate recorded at every reading.
 */
function scenario(o: { key?: string; pts?: number; minutes?: number; rounding?: Rounding; failed?: number[]; calibrated?: boolean; precise?: boolean } = {}) {
  const key = o.key ?? 'five_hour', pts = o.pts ?? 0.1, minutes = o.minutes ?? 180, rounding = o.rounding ?? 'floor';
  const len = key.startsWith('seven_day') ? 7 * 24 * HOUR : 5 * HOUR;
  const resetsAt = new Date(T0 + len).toISOString();
  const ledger = new Ledger(), est = new BucketEstimator(key, o.calibrated === false ? undefined : structuredClone(CALIBRATED));
  const history = new EstimateHistory();
  const polls: { t: number; ok: boolean }[] = [];
  const failed = new Set((o.failed ?? []).map(m => T0 + m * MIN));
  for (let k = 0; k <= minutes; k++) {
    const t = T0 + k * MIN;
    if (k > 0) {
      const ok = !failed.has(t);
      polls.push({ t, ok });
      if (ok) {
        const v = o.precise ? Math.round(k * pts * 1000) / 1000 : Math.floor(k * pts + 1e-9);
        est.onReading({ utilization: v, resetsAt }, t, ledger, rounding);
        history.record(key, t, est.estimate(t, ledger, rounding), true);
      }
    }
    if (k < minutes) ledger.add([mkEv(t + 30_000, [0, pts * 0.5, 0])]);
  }
  const now = T0 + minutes * MIN;
  const e = est.estimate(now, ledger, rounding);
  const a: DetailInput = { key, est, e, idx: new PointsIndex(est), ledger, history: history.points(key, T0, now), polls, rounding, now };
  return { a, est, ledger, now, e, resetsAt };
}

test('the window: lanes from reading runs and the reconstruction anchored at now', () => {
  const { a, est, now, e } = scenario();
  const before = JSON.stringify(est.toJSON().readings);
  const d = buildDetail(a);
  assert.equal(JSON.stringify(est.toJSON().readings), before, 'the estimator is left untouched');
  const w = d.window;
  assert.deepEqual([w.from, w.to, w.now, w.calibrated], [T0, T0 + 5 * HOUR, now, true]);
  // official v from minute 10v (first reading of the run) to 10v + 9 (last); 18 only at now
  assert.equal(w.lanes.length, 19);
  assert.deepEqual(w.lanes[0], { from: T0 + MIN, to: T0 + 9 * MIN, lo: 0, hi: 1 });
  assert.deepEqual(w.lanes[5], { from: T0 + 50 * MIN, to: T0 + 59 * MIN, lo: 5, hi: 6 });
  assert.deepEqual(w.lanes[18], { from: now, to: now, lo: 18, hi: 19 });

  const s = w.est;
  assert.equal(s.t.length, 400);
  assert.deepEqual([s.t[0], s.t[399]], [T0, now]);
  assert.equal(s.v[399], e.value);
  assert.equal(s.s[399], e.sigma);
  for (let i = 1; i < 400; i++) {
    assert.ok(s.t[i] > s.t[i - 1] && s.v[i] >= s.v[i - 1] - 1e-12 && s.s[i] <= s.s[i - 1] + 1e-12, `vertex ${i}`);
  }
  // v(t) = value − points since t; σ(t) = σ + spread · points since t
  const i = 200, q = a.idx.since(s.t[i], now);
  assert.ok(Math.abs(s.v[i] - (e.value - q)) < 1e-12);
  assert.ok(Math.abs(s.s[i] - (e.sigma! + e.spread! * q)) < 1e-12);
  assert.ok(Math.abs(s.v[0] - (e.value - 18)) < 0.05, 'local logs explain the whole window');
});

test('round mode and precise readings shape the lanes', () => {
  const round = buildDetail(scenario({ rounding: 'round' }).a);
  assert.deepEqual(round.window.lanes[0], { from: T0 + MIN, to: T0 + 9 * MIN, lo: 0, hi: 0.5 }, 'clamped at 0');
  assert.deepEqual(round.window.lanes[5], { from: T0 + 50 * MIN, to: T0 + 59 * MIN, lo: 4.5, hi: 5.5 });
  assert.ok(round.zoom.edges.every(x => Math.abs(x % 1) === 0.5));
  assert.ok(round.zoom.ticks.every(k => Math.abs(k.edge % 1) === 0.5));

  const precise = buildDetail(scenario({ precise: true, minutes: 30 }).a);
  assert.ok(precise.window.lanes.every(l => l.lo === l.hi), 'exact readings have no width');
  assert.deepEqual(precise.window.lanes.slice(0, 2).map(l => l.lo), [0.1, 0.2]);
  assert.deepEqual(precise.zoom.ticks.map(k => [k.from, k.to, k.edge]), [[T0 + 9 * MIN, T0 + 10 * MIN, 1], [T0 + 19 * MIN, T0 + 20 * MIN, 2], [T0 + 29 * MIN, T0 + 30 * MIN, 3]]);
});

test('the zoom: span from the second-most-recent tick, whole lanes, ticks, polls and the recorded history', () => {
  const { a, now, e } = scenario({ failed: [165] });
  const z = buildDetail(a).zoom;
  // ticks to 17 (169–170 min) and 18 (179–180): 11 min back, clamped to 30 min
  assert.deepEqual([z.from, z.to], [now - 30 * MIN, now]);
  assert.deepEqual([z.yMin, z.yMax], [15, 19]);
  assert.deepEqual(z.edges, [15, 16, 17, 18, 19]);
  assert.deepEqual(z.lanes.map(l => [l.lo, (l.from - T0) / MIN, (l.to - T0) / MIN]), [[15, 150, 159], [16, 160, 169], [17, 170, 179], [18, 180, 180]]);
  assert.deepEqual(z.ticks.map(k => [(k.from - T0) / MIN, (k.to - T0) / MIN, k.edge]), [[159, 160, 16], [169, 170, 17], [179, 180, 18]]);
  assert.deepEqual(z.failed, [T0 + 165 * MIN]);
  assert.deepEqual(z.polls.map(t => (t - T0) / MIN), Array.from({ length: 31 }, (_, i) => 150 + i).filter(m => m !== 165));

  const h = z.hist;
  assert.equal(h.t[0], z.from, 'the point before the span is carried to its start');
  assert.equal(h.t[h.t.length - 1], now);
  assert.equal(h.v[h.v.length - 1], e.value);
  assert.equal(h.s[h.s.length - 1], e.sigma);
  assert.ok(h.t.every((t, i) => i === 0 || t >= h.t[i - 1]));
  assert.ok(h.v.every(v => v >= z.yMin && v <= z.yMax));
  assert.ok(h.flat.every(f => !f));
  for (const k of ['t', 'v', 's', 'lo', 'hi', 'flat'] as const) assert.equal(h[k].length, h.t.length);
  assert.ok(h.lo.every((lo, i) => lo <= h.v[i] + 1e-9 && h.hi[i] >= h.v[i] - 1e-9));
});

test('fast use: the span shrinks to the six newest lanes instead of squashing them', () => {
  const { a, now } = scenario({ pts: 1, minutes: 60 });
  const z = buildDetail(a).zoom;
  assert.equal(z.yMax - z.yMin, 6);
  assert.ok(z.from > now - 30 * MIN && (now - z.from) % MIN === 0, `${(now - z.from) / MIN} min`);
  assert.ok(z.hist.v.every(v => v >= z.yMin && v <= z.yMax));
  assert.ok(z.lanes.length > 0 && z.lanes.every(l => l.lo >= z.yMin && l.hi <= z.yMax));
  assert.ok(z.ticks.length >= 5 && z.ticks.every(k => k.edge >= z.yMin && k.edge <= z.yMax && k.from >= z.from));
});

test('slow limits zoom out to 6 hours, thin the history to 240 points and mark loose stretches flat', () => {
  const { a, now, e } = scenario({ key: 'seven_day', pts: 0.001, minutes: 600 }); // no tick at all
  const history: HistoryPoint[] = [];
  for (let t = now - 7 * HOUR; t < now; t += 30_000) {
    const kind = t < now - 5 * HOUR ? 'official' : t < now - 3 * HOUR ? 'lower-bound' : 'anchored';
    history.push({ t, v: 0.4, s: 0.05, lo: 0.3, hi: 0.6, kind, official: 0 });
  }
  const z = buildDetail({ ...a, history }).zoom;
  assert.deepEqual([z.from, z.to], [now - 6 * HOUR, now]);
  assert.ok(z.hist.t.length <= 240 && z.hist.t.length > 150, `${z.hist.t.length}`);
  assert.equal(z.hist.t[0], now - 5 * HOUR, 'readings-only points (calibrating) are left out');
  assert.equal(z.hist.t[z.hist.t.length - 1], now);
  assert.equal(z.hist.v[z.hist.v.length - 1], e.value);
  const flat = z.hist.t.filter((t, i) => z.hist.flat[i]);
  assert.ok(flat.length > 50 && flat.every(t => t < now - 3 * HOUR));
  assert.deepEqual([z.yMin, z.yMax, z.ticks.length], [0, 1, 0]);
});

test('one old tick sets the span', () => {
  const { a, now } = scenario({ key: 'seven_day', pts: 0.002, minutes: 600 }); // ticks to 1 at minute 500
  assert.deepEqual(buildDetail(a).zoom.from, now - 2 * HOUR);
});

test('the zoom spans the whole window when it is younger than the span', () => {
  const { a } = scenario({ minutes: 12 });
  const z = buildDetail(a).zoom;
  assert.equal(z.from, T0);
});

test('where it went: points by model and token type, requests counted once', () => {
  const { a, now, ledger } = scenario({ minutes: 60 });
  ledger.add([mkEv(T0 + 10 * MIN + 1, [0.05, 0, 0.1], 'fable', false), mkEv(T0 + 20 * MIN, [0, 0.5, 0], 'sonnet')]);
  const m = buildDetail(a).mix;
  assert.equal(m.unit, 'pts');
  assert.deepEqual([m.from, m.to], [T0, now]);
  assert.equal(m.requests, 61, '60 fable requests and one sonnet; the streamed line is not a request');
  assert.deepEqual(m.byFamily.map(r => [r.family, r.requests]), [['fable', 60], ['sonnet', 1]]);
  const fable = m.byFamily[0];
  assert.ok(Math.abs(fable.value - (6 + 0.3)) < 1e-6, `${fable.value}`); // 60 × 0.1 + (0.05 + 0.1) / 0.5
  assert.ok(Math.abs(fable.usd - (60 * 0.05 + 0.15)) < 1e-9);
  assert.deepEqual(m.byPart.map(p => p.part), ['in', 'out', 'read']);
  assert.ok(Math.abs(m.byPart[0].value - 0.1) < 1e-6 && Math.abs(m.byPart[2].value - 0.2) < 1e-6);
  const total = m.byPart.reduce((s, p) => s + p.value, 0);
  assert.ok(Math.abs(total - m.byFamily.reduce((s, r) => s + r.value, 0)) < 1e-9);
  assert.ok(Math.abs(m.usd - (3.15 + 0.5)) < 1e-9);
  assert.deepEqual(m.tokens, { input: 186, output: 620, cacheWrite: 0, cacheRead: 6200 });
  assert.equal(m.wuPerPct, 0.5);
});

test('before calibration: lanes only, and the mix in dollars', () => {
  const { a } = scenario({ calibrated: false, minutes: 15 }); // one tick: armed, no sample yet
  const d = buildDetail(a);
  assert.equal(a.est.sampleCount, 0);
  assert.equal(d.window.calibrated, false);
  assert.deepEqual(d.window.est, { t: [], v: [], s: [] });
  assert.equal(d.window.lanes.length, 2);
  assert.deepEqual(d.zoom.hist.t, [], 'nothing was estimated yet');
  assert.deepEqual([d.zoom.ticks.length, d.zoom.lanes.length, d.zoom.yMin, d.zoom.yMax], [1, 2, 0, 2]);
  assert.equal(d.mix.unit, 'usd');
  assert.ok(Math.abs(d.mix.byFamily[0].value - 15 * 0.05) < 1e-9);
  assert.equal(d.mix.wuPerPct, undefined);
});

test('after the reset passes, the old estimate is not drawn', () => {
  const { a, now } = scenario({ minutes: 120 });
  const late = now + 4 * HOUR; // reset at T0 + 5 h
  const d = buildDetail({ ...a, now: late });
  assert.deepEqual([d.window.from, d.window.to, d.window.calibrated], [late - 5 * HOUR, late, false]);
  assert.deepEqual(d.window.est.t, []);
  assert.ok(d.window.lanes.every(l => l.from >= late - 5 * HOUR));
  assert.ok(!d.zoom.hist.t.includes(late));
});

test('polls are sorted and a reading logged twice counts once', () => {
  const { a, now } = scenario({ minutes: 40 });
  const polls = [...a.polls].reverse().concat(a.polls.map(p => ({ t: p.t + 800, ok: p.ok })));
  const z = buildDetail({ ...a, polls }).zoom;
  assert.deepEqual(z.polls, a.polls.filter(p => p.t >= z.from).map(p => p.t));
  assert.equal(z.polls[z.polls.length - 1], now);
});
