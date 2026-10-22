import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BucketEstimator, Estimate, windowLengthMs } from '../estimator';
import { Ledger } from '../ledger';
import { DemoSource } from '../demo';
import {
  ViewModelBuilder, attentionOf, bindingOrder, loupeOf, meterOf, paceOf, PaceIn, rankOf, staleAfterMs, verdictOf,
} from '../ui/viewModel';
import type { BucketInput, BucketVM, FreshInput, LocalVM, ModelInput, PaceVM, TimeFmt, UiConfig } from '../ui/types';

const GB: TimeFmt = { locale: 'en-GB', timeZone: 'Europe/London' };
const NOW = Date.parse('2026-10-22T13:12:00+01:00');
const MIN = 60_000, HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();

const cfg = (o: Partial<UiConfig> = {}): UiConfig => ({
  decimals: 2, precision: 'adaptive', rounding: 'floor', show: 'all', customKeys: [], uncertainty: 'off',
  icon: 'rune', highlight: 'nearLimit', graphics: 'images', pollMs: 60_000, time: GB, ...o,
});
const LOCAL: LocalVM = {
  from: NOW - 5 * HOUR, to: NOW, label: 'This 5-hour window here', requests: 0, usd: 0, byFamily: [],
  tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
};

/** An Estimate as the estimator would shape it; the window follows resetsAt. */
function est(key: string, o: Partial<Estimate> & { resetIn?: number } = {}): Estimate {
  const { resetIn = 3 * HOUR, ...rest } = o;
  const R = NOW + resetIn;
  return {
    key, official: 44, value: 44.27, kind: 'anchored', samples: 10, sigma: 0.012, lo: 44.24, hi: 44.3, unseen: false,
    wuPerPct: 0.5, spread: 0.05, ratePctPerHour: 5, resetsAt: iso(R), windowStart: R - windowLengthMs(key)!, ...rest,
  };
}
const bucket = (e: Estimate, raw: Partial<NonNullable<BucketInput['raw']>> = {}, now = NOW): BucketInput => ({
  key: e.key, estimate: e, armed: true, corrections: [],
  raw: { utilization: e.official, resetsAt: e.resetsAt ?? null, t: now - 30_000, ...raw },
});
const loose = (key: string, value: number, now = NOW) =>
  bucket(est(key, { kind: 'lower-bound', official: Math.floor(value), value, sigma: 0.3, lo: value - 0.4, hi: value + 0.6 }), {}, now);
function input(buckets: BucketInput[], o: { now?: number; cfg?: Partial<UiConfig>; fresh?: Partial<FreshInput>; extras?: ModelInput['extras'] } = {}): ModelInput {
  const now = o.now ?? NOW;
  return {
    now, cfg: cfg(o.cfg), buckets, extras: o.extras ?? [], local: LOCAL, sample: false,
    fresh: { lastOkAt: now - 30_000, refreshing: false, role: 'solo', claudeDir: '/home/me/.claude', ...o.fresh },
  };
}
const build = (buckets: BucketInput[], o: Parameters<typeof input>[1] = {}) => new ViewModelBuilder().build(input(buckets, o));
const byKey = (vm: { buckets: BucketVM[] }, k: string) => vm.buckets.find(b => b.key === k)!;

const paceIn = (o: Partial<PaceIn>): PaceIn => ({
  key: 'five_hour', state: 'pinned', value: 40, sigma: 0.02, rate: 10, windowStart: NOW - 2 * HOUR, resetsAt: NOW + 3 * HOUR,
  now: NOW, rounding: 'floor', exact: false, ...o,
});

test('staleAfterMs is max(3 polls, 5 min)', () => {
  assert.equal(staleAfterMs(30_000), 300_000);
  assert.equal(staleAfterMs(120_000), 360_000);
});

