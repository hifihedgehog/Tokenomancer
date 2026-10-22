import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoSource, demoNow } from '../demo';
import { Ledger } from '../ledger';
import { BucketEstimator } from '../estimator';

const MIN = 60_000, HOUR = 3_600_000;
const NOW = Date.parse('2026-10-22T13:12:00+01:00');

function boot(now = NOW) {
  const demo = new DemoSource(now);
  const ledger = new Ledger();
  const ests = new Map<string, BucketEstimator>();
  const seen: { t: number; keys: string[]; fed: boolean }[] = [];
  demo.bootstrap(ledger, ests, (t, b) => seen.push({ t, keys: Object.keys(b), fed: [...ests.values()].every(e => e.toJSON().lastPollAt === t) }));
  return { demo, ledger, ests, seen };
}

async function readAt(s: ReturnType<typeof boot>, t: number) {
  const res = await s.demo.fetch(t);
  s.ledger.add(s.demo.scan(t));
  const out: Record<string, ReturnType<BucketEstimator['estimate']> & { utilization: number }> = {};
  for (const [k, rd] of res.buckets) {
    const est = s.ests.get(k)!;
    est.onReading(rd, t, s.ledger);
    out[k] = { ...est.estimate(t, s.ledger), utilization: rd.utilization };
  }
  return { out, res };
}

test('demoNow honours TOKENOMANCER_DEMO_NOW', () => {
  assert.equal(demoNow({ TOKENOMANCER_DEMO_NOW: '2026-10-22T13:12:00+01:00' }), NOW);
  for (const env of [{}, { TOKENOMANCER_DEMO_NOW: '' }, { TOKENOMANCER_DEMO_NOW: 'soon' }]) {
    const t = demoNow(env);
    assert.ok(Math.abs(t - Date.now()) < 1000);
  }
});

test('the scenario lands where the dashboard needs it, through the real estimator', async () => {
  const t0 = performance.now();
  const s = boot();
  const ms = performance.now() - t0;
  assert.ok(ms < 600, `construct + bootstrap took ${ms.toFixed(0)} ms (budget 300 ms; slack for parallel test runs)`);
  const { out } = await readAt(s, NOW);
  const five = out.five_hour, week = out.seven_day, fable = out.seven_day_fable;

  // 5-hour: pinned at ~70.4% with two-decimal precision…
  assert.deepEqual([five.utilization, five.kind], [70, 'anchored']);
  assert.ok(five.value > 70.3 && five.value < 70.5 && five.sigma! < 0.05, `${five.value} ± ${five.sigma}`);
  // …running out ~40 min before the reset at both paces (A1), but more than half an hour away (not A2).
  const elapsedH = (NOW - five.windowStart!) / HOUR, leftH = (Date.parse(five.resetsAt!) - NOW) / HOUR;
  const r15 = five.ratePctPerHour!, rAvg = five.value / elapsedH, low = Math.min(r15, rAvg), high = Math.max(r15, rAvg);
  assert.ok(five.value + low * leftH >= 100, 'runs out even at the slower pace');
  assert.ok((100 - five.value) / high > 0.5, 'not within half an hour of the limit');
  const early = leftH - (100 - five.value) / ((low + high) / 2);
  assert.ok(early > 0.5 && early < 0.75, `runs out ${(early * 60).toFixed(0)} min before reset`);

  // Weekly: pinned at ~41.3%. Fable weekly: counted from the window start at ~33.5%.
  assert.deepEqual([week.utilization, week.kind], [41, 'anchored']);
  assert.ok(week.value > 41.2 && week.value < 41.4 && week.sigma! < 0.05, `${week.value} ± ${week.sigma}`);
  assert.deepEqual([fable.utilization, fable.kind], [33, 'window-start']);
  assert.ok(fable.value > 33.3 && fable.value < 33.7 && fable.sigma! < 0.35, `${fable.value} ± ${fable.sigma}`);
  assert.equal(fable.unseen, false);
  for (const e of [five, week, fable]) assert.ok(e.samples >= 24, `${e.key}: ${e.samples} samples`);
});

test('it is the same scenario at any now', async () => {
  const a = boot(), b = boot(NOW + 37 * 86_400_000 + 12_345);
  const shift = 37 * 86_400_000 + 12_345;
  const ea = a.ledger.eventsIn(-Infinity, Infinity), eb = b.ledger.eventsIn(-Infinity, Infinity);
  assert.equal(ea.length, eb.length);
  assert.ok(ea.every((e, i) => eb[i].t === e.t + shift && eb[i].wu === e.wu && eb[i].model === e.model));
  const ra = (await a.demo.fetch(NOW)).buckets, rb = (await b.demo.fetch(NOW + shift)).buckets;
  for (const [k, r] of ra) {
    assert.equal(rb.get(k)!.utilization, r.utilization);
    assert.equal(Date.parse(rb.get(k)!.resetsAt!), Date.parse(r.resetsAt!) + shift);
  }
});

test('bootstrap reports every replayed reading after feeding it, oldest first', () => {
  const s = boot();
  assert.ok(s.seen.length > 500);
  assert.ok(s.seen.every((x, i) => (i === 0 || x.t > s.seen[i - 1].t) && x.fed && x.t < NOW));
  assert.deepEqual(s.seen[s.seen.length - 1], { t: NOW - MIN, keys: ['five_hour', 'seven_day', 'seven_day_fable'], fed: true });
  assert.ok(s.ledger.eventsIn(-Infinity, Infinity).every(e => e.first === true));
  assert.equal(s.ledger.requests(-Infinity, Infinity), s.ledger.size);
  // The poll log holds the last 8 hours of that replay, including one failed poll.
  const log = s.demo.pollLog;
  assert.ok(log.every(p => p.t >= NOW - 8 * HOUR - MIN));
  assert.deepEqual(log.filter(p => !p.ok).map(p => p.t), [NOW - 47 * MIN]);
});

test('live: new requests keep coming, the limit pauses them until the reset, then a new window opens', async () => {
  const s = boot();
  const first = await readAt(s, NOW);
  const later = await readAt(s, NOW + 10 * MIN);
  assert.ok(later.out.five_hour.utilization > first.out.five_hour.utilization);
  assert.ok(s.ledger.lastEventTime()! > NOW && s.ledger.lastEventTime()! <= NOW + 10 * MIN);
  assert.equal(s.demo.pollLog[s.demo.pollLog.length - 1].t, NOW + 10 * MIN);
  assert.deepEqual(s.demo.scan(NOW + 10 * MIN), [], 'fetch already handed its events to scan');

  const reset = Date.parse(first.out.five_hour.resetsAt!);
  let hitAt: number | undefined;
  for (let t = NOW + 11 * MIN; t < reset; t += MIN) {
    const r = (await s.demo.fetch(t)).buckets.get('five_hour')!;
    s.ledger.add(s.demo.scan(t));
    if (r.utilization >= 100 && hitAt === undefined) hitAt = t;
  }
  assert.ok(hitAt !== undefined && hitAt < reset - 15 * MIN, 'runs out before the reset');
  assert.deepEqual(s.ledger.eventsIn(hitAt!, reset), [], 'no requests while limited');

  const after = (await s.demo.fetch(reset + 10 * MIN)).buckets.get('five_hour')!;
  assert.ok(Date.parse(after.resetsAt!) > reset + 4 * HOUR, 'a new 5-hour window');
  assert.ok(after.utilization < 20);
  assert.ok(s.demo.scan(reset + 10 * MIN).length > 0);
});
