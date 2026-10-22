import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  atLeastText, bracketOf, bracketText, captionText, digitsFor, displayValue, evenText, freshOf, headline, humanise, keyOrder,
  labels, looseText, paceText, pmText, reasonText, roundClock, spoken, spokenAge, spokenValue, staleAfterMs, stateOf,
  stateTip, valueText, verdictText, ValueIn,
} from '../ui/present';
import { fmtK, fmtTime, label } from '../format';
import type { FreshInput, PaceVM, TimeFmt } from '../ui/types';

const GB: TimeFmt = { locale: 'en-GB', timeZone: 'Europe/London' };
const NOW = Date.parse('2026-10-22T13:12:00+01:00');   // Thu
const MIN = 60_000, HOUR = 3_600_000;

test('digitsFor: golden values (§3.2.2)', () => {
  const golden: [number, number][] = [[0.012, 2], [0.03, 2], [0.049, 2], [0.05, 1], [0.06, 1], [0.16, 1], [0.29, 1], [0.5, 0], [0.6, 0]];
  for (const [s, d] of golden) assert.equal(digitsFor(s, 2), d, `σ ${s}`);
  assert.equal(digitsFor(0.004, 3), 3);
  assert.equal(digitsFor(0.004, 2), 2);
  assert.equal(digitsFor(0.6, 2), 0);
  assert.ok(Object.is(digitsFor(0.6, 2), 0), 'never -0');
  assert.equal(digitsFor(0.29, 2, 'fixed'), 2);
  assert.equal(digitsFor(undefined, 2), 2);
});

test('pmText: golden values, never below one unit of the last digit', () => {
  const golden: [number, number, string][] = [
    [0.012, 2, '±0.02'], [0.03, 2, '±0.03'], [0.026, 2, '±0.03'], [0.06, 1, '±0.1'],
    [0.12, 1, '±0.2'], [0.29, 1, '±0.3'], [0.6, 0, '±1'], [0.003, 2, '±0.01'], [0.0001, 3, '±0.001'],
  ];
  for (const [s, d, t] of golden) assert.equal(pmText(s, d), t, `σ ${s} @${d}`);
});

test('valueText: clamped rounding in floor and round modes', () => {
  const f16 = bracketOf(16, 'floor', false);
  assert.deepEqual(f16, [16, 17]);
  assert.equal(valueText(16.996, 2, f16, 16), '16.99%');
  assert.equal(valueText(16.7, 0, f16, 16), '16%');
  assert.equal(valueText(17.004, 2, f16, 16), '17.00%');   // local usage already past the edge
  assert.equal(valueText(15.9, 1, f16, 16), '16.0%');      // never below the official bracket
  const r37 = bracketOf(37, 'round', false);
  assert.deepEqual(r37, [36.5, 37.5]);
  assert.equal(valueText(37.49, 1, r37, 37), '37.4%');
  assert.equal(valueText(37.49, 2, r37, 37), '37.49%');
  assert.equal(valueText(37.5, 2, r37, 37), '37.50%');
  assert.equal(valueText(36.5, 0, r37, 37), '37%');
  assert.equal(bracketOf(16.34, 'floor', true), undefined);
  assert.equal(valueText(99.996, 2, [99, 100], 99), '99.99%');
  assert.equal(valueText(100.2, 2, [99, 100], 99), '100%');
  assert.equal(valueText(100, 2, [100, 101], 100), '100%');
  assert.equal(valueText(NaN, 2), '—');
});

test('range, loose and at-least texts', () => {
  assert.equal(bracketText([16, 17]), '16–17%');
  assert.equal(bracketText([15.5, 16.5]), '15.5–16.5%');
  assert.equal(bracketText([99, 100]), '99–100%');
  assert.equal(looseText(23.14, 24.43), '23.1–24.5%');   // outward: floor the low end, ceil the high end
  assert.equal(looseText(23.1, 24.5), '23.1–24.5%');
  assert.equal(looseText(99.2, 100.4), '99.2–100%');
  assert.equal(looseText(23.14, 24.43, 0), '23–25%');
  assert.equal(atLeastText(61.152, 1), '≥61.1%');
  assert.equal(atLeastText(61.152, 0), '≥61%');
});