test('pace pair: 5-hour spans the 15-min and average paces; weekly ignores the 15-min pace', () => {
  const five = paceOf(paceIn({})).pace!;
  assert.equal(five.r15, 10);
  assert.equal(five.rAvg, 20);
  assert.deepEqual([five.low, five.high], [10, 20]);
  assert.equal(five.projLow, 70);
  assert.equal(five.projHigh, 100);
  assert.equal(five.runOut!.from, NOW + 3 * HOUR);
  assert.equal(five.evenUse, 40);
  assert.equal(five.evenGap, 0);
  assert.equal(five.nextTick!.edge, 41);
  assert.ok(five.nextTick!.from < five.nextTick!.to);

  const wk = paceOf(paceIn({ key: 'seven_day', windowStart: NOW - 48 * HOUR, resetsAt: NOW + 120 * HOUR })).pace!;
  assert.ok(Math.abs(wk.low - 40 / 48) < 1e-12);
  assert.equal(wk.low, wk.high);
  assert.equal(wk.r15, 10);   // reported, not projected
  assert.equal(wk.projLow, 100);
  assert.ok(Math.abs(wk.runOut!.mid - (NOW + 72 * HOUR)) < 1000);

  const round = paceOf(paceIn({ value: 37.2, rounding: 'round' })).pace!;
  assert.equal(round.nextTick!.edge, 37.5);
});

test('pace is withheld early, for uncertain states, without a pace and without a reset', () => {
  const hold = (o: Partial<PaceIn>) => paceOf(paceIn(o)).hold;
  assert.equal(hold({}), undefined);
  assert.equal(hold({ windowStart: NOW - 5 * MIN }), 'early');                       // e < 0.03
  assert.equal(hold({ windowStart: NOW - 10 * MIN, rate: 0.005 }), 'early');         // no 15-min pace, no average yet
  assert.equal(hold({ windowStart: NOW - 10 * MIN, rate: 0.5 }), undefined);
  assert.equal(hold({ key: 'seven_day', windowStart: NOW - 5.5 * HOUR, resetsAt: NOW + 162.5 * HOUR }), 'weekEarly');
  for (const s of ['calibrating', 'loose', 'stale', 'idle', 'reset'] as const) assert.equal(hold({ state: s }), s);
  assert.equal(hold({ resetsAt: undefined }), 'noReset');
  assert.equal(paceOf(paceIn({ state: 'limit' })).pace, undefined);
});

test('verdicts, and the weekly 24-hour rule (critique P1-12)', () => {
  const v = (o: Partial<PaceIn>, wasRunsOut = false) => {
    const p = paceOf(paceIn(o));
    return verdictOf({ state: o.state ?? 'pinned', pace: p.pace, canRunOut: p.canRunOut, resetsAt: o.resetsAt ?? NOW + 3 * HOUR, wasRunsOut });
  };
  assert.equal(v({ state: 'limit' }), 'limited');
  assert.equal(v({ state: 'loose' }), 'withheld');
  assert.equal(v({ value: 50, rate: 20 }), 'runsOut');          // both paces reach 100
  assert.equal(v({}), 'tight');                                  // only the high pace does
  assert.equal(v({ value: 20, rate: 4 }), 'steady');
  // Weekly: an average over less than a day never says "runs out".
  const week = { key: 'seven_day', value: 30, rate: 1 };
  assert.equal(v({ ...week, windowStart: NOW - 20 * HOUR, resetsAt: NOW + 148 * HOUR }), 'tight');
  assert.equal(v({ ...week, windowStart: NOW - 30 * HOUR, resetsAt: NOW + 138 * HOUR }), 'runsOut');
});

