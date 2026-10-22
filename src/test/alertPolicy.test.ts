import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertOptions, AlertPolicy } from '../ui/alertPolicy';
import { HOUR, MIN, NOW, bucket, build, edgeBuckets, est } from './nativeFixtures';
import type { ViewModel } from '../ui/types';

const e = edgeBuckets();
const opts = (o: Partial<AlertOptions> = {}): AlertOptions => ({ mode: 'runOut', leadMinutes: 30, focused: true, activatedAt: NOW - 10 * MIN, ...o });
const urgent = () => build([e.urgent5, e.pinnedWk]);
const verdict = (vm: ViewModel, key: string) => vm.buckets.find(b => b.key === key)!.verdict;
const ws5 = () => String(urgent().buckets.find(b => b.key === 'five_hour')!.windowStart);

test('a run-out within the lead time alerts once per window', () => {
  const p = new AlertPolicy();
  assert.equal(verdict(urgent(), 'five_hour'), 'runsOut');
  const [a, ...rest] = p.decide(urgent(), opts());
  assert.equal(rest.length, 0);
  assert.equal(a.id, `five_hour@${ws5()}:runOut`);
  assert.equal(a.key, 'five_hour');
  assert.equal(a.message, "Claude 5-hour limit: at this pace you'll reach 100% around 13:35 (in 23 min), 27 min before it resets at 14:02.");
  assert.deepEqual(p.decide(urgent(), opts()), []);
});

test('held back while unfocused, in the first two minutes, when off, and for sample data', () => {
  const p = new AlertPolicy();
  assert.deepEqual(p.decide(urgent(), opts({ focused: false })), []);
  assert.equal(p.decide(urgent(), opts()).length, 1, 'deferred until focus, then shown while still due');
  assert.deepEqual(new AlertPolicy().decide(urgent(), opts({ activatedAt: NOW - MIN })), []);
  assert.deepEqual(new AlertPolicy().decide(urgent(), opts({ mode: 'off' })), []);
  assert.deepEqual(new AlertPolicy().decide(build([e.urgent5], { sample: true }), opts()), []);
});

test('only confident, live, high and near run-outs alert', () => {
  const none = (vm: ViewModel, o = opts()) => assert.deepEqual(new AlertPolicy().decide(vm, o), []);
  none(urgent(), opts({ leadMinutes: 10 }));
  none(build([e.urgent5], { fresh: { lastOkAt: NOW - 20 * MIN } }));
  // Below 60% a run-out is news for the dashboard, not a toast.
  const low = build([bucket(est('five_hour', { official: 50, value: 50.2, ratePctPerHour: 60, resetIn: 4 * HOUR }))]);
  assert.equal(verdict(low, 'five_hour'), 'runsOut');
  none(low, opts({ leadMinutes: 180 }));
  const high = build([bucket(est('five_hour', { official: 61, value: 61.2, ratePctPerHour: 60, resetIn: 4 * HOUR }))]);
  assert.equal(new AlertPolicy().decide(high, opts({ leadMinutes: 180 })).length, 1);
  none(build([bucket(est('five_hour', { kind: 'lower-bound', official: 92, value: 92.5, sigma: 0.3, lo: 92.1, hi: 92.9, ratePctPerHour: 14, resetIn: 50 * MIN }))]));
});

test('weekly limits alert on the window-average run-out, and never in the first day', () => {
  const p = new AlertPolicy();
  const vm = build([e.pinnedWk]);
  assert.deepEqual(p.decide(vm, opts({ leadMinutes: 180 })), [], 'Saturday is two days away');
  const [a] = p.decide(vm, opts({ leadMinutes: 3000 }));
  assert.equal(a.message, "Claude weekly limit: at your average pace this week you'll reach 100% around Sat 13:30 (in 2d), 1d 20h before it resets at Mon 8:12.");
  const early = build([bucket(est('seven_day', { official: 70, value: 70.2, ratePctPerHour: 8, resetIn: 6 * 24 * HOUR + 12 * HOUR }))]);
  assert.notEqual(verdict(early, 'seven_day'), 'runsOut');
  assert.deepEqual(new AlertPolicy().decide(early, opts({ leadMinutes: 100_000 })), []);
});

test('re-arms once a live pace stops saying "runs out", and a new window starts fresh', () => {
  const p = new AlertPolicy();
  assert.equal(p.decide(urgent(), opts()).length, 1);
  const calm = build([bucket(est('five_hour', { official: 61, value: 61.2, ratePctPerHour: 1, resetIn: 50 * MIN }))]);
  assert.notEqual(verdict(calm, 'five_hour'), 'runsOut');
  assert.deepEqual(p.decide(calm, opts()), []);
  assert.deepEqual(p.takeRearmed(), [`five_hour@${ws5()}:runOut`]);
  assert.deepEqual(p.takeRearmed(), []);
  assert.equal(p.decide(urgent(), opts()).length, 1);

  // A stale or loose reading withholds pace; that must not re-arm, so a glitch can't fire twice.
  const q = new AlertPolicy();
  q.decide(urgent(), opts());
  q.decide(build([e.urgent5], { fresh: { lastOkAt: NOW - 20 * MIN } }), opts());
  assert.deepEqual(q.takeRearmed(), []);
  assert.deepEqual(q.decide(urgent(), opts()), []);

  // The next window, five hours on: a new id, so it alerts again.
  const later = NOW + 5 * HOUR;
  const next = build([bucket(est('five_hour', { official: 92, value: 92.41, ratePctPerHour: 14, resetIn: 5 * HOUR + 50 * MIN }), {}, later)], { now: later });
  const [n] = q.decide(next, opts());
  assert.equal(n.id, `five_hour@${NOW + 50 * MIN}:runOut`);
});

test('runOutAndLimit also announces a reached limit, once', () => {
  const p = new AlertPolicy();
  const vm = build([e.limit5, e.pinnedWk]);
  assert.deepEqual(new AlertPolicy().decide(vm, opts()), []);
  const [a] = p.decide(vm, opts({ mode: 'runOutAndLimit' }));
  assert.equal(a.message, 'Claude 5-hour limit reached. It resets at 14:24 (in 1h 12m).');
  assert.ok(a.id.endsWith(':limit'));
  assert.deepEqual(p.decide(vm, opts({ mode: 'runOutAndLimit' })), []);
});