const v = (o: Partial<ValueIn>): ValueIn => ({ state: 'pinned', value: 44.27, official: 44, bracket: [44, 45], max: 2, precision: 'adaptive', ageMs: MIN, ...o });

test('displayValue: each state', () => {
  assert.deepEqual(displayValue(v({ sigma: 0.012 })), { text: '44.27%', pm: '±0.02', digits: 2 });
  assert.deepEqual(displayValue(v({ state: 'counted', value: 16.34, official: 16, bracket: [16, 17], sigma: 0.12 })), { text: '~16.3%', pm: '±0.2', digits: 1 });
  // Loose is its proven range, never a ± (critique P0-3).
  assert.deepEqual(displayValue(v({ state: 'loose', value: 23.6, official: 23, bracket: [23, 24], sigma: 0.29, lo: 23.14, hi: 24.43 })), { text: '23.1–24.5%', digits: 1 });
  assert.deepEqual(displayValue(v({ state: 'calibrating', value: 16, official: 16, bracket: [16, 17] })), { text: '16–17%', digits: 0 });
  assert.deepEqual(displayValue(v({ state: 'calibrating', value: 16, official: 16, bracket: [15.5, 16.5] })), { text: '15.5–16.5%', digits: 1 });
  assert.deepEqual(displayValue(v({ state: 'limit', value: 100.3, official: 100 })), { text: '100%', digits: 0 });
  assert.deepEqual(displayValue(v({ state: 'idle', value: 0, official: 0 })), { text: '0%', digits: 0 });
  assert.deepEqual(displayValue(v({ state: 'reset' })), { text: '—', digits: 0 });
  assert.equal(displayValue(v({ sigma: 0.29, precision: 'fixed' })).text, '44.27%');
  assert.equal(displayValue(v({ sigma: 0.29, precision: 'fixed' })).pm, '±0.29');
});

test('displayValue: stale is a lower bound that loses digits with age', () => {
  const stale = v({ state: 'stale', value: 61.18, official: 61, bracket: [61, 62], sigma: 0.026, lo: 61.152, hi: 61.221 });
  assert.deepEqual(displayValue({ ...stale, ageMs: 12 * MIN }), { text: '≥61.1%', digits: 1 });
  assert.deepEqual(displayValue({ ...stale, ageMs: 2 * HOUR }), { text: '≥61%', digits: 0 });
  assert.deepEqual(displayValue({ ...stale, ageMs: undefined }), { text: '≥61%', digits: 0 });
  // Calibrating and stale: the bracket's bottom.
  assert.equal(displayValue(v({ state: 'stale', value: 16, official: 16, bracket: [16, 17], ageMs: 12 * MIN })).text, '≥16%');
  assert.equal(displayValue(v({ state: 'stale', value: 16, official: 16, bracket: [15.5, 16.5], ageMs: 12 * MIN })).text, '≥15.5%');
});

test('displayValue: precise without σ shows the endpoint number exactly (critique P0-7)', () => {
  const p = v({ state: 'exact', value: 16.34, official: 16.34, bracket: undefined, sigma: undefined });
  assert.deepEqual(displayValue(p), { text: '16.34%', pm: undefined, digits: 2 });
  assert.deepEqual(displayValue({ ...p, max: 1 }), { text: '16.3%', pm: undefined, digits: 1 });
  assert.deepEqual(displayValue({ ...p, value: 16, official: 16 }), { text: '16%', pm: undefined, digits: 0 });
  assert.deepEqual(displayValue({ ...p, sigma: 0.004 }), { text: '16.34%', pm: '±0.01', digits: 2 });
});