test('runs-out hysteresis: it stays until the middle estimate is 15 min past the reset', () => {
  const R = NOW + 2 * HOUR;
  const p = (mid: number): PaceVM => ({ low: 1, high: 3, projLow: 95, projHigh: 100, evenUse: 40, evenGap: 10, runOut: { from: mid - 10 * MIN, to: mid + 10 * MIN, mid } });
  const v = (mid: number, wasRunsOut: boolean) => verdictOf({ state: 'pinned', pace: p(mid), canRunOut: true, resetsAt: R, wasRunsOut });
  assert.equal(v(R + 10 * MIN, false), 'tight');
  assert.equal(v(R + 10 * MIN, true), 'runsOut');
  assert.equal(v(R + 15 * MIN, true), 'tight');
  assert.equal(verdictOf({ state: 'pinned', pace: { ...p(R), runOut: undefined, projHigh: 92 }, canRunOut: true, resetsAt: R, wasRunsOut: true }), 'tight');
});

test('attention: A3 at the limit, A2 at 97 / 96 and 30 / 45 min, A1 on run-out or ≥ 90 withheld', () => {
  const a = (value: number, prev: 0 | 1 | 2 | 3, o: { pace?: PaceVM; verdict?: 'runsOut' | 'withheld' | 'tight'; canRunOut?: boolean; state?: 'pinned' | 'limit' | 'reset' } = {}) =>
    attentionOf({ state: o.state ?? 'pinned', value, pace: o.pace, canRunOut: o.canRunOut ?? true, verdict: o.verdict ?? 'withheld' }, prev);
  assert.equal(a(100, 0, { state: 'limit' }), 3);
  assert.equal(a(5, 3), 0);                       // a new window
  assert.equal(a(97, 0), 2);
  assert.equal(a(96.5, 2), 2);
  assert.equal(a(96.5, 0), 1);
  assert.equal(a(95.9, 2), 1);                    // A2 exits; still ≥ 90 with pace withheld
  assert.equal(a(90, 0), 1);
  assert.equal(a(89.5, 1), 1);
  assert.equal(a(89.5, 0), 0);
  assert.equal(a(88.9, 1), 0);
  assert.equal(a(99, 2, { state: 'reset' }), 0);
  const pace = (high: number): PaceVM => ({ low: high, high, projLow: 100, projHigh: 100, evenUse: 50, evenGap: 40, runOut: { from: 0, to: 0, mid: 0 } });
  assert.equal(a(90, 0, { pace: pace(25), verdict: 'runsOut' }), 2);              // 0.4 h left
  assert.equal(a(90, 2, { pace: pace(15), verdict: 'runsOut' }), 2);              // 0.67 h: not calm yet
  assert.equal(a(90, 2, { pace: pace(12), verdict: 'runsOut' }), 1);              // 0.83 h: calm
  assert.equal(a(90, 0, { pace: pace(25), verdict: 'tight', canRunOut: false }), 0);
});

test('the builder remembers verdicts and attention across builds, and forgets them in a new window', () => {
  const b = new ViewModelBuilder();
  const five = (rate: number, value = 50, resetIn = 3 * HOUR) =>
    bucket(est('five_hour', { value, official: Math.floor(value), lo: value - 0.03, hi: value + 0.03, ratePctPerHour: rate, resetIn }));
  assert.equal(b.build(input([five(20)])).buckets[0].verdict, 'runsOut');
  // A slower 15-min pace alone no longer agrees, but the middle estimate is still before the reset.
  const again = b.build(input([five(12)], { now: NOW + MIN })).buckets[0];
  assert.equal(again.verdict, 'runsOut');
  assert.equal(again.attention, 1);
  assert.equal(new ViewModelBuilder().build(input([five(12)])).buckets[0].verdict, 'tight');
  // A new window starts from scratch.
  assert.equal(b.build(input([five(12, 50, 4 * HOUR)], { now: NOW + 2 * MIN })).buckets[0].verdict, 'tight');

  const a = new ViewModelBuilder();
  const att = (v: number, t: number) => a.build(input([loose('five_hour', v, t)], { now: t })).buckets[0].attention;
  assert.deepEqual([att(97, NOW), att(96.5, NOW + MIN), att(95.5, NOW + 2 * MIN), att(89.5, NOW + 3 * MIN), att(88, NOW + 4 * MIN)], [2, 2, 1, 1, 0]);
  assert.equal(a.build(input([])).seq, 6);
});

