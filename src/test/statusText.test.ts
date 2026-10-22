import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusText, runeId, noIcons, displayOrder } from '../ui/statusText';
import { HOUR, InputOpts, LOCAL, MIN, NOW, bucket, build, edgeBuckets, est } from './nativeFixtures';
import type { UiConfig } from '../ui/types';

// The spec's §3.4 rows use show: binding and uncertainty: first; the plan's defaults (all, off) get their own tests.
const SPEC: Partial<UiConfig> = { show: 'binding', uncertainty: 'first' };
const e = edgeBuckets();
const nothing = { ...LOCAL, requests: 0 };
const empty = (fresh: InputOpts['fresh']) => build([], { cfg: SPEC, fresh: { lastOkAt: undefined, ...fresh }, local: nothing });
const scenario = [e.pinnedWk, e.countedFable, e.pinned5];
const counted5 = bucket(est('five_hour', { kind: 'window-start', official: 16, value: 16.34, sigma: 0.12, lo: 16, hi: 16.99 }));
const static97 = bucket(est('seven_day', { official: 97, value: 97.12, sigma: 0.012, lo: 97.1, hi: 97.15, resetIn: 3 * HOUR }));
const limitWk = bucket(est('seven_day', { official: 100, value: 100, sigma: undefined, lo: undefined, hi: undefined, resetIn: 92 * HOUR }));
const reset5 = bucket(est('five_hour', { resetIn: -10 * MIN }), { t: NOW - 20 * MIN });

/** [row, view model, text, background]. */
const ROWS: [string, ReturnType<typeof build>, string, string?][] = [
  ['1 starting', empty({ refreshing: true }), '$(tokenomancer-empty) Claude usage'],
  ['2 signed out', empty({ error: { kind: 'no-credentials', message: '' } }), '$(tokenomancer-empty) Claude: not signed in'],
  ['3 failed', empty({ error: { kind: 'network', message: 'x', code: 'ENOTFOUND' }, nextTryAt: NOW + 80 * MIN }), '$(tokenomancer-empty) Claude usage · retry 14:32'],
  ['3 rate-limited', empty({ error: { kind: 'rate-limited', message: 'x', code: 'HTTP 429' }, nextTryAt: NOW + 80 * MIN }), '$(tokenomancer-empty) Claude usage · retry 14:32'],
  ['4 expired', empty({ error: { kind: 'expired', message: '' } }), '$(tokenomancer-empty) Claude usage'],
  ['5 format', empty({ error: { kind: 'format', message: '' } }), '$(tokenomancer-empty) Claude usage · unavailable'],
  ['6 calibrating', build([e.calibrating5], { cfg: SPEC }), '$(tokenomancer-calibrating) 5h 16–17%'],
  ['6 calibrating, round', build([e.calibrating5], { cfg: { ...SPEC, rounding: 'round' } }), '$(tokenomancer-calibrating) 5h 15.5–16.5%'],
  ['7 pinned', build([e.pinned5], { cfg: SPEC }), '$(tokenomancer-pinned) 5h 44.27% ±0.02'],
  // Plan decision 5: precise without σ is the official number exactly, with no ±.
  ['8 exact', build([e.exact5], { cfg: SPEC }), '$(tokenomancer-pinned) 5h 16.34%'],
  ['9 counted', build([counted5], { cfg: SPEC }), '$(tokenomancer-loose) 5h ~16.3% ±0.2'],
  // Plan decision 4: loose is its proven range, with no ±.
  ['10 loose', build([e.looseWk], { cfg: SPEC }), '$(tokenomancer-loose) wk 23.1–24.5%'],
  ['11 sample scenario, A1', build(scenario, { cfg: SPEC }), '$(tokenomancer-pinned) wk 61.18% ±0.03 · 100% ~Sat 13:30'],
  ['12 A2 run-out', build([e.urgent5], { cfg: SPEC }), '$(warning) 5h 92.41% ±0.02 · 100% ~13:35', 'warning'],
  ['13 A2 static', build([static97], { cfg: SPEC }), '$(warning) wk 97.12% ±0.02', 'warning'],
  ['14 A3', build([e.limit5], { cfg: SPEC }), '$(error) 5h 100% · resets 14:24', 'error'],
  ['14 A3 weekly', build([limitWk], { cfg: SPEC }), '$(error) wk 100% · resets Mon 8:12', 'error'],
  ['15 stale 12 min', build([e.pinnedWk], { cfg: SPEC, fresh: { lastOkAt: NOW - 12 * MIN } }), '$(tokenomancer-loose) wk ≥61.1% · 12m ago'],
  ['16 stale 2 h', build([e.pinnedWk], { cfg: SPEC, fresh: { lastOkAt: NOW - 2 * HOUR } }), '$(tokenomancer-loose) wk ≥61% · 2h ago'],
  ['17 idle', build([e.idle5], { cfg: SPEC }), '$(tokenomancer-pinned) 5h 0%'],
  // Critique P2-32: "5h new window", not "reset 16:00", one letter from "resets 16:00".
  ['18 reset', build([reset5], { cfg: SPEC }), '$(tokenomancer-empty) 5h new window'],
  ['19 pair', build([e.pinnedWk, e.pinned5], { cfg: { ...SPEC, show: 'pair' }, now: NOW }), '$(tokenomancer-pinned) wk 61.18% ±0.03 · 5h 44.27% · wk 100% ~Sat 13:30'],
  // Plan decision 1: "all" is in the fixed canonical order, not binding order.
  ['20 all', build(scenario, { cfg: { ...SPEC, show: 'all' } }), '$(tokenomancer-pinned) 5h 44.27% ±0.02 · wk 61.18% · Fable wk ~38.4% · wk 100% ~Sat 13:30'],
  ['21 uncertainty off', build(scenario, { cfg: { ...SPEC, uncertainty: 'off' } }), '$(tokenomancer-pinned) wk 61.18% · 100% ~Sat 13:30'],
  ['22 codicon', build(scenario, { cfg: { ...SPEC, icon: 'codicon' } }), '$(pinned) wk 61.18% ±0.03 · 100% ~Sat 13:30'],
  ['23 sample', build(scenario, { cfg: SPEC, sample: true }), '$(tokenomancer-pinned) wk 61.18% ±0.03 · 100% ~Sat 13:30 · sample'],
];