test('labels: the §3.2.1 table', () => {
  const table: [string, string, string, string][] = [
    ['five_hour', '5h', '5-hour', 'five-hour'],
    ['seven_day', 'wk', 'Weekly', 'weekly'],
    ['seven_day_fable', 'Fable wk', 'Fable weekly', 'Fable weekly'],
    ['seven_day_opus', 'Opus wk', 'Opus weekly', 'Opus weekly'],
    ['seven_day_oauth_apps', 'Apps wk', 'Apps weekly', 'apps weekly'],
    ['seven_day_cowork', 'Cowork wk', 'Cowork weekly', 'cowork weekly'],
    ['five_hour_sonnet', 'Sonnet 5h', 'Sonnet 5-hour', 'Sonnet five-hour'],
    ['extra_usage', 'Extra usage', 'Extra usage', 'extra usage'],
  ];
  for (const [key, short, long, said] of table) assert.deepEqual(labels(key), { short, long, spoken: said }, key);
  // A 20-character name is capped at 12, the ellipsis replacing the 12th.
  assert.equal(humanise('seven_day_abcdefghijklmnopqrst'), 'Abcdefghijk…');
  assert.equal(humanise('seven_day_abcdefghijklmnopqrst').length, 12);
  assert.equal(labels('seven_day_abcdefghijklmnopqrst').short, 'Abcdefghijk… wk');
  assert.equal(labels('omelette_promotional').long, 'Omelette pr…');
  assert.equal(humanise('seven_day_twelve_chars'), 'Twelve chars');
  assert.equal(label('seven_day_fable'), 'Fable wk');
});

test('keyOrder: five_hour, seven_day, other weekly, then the rest', () => {
  const keys = ['seven_day_opus', 'extra', 'five_hour_x', 'seven_day', 'seven_day_fable', 'five_hour'];
  assert.deepEqual([...keys].sort(keyOrder), ['five_hour', 'seven_day', 'seven_day_fable', 'seven_day_opus', 'extra', 'five_hour_x']);
});

test('stateOf: first match wins', () => {
  const base = { kind: 'anchored' as const, official: 44, resetsAt: NOW + HOUR, stale: false, now: NOW };
  assert.equal(stateOf(base), 'pinned');
  assert.equal(stateOf({ ...base, kind: 'precise' }), 'exact');
  assert.equal(stateOf({ ...base, kind: 'window-start' }), 'counted');
  assert.equal(stateOf({ ...base, kind: 'lower-bound' }), 'loose');
  assert.equal(stateOf({ ...base, kind: 'official' }), 'calibrating');
  assert.equal(stateOf({ ...base, stale: true }), 'stale');
  assert.equal(stateOf({ ...base, official: 100, stale: true }), 'limit');
  assert.equal(stateOf({ ...base, official: 0, raw: { utilization: 0, resetsAt: null, t: NOW } }), 'idle');
  assert.equal(stateOf({ ...base, raw: { utilization: 44, resetsAt: null, t: NOW } }), 'pinned');
  // The reset guard: a passed reset with no reading since.
  assert.equal(stateOf({ ...base, resetsAt: NOW - 2 * MIN, stale: true }), 'reset');
  assert.equal(stateOf({ ...base, resetsAt: NOW - 30_000 }), 'pinned');   // 60 s grace
  assert.equal(stateOf({ ...base, resetsAt: NOW - 2 * MIN, raw: { utilization: 1, resetsAt: 'x', t: NOW - MIN } }), 'pinned');
  assert.equal(stateOf({ ...base, official: 100, resetsAt: NOW - 2 * MIN }), 'reset');
});