test('a weekly limit under a day old never says "runs out" (critique P1-12)', () => {
  const wk = est('seven_day', { official: 30, value: 30.4, lo: 30.35, hi: 30.45, sigma: 0.03, ratePctPerHour: 2, resetIn: 148 * HOUR });
  const b = build([bucket(wk)]).buckets[0];
  assert.equal(b.verdict, 'tight');
  assert.equal(b.attention, 0);
  assert.equal(b.text.verdict, 'Could reach 100% before Wed 16:12');
  assert.match(b.text.spokenFull, /it could reach 100 percent before Wednesday 16:12/);
  const later = build([bucket({ ...wk, windowStart: NOW - 30 * HOUR, resetsAt: iso(NOW + 138 * HOUR) })]).buckets[0];
  assert.equal(later.verdict, 'runsOut');
  assert.equal(later.attention, 1);
});

test('binding: a 5-pt lead plus a 10-min dwell within a class', () => {
  const b = new ViewModelBuilder();
  const at = (t: number, five: number, week: number) => b.build(input([loose('five_hour', five, t), loose('seven_day', week, t)], { now: t, cfg: { show: 'binding' } }));
  assert.equal(at(NOW, 50, 52).bindingKey, 'seven_day');
  assert.equal(at(NOW + MIN, 58, 54).bindingKey, 'seven_day');          // leads by 4
  assert.equal(at(NOW + 2 * MIN, 60, 54).bindingKey, 'seven_day');      // leads by 6, but too soon
  const vm = at(NOW + 11 * MIN, 60, 54);
  assert.equal(vm.bindingKey, 'five_hour');
  assert.deepEqual(vm.shown, ['five_hour']);
  assert.equal(vm.buckets[0].key, 'five_hour');
  assert.equal(vm.buckets[0].binding, true);
  assert.equal(vm.buckets[1].binding, false);
  // Class 1 (urgent) is promoted at once.
  assert.equal(at(NOW + 12 * MIN, 60, 97).bindingKey, 'seven_day');
});

test('binding: run-out is promoted at once; a reset limit is excluded', () => {
  const b = new ViewModelBuilder();
  const runs = bucket(est('five_hour', { value: 50, official: 50, lo: 49.98, hi: 50.03, ratePctPerHour: 20 }));
  assert.equal(b.build(input([runs, loose('seven_day', 60)])).bindingKey, 'five_hour');
  const b2 = new ViewModelBuilder();
  assert.equal(b2.build(input([bucket(est('five_hour', { value: 20, official: 20, lo: 19.98, hi: 20.03 })), loose('seven_day', 60)])).bindingKey, 'seven_day');
  const vm = b2.build(input([runs, loose('seven_day', 60)], { now: NOW + MIN }));
  assert.equal(byKey(vm, 'five_hour').verdict, 'runsOut');
  assert.equal(vm.bindingKey, 'five_hour');

  const b3 = new ViewModelBuilder();
  assert.equal(b3.build(input([loose('five_hour', 20), loose('seven_day', 60)])).bindingKey, 'seven_day');
  const reset = bucket(est('seven_day', { value: 60, official: 60, resetIn: -5 * MIN }), { t: NOW - 10 * MIN });
  const after = b3.build(input([loose('five_hour', 20, NOW + MIN), reset], { now: NOW + MIN }));
  assert.equal(byKey(after, 'seven_day').state, 'reset');
  assert.equal(after.bindingKey, 'five_hour');
  assert.deepEqual(after.buckets.map(x => x.key), ['five_hour', 'seven_day']);
  // Unless every limit has reset.
  assert.equal(build([reset]).bindingKey, 'seven_day');
});