for (const [row, vm, text, background] of ROWS) {
  test(`§3.4 row ${row}`, () => {
    const s = statusText(vm);
    assert.equal(s.text, text);
    assert.equal(s.background, background);
    assert.ok(s.a11y.length > 10 && !s.a11y.includes('$('), s.a11y);
  });
}

test('every row but "all", "pair" with its suffix and sample stays within 40 visible characters', () => {
  const visible = (s: string) => s.replace(/\$\([a-z-]+\)\s*/g, '');
  for (const [row, vm] of ROWS) {
    if (/^(19|20|23) /.test(row)) continue;
    assert.ok(visible(statusText(vm).text).length <= 40, `${row}: ${statusText(vm).text}`);
  }
  // The calm default string is at most 20 visible characters after the icon.
  assert.ok(visible(statusText(build([e.pinned5], { cfg: SPEC })).text).length <= 20);
  assert.ok(visible(statusText(build([e.pinnedWk, e.pinned5], { cfg: { ...SPEC, show: 'pair' } })).text).length <= 50);
});

test('plan defaults: all limits in canonical order, no ±, the owner\'s format', () => {
  const s = statusText(build(scenario));
  assert.equal(s.text, '$(tokenomancer-pinned) 5h 44.27% · wk 61.18% · Fable wk ~38.4% · wk 100% ~Sat 13:30');
  const calm = build([e.exact5, bucket(est('seven_day', { official: 23, value: 23.18, sigma: 0.004, lo: 23.17, hi: 23.19, ratePctPerHour: 0.1, resetIn: 92 * HOUR })),
    bucket(est('seven_day_fable', { official: 8, value: 8.71, sigma: 0.004, lo: 8.7, hi: 8.72, ratePctPerHour: 0.05, resetIn: 92 * HOUR }))]);
  assert.equal(statusText(calm).text, '$(tokenomancer-pinned) 5h 16.34% · wk 23.18% · Fable wk 8.71%');
});

test('uncertainty: every puts the ± on each limit that has one', () => {
  const s = statusText(build(scenario, { cfg: { uncertainty: 'every' } }));
  assert.equal(s.text, '$(tokenomancer-pinned) 5h 44.27% ±0.02 · wk 61.18% ±0.03 · Fable wk ~38.4% ±0.2 · wk 100% ~Sat 13:30');
});

test('icon: the binding limit\'s rune, attention cues override it, and icon: none keeps only the cues', () => {
  // Binding is the weekly (A1, pinned) even though 5h comes first.
  assert.ok(statusText(build([e.calibrating5, e.pinnedWk])).text.startsWith('$(tokenomancer-pinned) 5h 16–17%'));
  assert.ok(statusText(build([e.urgent5, e.pinnedWk])).text.startsWith('$(warning) '));
  assert.ok(statusText(build([e.limit5, e.pinnedWk])).text.startsWith('$(error) '));
  assert.equal(statusText(build([e.pinned5], { cfg: { icon: 'none' } })).text, '5h 44.27%');
  assert.ok(statusText(build([e.urgent5], { cfg: { icon: 'none' } })).text.startsWith('$(warning) '));
  assert.equal(statusText(build([], { cfg: { icon: 'none' }, fresh: { lastOkAt: undefined } })).text, 'Claude usage');
});