test('stateTip: loose copy depends on unseen; calibrating on armed', () => {
  assert.match(stateTip('loose', { unseen: true, armed: true }), /outside this computer/);
  assert.match(stateTip('loose', { unseen: false, armed: true }), /^Bounded only by the official ticks/);
  assert.match(stateTip('calibrating', { armed: true }), /One tick seen/);
  assert.match(stateTip('calibrating', { armed: false }), /ticks twice/);
  assert.match(stateTip('stale', { armed: true, ageMs: 12 * MIN }), /haven't updated for 12 minutes/);
});

test('freshness thresholds at a 60 s poll: live ≤ 135 s, delayed ≤ 300 s', () => {
  assert.equal(staleAfterMs(60_000), 300_000);
  assert.equal(staleAfterMs(240_000), 720_000);
  const f = (ageS: number, extra: Partial<FreshInput> = {}) =>
    freshOf({ lastOkAt: NOW - ageS * 1000, refreshing: false, role: 'solo', claudeDir: '/home/me/.claude', ...extra }, NOW, 60_000, GB);
  assert.equal(f(135).state, 'live');
  assert.equal(f(136).state, 'delayed');
  assert.equal(f(300).state, 'delayed');
  assert.equal(f(300).stale, false);
  assert.equal(f(301).state, 'stale');
  assert.equal(f(301).stale, true);
  assert.equal(f(180).ageText, 'read 3 min ago');
  assert.equal(freshOf({ refreshing: true, role: 'solo', claudeDir: '' }, NOW, 60_000, GB).state, 'starting');
  // Errors say why at once, but values only demote once stale.
  const err = f(90, { error: { kind: 'network', message: 'fetch failed', code: 'ENOTFOUND' }, nextTryAt: NOW + 20 * MIN });
  assert.equal(err.state, 'offline');
  assert.equal(err.stale, false);
  assert.equal(err.code, 'ENOTFOUND');
  assert.equal(err.nextTryText, '13:32');
  assert.equal(err.reason, "Can't reach api.anthropic.com (ENOTFOUND). Counting local tokens since 13:10; next try 13:32.");
  assert.equal(f(10, { error: { kind: 'no-credentials', message: '' } }).state, 'signed-out');
  assert.match(f(400).reason!, /^No new official reading since 13:05/);
});

test('reason lines', () => {
  const base: FreshInput = { lastOkAt: Date.parse('2026-10-22T13:00:00+01:00'), refreshing: false, role: 'fetcher', claudeDir: 'C:\\Users\\me\\.claude' };
  const r = (error: FreshInput['error'], nextTryAt?: number) => reasonText({ ...base, error, nextTryAt }, NOW, GB);
  assert.equal(r({ kind: 'rate-limited', message: '', code: 'HTTP 429' }, Date.parse('2026-10-22T14:32:00+01:00')),
    'Anthropic is rate-limiting the usage endpoint (HTTP 429). Counting local tokens since 13:00; next try 14:32.');
  assert.equal(r({ kind: 'rate-limited', message: '' }), 'Anthropic is rate-limiting the usage endpoint (HTTP 429). Counting local tokens since 13:00.');
  assert.equal(r({ kind: 'network', message: '', code: 'ENOTFOUND' }), "Can't reach api.anthropic.com (ENOTFOUND). Counting local tokens since 13:00.");
  assert.equal(r({ kind: 'network', message: '', code: 'HTTP 503' }), 'The usage endpoint returned an error (HTTP 503). Counting local tokens since 13:00.');
  assert.equal(r({ kind: 'auth', message: '', code: 'HTTP 401' }), 'The usage endpoint refused the sign-in (HTTP 401). Send a message in Claude Code to refresh it.');
  assert.match(r({ kind: 'expired', message: '' })!, /^Claude Code's sign-in token expired/);
  assert.equal(r({ kind: 'no-credentials', message: '' }), 'Looked for a Claude Code sign-in in C:\\Users\\me\\.claude. Sign in to Claude Code and this fills in by itself.');
  assert.match(r({ kind: 'format', message: '' })!, /unexpected format/);
  assert.equal(r(undefined), undefined);
});

const pace = (o: Partial<PaceVM> = {}): PaceVM => ({ low: 2, high: 3, projLow: 62.4, projHigh: 70.6, evenUse: 45.4, evenGap: 15.8, r15: 3, ...o });

test('pace and even-use text', () => {
  assert.equal(evenText(15.84), '15.8 pts ahead of even use');
  assert.equal(evenText(-17.7), '17.7 pts below even use');
  assert.equal(evenText(1.04), '1 pt ahead of even use');
  assert.equal(evenText(0.02), 'on even use');
  const tick = (a: number, b: number) => pace({ nextTick: { from: NOW + a * MIN, to: NOW + b * MIN, edge: 62 } });
  assert.equal(paceText(tick(25.2, 26.9), NOW, ''), 'next 1% in 25–27 min · 15.8 pts ahead of even use');
  assert.equal(paceText(tick(5.1, 5.4), NOW, ''), 'next 1% in ~5 min · 15.8 pts ahead of even use');
  assert.equal(paceText(tick(50, 75), NOW, ''), 'next 1% in 50m–1h 15m · 15.8 pts ahead of even use');
  assert.equal(paceText(pace(), NOW, ''), 'no use here in the last 15 min · 15.8 pts ahead of even use');
  assert.equal(paceText(pace({ r15: undefined }), NOW, ''), '15.8 pts ahead of even use');
  assert.equal(paceText(undefined, NOW, 'Pace appears after a few minutes of use'), 'Pace appears after a few minutes of use');
});

test('verdict copy', () => {
  const R = Date.parse('2026-10-26T09:00:00+00:00');   // Mon
  const base = { key: 'seven_day', resetsAt: R, now: NOW, fmt: GB, held: 'held' };
  const mid = Date.parse('2026-10-24T13:22:00+01:00');  // Sat, rounds to 13:30 for weekly kinds; 44.5 h before a GMT reset
  assert.equal(verdictText({ ...base, verdict: 'runsOut', pace: pace({ runOut: { from: mid, to: mid, mid } }) }), 'Runs out ~Sat 13:30 — 1d 21h before reset');
  assert.equal(verdictText({ ...base, verdict: 'tight', pace: pace({ projLow: 91.6, projHigh: 99.2 }) }), 'Lands ~92–99% by Mon 9:00');
  assert.equal(verdictText({ ...base, verdict: 'steady', pace: pace({ projLow: 62.4, projHigh: 62.3 }) }), 'Lands ~62% by Mon 9:00');
  // A capped projection that isn't a run-out verdict only "could reach" the limit.
  assert.equal(verdictText({ ...base, verdict: 'tight', pace: pace({ projLow: 100, projHigh: 100 }) }), 'Could reach 100% before Mon 9:00');
  assert.equal(verdictText({ ...base, key: 'five_hour', verdict: 'limited', resetsAt: NOW + 72 * MIN }), 'Limit reached · resets 14:24 (in 1h 12m)');
  assert.equal(verdictText({ ...base, verdict: 'withheld' }), 'held');
  // Five-hour clocks round to 5 min.
  const m5 = NOW + 27 * MIN + 40_000;
  assert.equal(verdictText({ ...base, key: 'five_hour', resetsAt: NOW + 2 * HOUR, verdict: 'runsOut', pace: pace({ runOut: { from: m5, to: m5, mid: m5 } }) }),
    'Runs out ~13:40 — 1h 32m before reset');
  assert.equal(roundClock(Date.parse('2026-10-22T13:42:29Z'), 5), Date.parse('2026-10-22T13:40:00Z'));
});

test('captions', () => {
  const c = { armed: false, now: NOW, fmt: GB, value: '61.18%' };
  assert.equal(captionText({ ...c, state: 'pinned', lo: 61.152, hi: 61.221 }), 'Pinned between official ticks · bounds 61.15–61.23%');
  assert.equal(captionText({ ...c, state: 'loose', value: '23.1–24.5%', unseen: true }), 'Loose: somewhere in 23.1–24.5% (usage elsewhere)');
  assert.equal(captionText({ ...c, state: 'loose', value: '23.1–24.5%', unseen: false }), 'Loose: somewhere in 23.1–24.5% until the next tick');
  assert.equal(captionText({ ...c, state: 'calibrating', value: '16–17%', armed: true }), 'Somewhere in 16–17% · calibrating, one tick seen');
  assert.equal(captionText({ ...c, state: 'stale', value: '≥61.1%', ageMs: 12 * MIN }), 'At least 61.1% · read 12 min ago');
  assert.equal(captionText({ ...c, state: 'counted' }), 'Counted from the window start; tightens at the next tick');
  assert.equal(captionText({ ...c, state: 'exact' }), 'Decimals from the endpoint');
});

test('spoken phrases (§3.5)', () => {
  assert.equal(spoken('weekly', 'pinned', '61.18%', '±0.03'), 'Claude weekly limit: 61.18 percent used, plus or minus 0.03, pinned');
  assert.equal(spoken('Fable weekly', 'counted', '~38.4%', '±0.2'), 'Claude Fable weekly limit: about 38.4 percent used, plus or minus 0.2, counted');
  assert.equal(spoken('five-hour', 'calibrating', '16–17%'), 'Claude five-hour limit: between 16 and 17 percent used, official whole number, calibrating');
  assert.equal(spoken('weekly', 'loose', '23.1–24.5%'), 'Claude weekly limit: between 23.1 and 24.5 percent used, loose');
  assert.equal(spoken('weekly', 'stale', '≥61.1%'), 'Claude weekly limit: at least 61.1 percent used, last known');
  assert.equal(spoken('five-hour', 'limit', '100%'), 'Claude five-hour limit reached');
  assert.equal(spokenValue('exact', '16.34%'), '16.34 percent used');
  assert.equal(spokenAge(MIN, false), 'Official reading 1 minute ago');
  assert.equal(spokenAge(12 * MIN, true), 'Official numbers not updated for 12 minutes');
  assert.equal(spokenAge(undefined, true), 'No official reading yet this session');
});

test('headline without buckets', () => {
  const f = (o: Partial<FreshInput>) => freshOf({ refreshing: false, role: 'solo', claudeDir: '~/.claude', ...o }, NOW, 60_000, GB);
  assert.equal(headline([], f({}), NOW, GB).strong, 'Reading your plan usage…');
  assert.equal(headline([], f({ error: { kind: 'no-credentials', message: '' } }), NOW, GB).strong, 'No Claude Code sign-in found');
  assert.equal(headline([], f({ error: { kind: 'format', message: '' } }), NOW, GB).strong, 'The usage endpoint answered in an unexpected format');
  const off = headline([], f({ error: { kind: 'network', message: '' }, nextTryAt: NOW + 20 * MIN }), NOW, GB);
  assert.deepEqual(off, { strong: "Can't read plan usage yet", rest: 'next try 13:32', tone: 'neutral' });
});

test('format.ts: fmtK never prints 1000.0k; fmtTime shows the date a week out', () => {
  assert.equal(fmtK(950), '950');
  assert.equal(fmtK(999.6), '1.00k');
  assert.equal(fmtK(1234), '1.23k');
  assert.equal(fmtK(50_900), '50.9k');
  assert.equal(fmtK(273_400), '273k');
  assert.equal(fmtK(999_949), '1.00M');
  assert.equal(fmtK(999_999), '1.00M');
  assert.equal(fmtK(1_180_000), '1.18M');
  assert.equal(fmtK(12_800_000), '12.8M');
  assert.equal(fmtK(2.5e9), '2.50B');
  assert.equal(fmtTime('2026-10-22T15:00:00+01:00', NOW, GB), '15:00');
  assert.equal(fmtTime('2026-10-26T09:00:00Z', NOW, GB), 'Mon 9:00');
  // Thursday 6.5 days out: must not read as today.
  assert.equal(fmtTime('2026-10-29T01:00:00Z', NOW, GB), 'Thu 29 Oct 1:00');
  assert.equal(fmtTime(null), '—');
  assert.equal(fmtTime('nonsense'), '—');
});