test('binding order: classes, then run-out time, then projection, then key order', () => {
  const vm = build([
    loose('seven_day_opus', 30),
    bucket(est('seven_day_fable', { kind: 'official', official: 85, value: 85, sigma: undefined, lo: undefined, hi: undefined, samples: 0 })),
    bucket(est('seven_day', { kind: 'official', official: 10, value: 10, sigma: undefined, lo: undefined, hi: undefined, samples: 0 })),
    bucket(est('five_hour', { value: 100.2, official: 100 })),
  ]);
  assert.deepEqual(vm.buckets.map(b => [b.key, rankOf(b)]), [['five_hour', 0], ['seven_day_fable', 3], ['seven_day_opus', 3], ['seven_day', 4]]);
  assert.deepEqual(bindingOrder([...vm.buckets].reverse()).map(b => b.key), vm.buckets.map(b => b.key));
});

test('freshness demotes values to lower bounds after staleAfter', () => {
  const vm = build([bucket(est('five_hour'))], { fresh: { lastOkAt: NOW - 12 * MIN, error: { kind: 'network', message: '', code: 'ENOTFOUND' } } });
  const b = vm.buckets[0];
  assert.equal(vm.fresh.state, 'offline');
  assert.equal(b.state, 'stale');
  assert.equal(b.text.value, '≥44.2%');
  assert.equal(b.text.pm, undefined);
  assert.equal(b.text.state, 'last known');
  assert.equal(b.loupe.mode, 'atLeast');
  assert.equal(b.verdict, 'withheld');
  assert.equal(vm.headline.strong, 'Last known');
  assert.equal(vm.headline.rest, 'official numbers not updated for 12 minutes');
  assert.deepEqual(vm.reasons, ["Can't reach api.anthropic.com (ENOTFOUND). Counting local tokens since 13:00."]);
  assert.equal(b.text.spokenFull, 'Claude five-hour limit: at least 44.2 percent used, last known. Official numbers not updated for 12 minutes');
  // A fresh failure says why at once but keeps the numbers.
  const fresh = build([bucket(est('five_hour'))], { fresh: { lastOkAt: NOW - 90_000, error: { kind: 'rate-limited', message: '' } } });
  assert.equal(fresh.buckets[0].state, 'pinned');
  assert.equal(fresh.fresh.state, 'rate-limited');
  assert.equal(fresh.reasons.length, 1);
});

test('the reset guard and the idle guard', () => {
  // resets_at null at 0%: the old window's estimate no longer applies.
  const idle = build([bucket(est('five_hour', { value: 1.03, official: 0, lo: 1, hi: 1.1 }), { utilization: 0, resetsAt: null })]).buckets[0];
  assert.equal(idle.state, 'idle');
  assert.equal(idle.value, 0);
  assert.equal(idle.text.value, '0%');
  assert.equal(idle.text.resetsAt, undefined);
  assert.equal(idle.elapsed, undefined);
  assert.equal(idle.loupe.mode, 'none');
  assert.equal(idle.attention, 0);
  const reset = build([bucket(est('five_hour', { resetIn: -5 * MIN }), { t: NOW - 10 * MIN })]).buckets[0];
  assert.equal(reset.state, 'reset');
  assert.equal(reset.rune, 'empty');
  assert.equal(reset.text.value, '—');
  assert.equal(reset.text.resetsIn, undefined);
  // A limit whose reset has passed is no longer a limit.
  assert.equal(build([bucket(est('five_hour', { official: 100, value: 100, resetIn: -5 * MIN }), { t: NOW - 10 * MIN })]).buckets[0].state, 'reset');
});