test('runeId maps every rune to its glyph and codicon fallback', () => {
  assert.deepEqual(['pinned', 'loose', 'calibrating', 'empty'].map(r => runeId(r as never, 'rune')),
    ['tokenomancer-pinned', 'tokenomancer-loose', 'tokenomancer-calibrating', 'tokenomancer-empty']);
  assert.deepEqual(['pinned', 'loose', 'calibrating', 'empty'].map(r => runeId(r as never, 'codicon')),
    ['pinned', 'circle-large-outline', 'ellipsis', 'dash']);
  assert.equal(runeId('pinned', 'none'), undefined);
});

test('highlight: nearLimit warns at A2, limitOnly only at A3, never not at all', () => {
  const bg = (hl: UiConfig['highlight'], b: typeof e.urgent5) => statusText(build([b], { cfg: { highlight: hl } })).background;
  assert.equal(bg('nearLimit', e.urgent5), 'warning');
  assert.equal(bg('limitOnly', e.urgent5), undefined);
  assert.equal(bg('limitOnly', e.limit5), 'error');
  assert.equal(bg('never', e.limit5), undefined);
  assert.equal(bg('nearLimit', e.pinned5), undefined);
});

test('with several limits shown, the attention suffix names the one it is about', () => {
  assert.equal(statusText(build([e.limit5, e.pinnedWk, e.countedFable])).text,
    '$(error) 5h 100% · wk 61.18% · Fable wk ~38.4% · 5h resets 14:24');
  assert.equal(statusText(build([e.urgent5, e.pinnedWk])).text, '$(warning) 5h 92.41% · wk 61.18% · 5h 100% ~13:35');
});

test('§3.5 accessibility labels', () => {
  const a11y = (vm: ReturnType<typeof build>) => statusText(vm).a11y;
  assert.equal(a11y(empty({ refreshing: true })), 'Claude usage: reading your plan usage.');
  assert.equal(a11y(empty({ error: { kind: 'no-credentials', message: '' } })),
    'Claude usage: no Claude Code sign-in found on this computer. Activate for details.');
  assert.equal(a11y(empty({ error: { kind: 'network', message: 'x', code: 'ENOTFOUND' }, nextTryAt: NOW + 80 * MIN })),
    "Claude usage: can't read plan usage yet, can't reach api.anthropic.com. Next try at 14:32.");
  assert.equal(a11y(build(scenario, { cfg: SPEC })),
    'Claude weekly limit: 61.18 percent used, plus or minus 0.03, pinned. At your average pace this week it reaches 100 percent '
    + 'around Saturday 13:30, 1 day 20 hours before it resets. Official reading just now. Shown because it binds first.');
  assert.ok(a11y(build([e.urgent5], { cfg: SPEC })).startsWith('Warning. Claude five-hour limit: 92.41 percent used, plus or minus 0.02, pinned. At this pace it reaches 100 percent around 13:35'));
  assert.equal(a11y(build([e.limit5], { cfg: SPEC })), 'Claude five-hour limit reached. Resets at 14:24, in 1 hour 12 minutes. Official reading just now.');
  assert.equal(a11y(build([e.pinnedWk], { cfg: SPEC, fresh: { lastOkAt: NOW - 12 * MIN } })),
    'Claude weekly limit: at least 61.1 percent used, last known. Official numbers not updated for 12 minutes.');
  assert.ok(a11y(build([e.looseWk], { cfg: SPEC })).startsWith('Claude weekly limit: between 23.1 and 24.5 percent used, loose.'));
  assert.ok(a11y(build(scenario, { cfg: SPEC, sample: true })).startsWith('Sample data, not your account. '));
  // With show: all, the label speaks the most urgent limit in full and the others briefly.
  assert.ok(a11y(build(scenario)).endsWith('Five-hour: 44.27 percent used, pinned; Fable weekly: about 38.4 percent used, counted.'));
});

test('text from the endpoint cannot draw an icon', () => {
  assert.equal(noIcons('$(bug) x $(y)'), '\\$(bug) x \\$(y)');
  const vm = build([bucket(est('seven_day_$(bug)', { resetIn: 50 * HOUR }))], { cfg: { icon: 'none' } });
  const s = statusText(vm);
  assert.ok(!/(^|[^\\])\$\(/.test(s.text), s.text);
});

test('displayOrder lists the shown limits first, then the rest in binding order', () => {
  const vm = build(scenario, { cfg: { show: 'custom', customKeys: ['five_hour'] } });
  assert.deepEqual(displayOrder(vm).map(b => b.key), ['five_hour', 'seven_day', 'seven_day_fable']);
});
