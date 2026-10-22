import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Estimate } from '../estimator';
import { EstimateHistory } from '../ui/history';

const MIN = 60_000;
const T = Date.UTC(2026, 9, 22, 12);
const est = (o: Partial<Estimate> = {}): Estimate =>
  ({ key: 'five_hour', official: 61, value: 61.18, kind: 'anchored', sigma: 0.03, lo: 61.12, hi: 61.25, samples: 12, ...o });

test('records at most once a minute unless forced or the kind or official number changed', () => {
  const h = new EstimateHistory();
  assert.equal(h.record('five_hour', T, est()), true);
  assert.equal(h.record('five_hour', T + 20_000, est({ value: 61.2 })), false);
  assert.equal(h.record('five_hour', T + 30_000, est({ value: 61.21 }), true), true, 'forced: an applied reading');
  assert.equal(h.record('five_hour', T + 40_000, est({ official: 62, value: 62.01 })), true, 'official changed');
  assert.equal(h.record('five_hour', T + 45_000, est({ official: 62, kind: 'window-start', value: 62.02 })), true, 'kind changed');
  assert.equal(h.record('five_hour', T + 50_000, est({ official: 62, kind: 'window-start', value: 62.03 })), false);
  assert.equal(h.record('five_hour', T + 45_000 + MIN, est({ official: 62, kind: 'window-start', value: 62.04 })), true);
  assert.deepEqual(h.points('five_hour', 0, Infinity).map(p => p.v), [61.18, 61.21, 62.01, 62.02, 62.04]);
  assert.equal(h.record('seven_day', T + 20_000, est({ key: 'seven_day' })), true, 'keys are independent');
});

test('keeps what a point needs, and nothing that is not a number', () => {
  const h = new EstimateHistory();
  h.record('k', T, est({ kind: 'lower-bound', sigma: undefined, lo: undefined, hi: Infinity }));
  assert.deepEqual(h.points('k', 0, Infinity), [{ t: T, v: 61.18, s: 0, kind: 'lower-bound', official: 61 }]);
  assert.equal(h.record('k', T + MIN, est({ value: NaN })), false);
  assert.equal(h.record('k', NaN, est()), false);
  assert.equal(h.record('k', T + MIN, est({ kind: 'nonsense' as any })), false);
});

test('a run of identical estimates keeps only its ends', () => {
  const h = new EstimateHistory();
  for (let i = 0; i < 120; i++) h.record('k', T + i * MIN, est());
  h.record('k', T + 120 * MIN, est({ value: 61.3 }));
  assert.deepEqual(h.points('k', 0, Infinity).map(p => (p.t - T) / MIN), [0, 119, 120]);
});

test('an out-of-order point is slotted in; the same moment is replaced', () => {
  const h = new EstimateHistory();
  h.record('k', T, est({ value: 1 }));
  h.record('k', T + 2 * MIN, est({ value: 3 }));
  assert.equal(h.record('k', T + MIN, est({ value: 2 })), true);
  h.record('k', T + 2 * MIN, est({ value: 4 }));
  assert.deepEqual(h.points('k', 0, Infinity).map(p => p.v), [1, 2, 4]);
});

test('points() returns copies within [from, to]', () => {
  const h = new EstimateHistory();
  for (let i = 0; i < 10; i++) h.record('k', T + i * MIN, est({ value: 60 + i }));
  const pts = h.points('k', T + 2 * MIN, T + 4 * MIN);
  assert.deepEqual(pts.map(p => p.v), [62, 63, 64]);
  pts[0].v = 0;
  assert.equal(h.points('k', T + 2 * MIN, T + 2 * MIN)[0].v, 62);
  assert.deepEqual(h.points('nope', 0, Infinity), []);
});

test('prune drops old points and caps each key at 1000', () => {
  const h = new EstimateHistory();
  for (let i = 0; i < 1500; i++) h.record('k', T + i * MIN, est({ value: i }));
  assert.equal(h.points('k', 0, Infinity).length, 1000, 'capped as it records');
  h.prune(T + 1400 * MIN);
  assert.deepEqual(h.points('k', 0, Infinity).map(p => p.v), Array.from({ length: 100 }, (_, i) => 1400 + i));
  h.prune(T + 2000 * MIN);
  assert.deepEqual(h.keys(), []);
});

test('toJSON and fromJSON round-trip, and junk is dropped instead of failing', () => {
  const h = new EstimateHistory();
  h.record('five_hour', T, est({ value: 61.123456789 }));
  h.record('five_hour', T + MIN, est({ kind: 'window-start', sigma: 0.21, lo: undefined, hi: undefined }));
  h.record('seven_day', T, est({ key: 'seven_day', value: 41.3 }));
  const json = JSON.parse(JSON.stringify(h.toJSON()));
  assert.equal(json.five_hour[0].v, 61.1235, 'saved to 1e-4 points');
  const back = EstimateHistory.fromJSON(json);
  assert.deepEqual(back.toJSON(), json);
  assert.deepEqual(back.points('five_hour', 0, Infinity)[1], { t: T + MIN, v: 61.18, s: 0.21, kind: 'window-start', official: 61 });

  for (const junk of [undefined, null, 42, 'x', [], [1, 2], { k: 'nope' }, { k: [null, 1, 'a', {}] }]) {
    assert.deepEqual(EstimateHistory.fromJSON(junk).keys(), [], JSON.stringify(junk));
  }
  const mixed = EstimateHistory.fromJSON({
    k: [
      { t: T + MIN, v: 2, s: 0.1, kind: 'anchored', official: 1 },
      { t: T, v: 1, s: -3, kind: 'anchored', official: 1, lo: 'x', hi: 1.5 },   // bad s and lo are repaired or dropped
      { t: T + 2 * MIN, v: NaN, s: 0, kind: 'anchored', official: 1 },
      { t: T + 3 * MIN, v: 3, s: 0, kind: 'guess', official: 1 },
      { t: T + MIN, v: 2.5, s: 0.1, kind: 'anchored', official: 1 },            // duplicate time: the later wins
    ],
    bad: 'nope',
  });
  assert.deepEqual(mixed.keys(), ['k']);
  assert.deepEqual(mixed.points('k', 0, Infinity), [
    { t: T, v: 1, s: 0, kind: 'anchored', official: 1, hi: 1.5 },
    { t: T + MIN, v: 2.5, s: 0.1, kind: 'anchored', official: 1 },
  ]);
});