test('precise without σ shows the official number exactly, no ±', () => {
  const b = build([bucket(est('five_hour', { kind: 'precise', official: 16.34, value: 16.34, sigma: undefined, lo: undefined, hi: undefined, ratePctPerHour: undefined, samples: 0 }))]).buckets[0];
  assert.equal(b.state, 'exact');
  assert.equal(b.text.value, '16.34%');
  assert.equal(b.text.pm, undefined);
  assert.equal(b.text.official, '16.34%');
  assert.equal(b.bracket, undefined);
  assert.equal(b.rune, 'pinned');
  assert.equal(b.loupe.mode, 'graded');
  assert.equal(b.loupe.band1, undefined);
  assert.equal(b.loupe.tick, 16.34);
  assert.deepEqual(b.loupe.edgeLabels, ['16', '17']);
});

test('loose is its proven range with the copy chosen by unseen', () => {
  const b = build([bucket(est('seven_day', { kind: 'lower-bound', official: 23, value: 23.6, sigma: 0.37, lo: 23.14, hi: 24.43, unseen: true }))]).buckets[0];
  assert.equal(b.text.value, '23.1–24.5%');
  assert.equal(b.text.pm, undefined);
  assert.equal(b.digits, 1);
  assert.match(b.text.stateTip, /outside this computer/);
  assert.equal(b.text.caption, 'Loose: somewhere in 23.1–24.5% (usage elsewhere)');
  assert.equal(b.text.spoken, 'Claude weekly limit: between 23.1 and 24.5 percent used, loose');
});

test('shown keys per display.show, and notes for unknown custom keys', () => {
  const list = [
    loose('seven_day_fable', 30), loose('five_hour', 10), loose('seven_day', 50),
    bucket(est('seven_day_oauth_apps', { official: 0, value: 0 }), { utilization: 0, resetsAt: null }),
  ];
  const all = build(list);
  assert.deepEqual(all.shown, ['five_hour', 'seven_day', 'seven_day_fable']);   // canonical order; idle side limit left out
  assert.equal(all.bindingKey, 'seven_day');
  assert.deepEqual(all.notes, []);
  assert.deepEqual(build(list, { cfg: { show: 'binding' } }).shown, ['seven_day']);
  assert.deepEqual(build(list, { cfg: { show: 'pair' } }).shown, ['seven_day', 'five_hour']);
  const custom = build(list, { cfg: { show: 'custom', customKeys: ['seven_day_fable', 'seven_day_opuss', 'extra_usage', 'five_hour'] }, extras: [{ key: 'extra_usage', utilization: 12 }] });
  assert.deepEqual(custom.shown, ['seven_day_fable', 'five_hour']);
  assert.equal(custom.notes.length, 2);
  assert.match(custom.notes[0], /"seven_day_opuss", which the usage endpoint didn't return \(it returned five_hour, seven_day, seven_day_fable, seven_day_oauth_apps\)/);
  assert.match(custom.notes[1], /"extra_usage", which has no time window/);
  assert.deepEqual(custom.extras, [{ key: 'extra_usage', label: 'Extra usage', text: '12%' }]);
  const none = build(list, { cfg: { show: 'custom', customKeys: ['nope'] } });
  assert.deepEqual(none.shown, ['seven_day']);
  assert.match(none.notes.at(-1)!, /shows the limit that binds first/);
});

const art = (o: Partial<BucketVM>): BucketVM => ({ state: 'pinned', value: 61.18, official: 61, bracket: [61, 62], attention: 0, ...o } as BucketVM);

test('Loupe: graded bands clipped to the bounds; one or two brackets wide', () => {
  const l = loupeOf(art({ sigma: 0.026, lo: 61.152, hi: 61.221 }), 'floor');
  assert.equal(l.mode, 'graded');
  assert.deepEqual([l.from, l.to, l.edges, l.edgeLabels], [61, 62, [61, 62], ['61', '62']]);
  assert.ok(Math.abs(l.band1![0] - 61.154) < 1e-9 && Math.abs(l.band1![1] - 61.206) < 1e-9);
  assert.deepEqual(l.band2, [61.152, 61.221]);   // ±2σ = 61.128–61.232, clipped to the proven bounds
  assert.equal(l.tick, 61.18);
  assert.equal(l.overL, undefined);
  const r = loupeOf(art({ sigma: 0.026, lo: 61.152, hi: 61.221, bracket: [60.5, 61.5] }), 'round');
  assert.deepEqual([r.from, r.to, r.edgeLabels], [60.5, 61.5, ['60.5', '61.5']]);
  // Bounds straddling an edge: two brackets.
  const two = loupeOf(art({ value: 61.95, sigma: 0.04, lo: 61.9, hi: 62.05 }), 'floor');
  assert.deepEqual([two.from, two.to, two.edges], [61, 63, [61, 62, 63]]);
  // Too wide: two brackets centred on the value, with overflow marks.
  const wide = loupeOf(art({ state: 'counted', value: 22.3, sigma: 0.8, lo: 20.2, hi: 24.9, official: 20, bracket: [20, 21] }), 'floor');
  assert.deepEqual([wide.from, wide.to, wide.overL, wide.overR], [21, 23, true, true]);
  assert.deepEqual(wide.band2, [21, 23]);
  // Round mode near zero starts at its lowest bracket.
  const zero = loupeOf(art({ value: 0.2, sigma: 0.1, lo: 0.1, hi: 0.3, official: 0, bracket: [-0.5, 0.5] }), 'round');
  assert.deepEqual([zero.from, zero.to], [-0.5, 0.5]);
});

test('Loupe: flat for loose, range for calibrating, at-least for stale, none for limit', () => {
  const flat = loupeOf(art({ state: 'loose', value: 23.6, sigma: 0.37, lo: 23.14, hi: 24.43, official: 23, bracket: [23, 24] }), 'floor');
  assert.deepEqual([flat.mode, flat.from, flat.to, flat.band2, flat.tick, flat.band1], ['flat', 23, 25, [23.14, 24.43], 23.6, undefined]);
  const range = loupeOf(art({ state: 'calibrating', value: 16, official: 16, bracket: [16, 17] }), 'floor');
  assert.deepEqual([range.mode, range.from, range.to, range.band2, range.tick], ['range', 16, 17, [16, 17], undefined]);
  const stale = loupeOf(art({ state: 'stale', lo: 61.152 }), 'floor');
  assert.deepEqual([stale.mode, stale.from, stale.to, stale.band2, stale.overR, stale.tick], ['atLeast', 61, 62, [61.152, 62], true, undefined]);
  assert.equal(loupeOf(art({ state: 'stale', lo: 61.85 }), 'floor').to, 63);
  const lim = loupeOf(art({ state: 'limit', value: 100.2, official: 100, bracket: [100, 101] }), 'floor');
  assert.deepEqual([lim.mode, lim.from, lim.to, lim.band2], ['none', 99, 100, undefined]);
});

test('meter: fill, projection ghost, elapsed marker and tone', () => {
  const pace: PaceVM = { low: 1, high: 2, projLow: 70, projHigh: 80.5, evenUse: 45, evenGap: 16 };
  assert.deepEqual(meterOf(art({ pace, elapsed: 0.5 })), { fill: 61.18, tone: 'accent', ghost: [61.18, 80.5], elapsed: 50 });
  assert.deepEqual(meterOf(art({ attention: 2 })), { fill: 61.18, tone: 'warn' });
  assert.deepEqual(meterOf(art({ state: 'limit', value: 100.4, attention: 3 })), { fill: 100, tone: 'crit' });
  assert.equal(meterOf(art({ state: 'calibrating', value: 16, official: 16, bracket: [16, 17] })).fill, 16);
  assert.equal(meterOf(art({ state: 'stale', lo: 61.152 })).fill, 61.152);
  assert.equal(meterOf(art({ state: 'reset' })).fill, 0);
});

/** Every string under the view model, with its path. */
function strings(o: unknown, path = 'vm', out: [string, string][] = []): [string, string][] {
  if (typeof o === 'string') out.push([path, o]);
  else if (Array.isArray(o)) o.forEach((x, i) => strings(x, `${path}[${i}]`, out));
  else if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) strings(x, `${path}.${k}`, out);
  return out;
}
function numbers(o: unknown, path = 'vm', out: [string, number][] = []): [string, number][] {
  if (typeof o === 'number') out.push([path, o]);
  else if (Array.isArray(o)) o.forEach((x, i) => numbers(x, `${path}[${i}]`, out));
  else if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) numbers(x, `${path}.${k}`, out);
  return out;
}

test('a full build over real Estimates from the sample data fills every field', async () => {
  const demo = new DemoSource(NOW);
  const ledger = new Ledger();
  const ests = new Map<string, BucketEstimator>();
  demo.bootstrap(ledger, ests);
  const res = await demo.fetch(NOW);
  const buckets: BucketInput[] = [];
  for (const [key, rd] of res.buckets) {
    const e = ests.get(key);
    if (!e || windowLengthMs(key) === undefined) continue;
    e.onReading(rd, NOW, ledger);
    buckets.push({
      key, estimate: e.estimate(NOW, ledger),
      raw: { utilization: rd.utilization, resetsAt: rd.resetsAt ?? null, t: NOW },
      armed: e.toJSON().calStart?.iFrom !== undefined, corrections: e.features(),
    });
  }
  assert.ok(buckets.length >= 3);

  const builder = new ViewModelBuilder();
  for (const show of ['all', 'binding', 'pair'] as const) {
    for (const fresh of [{}, { lastOkAt: NOW - 20 * MIN, error: { kind: 'rate-limited' as const, message: '', code: 'HTTP 429' }, nextTryAt: NOW + 5 * MIN }]) {
      const vm = builder.build(input(buckets, { cfg: { show }, fresh }));
      for (const [path, s] of strings(vm)) assert.doesNotMatch(s, /NaN|undefined|Infinity|null|\[object/, path);
      for (const [path, n] of numbers(vm)) assert.ok(Number.isFinite(n), `${path} = ${n}`);
      assert.equal(vm.v, 1);
      assert.ok(vm.headline.strong.length > 0);
      assert.equal(vm.bindingKey, vm.buckets[0].key);
      assert.equal(vm.buckets.filter(b => b.binding).length, 1);
      assert.ok(vm.shown.length >= 1);
      for (const b of vm.buckets) {
        for (const k of ['value', 'official', 'state', 'stateTip', 'caption', 'pace', 'verdict', 'spoken', 'spokenFull'] as const) {
          assert.ok(b.text[k].length > 0, `${b.key}.text.${k}`);
        }
        assert.ok(b.short && b.long && b.spokenLabel && b.rune);
        assert.ok(b.loupe.edges.length >= 2 && b.loupe.to - b.loupe.from <= 2);
        assert.ok(b.meter.fill >= 0 && b.meter.fill <= 100);
        assert.ok(b.text.resetsAt && b.text.resetsIn);
        assert.doesNotMatch(b.text.spokenFull, /\.$/);
      }
    }
  }
  const vm = builder.build(input(buckets));
  assert.deepEqual(vm.shown, ['five_hour', 'seven_day', 'seven_day_fable']);
  assert.equal(vm.seq, 7);
  for (const b of vm.buckets) {
    assert.equal(b.state, 'pinned');
    assert.match(b.text.value, /^\d+\.\d+%$/);
    assert.match(b.text.pm!, /^±\d/);
    assert.match(b.text.caption, /^Pinned between official ticks · bounds \d+\.\d\d–\d+\.\d\d%$/);
    // The shown digits never claim more than the ±: one digit fewer would already be coarser than 2σ.
    assert.ok(10 ** (1 - b.digits) > 2 * b.sigma!, `${b.key}: ${b.digits} digits for σ ${b.sigma}`);
  }
});
