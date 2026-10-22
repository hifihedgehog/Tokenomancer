import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import type { DetailVM, ViewModel } from '../ui/types';
import { app, selected } from '../webview/app';
import { loupe } from '../webview/cards';
import { Ctx, Cursor, UiState } from '../webview/ctx';
import { Child, h, VNode } from '../webview/dom';
import { compact, edgePct, etaRange, localBoundaries, share, usd, zoneOffset } from '../webview/fmt';
import { gaps } from '../webview/zoomChart';
import { atOrBefore, bandPath, fitLabels, laneAt, linePath, nearest } from '../webview/scale';

const DIR = path.join(process.cwd(), 'test', 'fixtures', 'vm');
const FIXTURES = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
  const x = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as { vm: ViewModel; detail?: DetailVM };
  return { name: f.replace(/\.json$/, ''), ...x };
});
const HOUR = 3_600_000;

function ctx(vm: ViewModel, detail: DetailVM | undefined, surface: 'panel' | 'view', ui: UiState, cur?: Cursor): Ctx {
  return {
    vm, detail, sel: selected(vm, ui, detail), surface, busy: false, sr: false, ui, cur,
    w: (_id, fallback) => fallback,
    ageMs: () => (vm.fresh.lastOkAt === undefined ? undefined : vm.now - vm.fresh.lastOkAt),
    run() {}, select() {}, moveFocus() {}, setCur() {}, toggle() {},
  };
}

function nodes(c: Child, out: VNode[] = []): VNode[] {
  if (Array.isArray(c)) c.forEach(x => nodes(x, out));
  else if (c && typeof c === 'object') { out.push(c); c.c.forEach(x => nodes(x, out)); }
  return out;
}
const text = (c: Child): string => (Array.isArray(c) ? c.map(text).join('') : typeof c === 'string' ? c : c && typeof c === 'object' ? text(c.c) : '');

// ───────────────────────────── whole-view renders ─────────────────────────────

const OPEN: UiState = { v: 1, tables: { win: true, zoom: true }, open: { zoom: true, mix: true, calib: true } };

for (const f of FIXTURES) for (const surface of ['panel', 'view'] as const) {
  test(`${f.name} renders on the ${surface} with every table and section open`, () => {
    const tree = nodes(app(ctx(f.vm, f.detail, surface, OPEN), ''));
    const ids = new Set<string>();
    for (const n of tree) {
      for (const [k, v] of Object.entries(n.p)) {
        if (k.startsWith('on') || v == null || v === false) continue;
        if (k === 'style') {
          assert.ok(/\b(bar|tip)\b/.test(n.p.class), `style only on bars and the tooltip, got ${n.t}.${n.p.class}`);
          continue;
        }
        assert.doesNotMatch(String(v), /NaN|undefined|Infinity|\[object/, `${f.name}: ${n.t}[${k}]="${v}"`);
      }
      if (n.p.id) {
        assert.ok(!ids.has(n.p.id), `duplicate id ${n.p.id}`);
        ids.add(n.p.id);
      }
      for (const x of n.c.flat(9)) if (typeof x === 'string') assert.doesNotMatch(x, /NaN|undefined|\[object/, `${f.name}: text "${x}"`);
    }
    const tabs = tree.filter(n => n.p.role === 'tab');
    assert.equal(tabs.length, f.vm.buckets.length);
    if (tabs.length) {
      assert.equal(tabs.filter(t => t.p['aria-selected'] === 'true').length, 1);
      assert.equal(tabs.filter(t => t.p.tabindex === 0).length, 1, 'one tab in the tab order (roving tabindex)');
      for (const t of tabs) {
        assert.ok(t.p['aria-label'], 'tabs have a short label');
        assert.ok(ids.has(t.p['aria-describedby']), 'and a description that exists');
      }
      const panel = tree.find(n => n.p.role === 'tabpanel');
      assert.ok(panel && ids.has(panel.p['aria-labelledby']), 'the detail is labelled by its tab');
      for (const chart of tree.filter(n => n.p.role === 'group')) {
        assert.equal(chart.p['aria-roledescription'], 'chart');
        assert.ok(String(chart.p['aria-label']).length > 20);
        assert.equal(chart.p.tabindex, 0);
      }
    }
    for (const svg of tree.filter(n => n.t === 'svg')) assert.equal(svg.p['aria-hidden'], 'true');
  });
}

test('tooltips and their spoken readouts render at any cursor position', () => {
  for (const f of FIXTURES.filter(x => x.detail)) {
    const d = f.detail!;
    for (const id of ['win', 'zoom'] as const) {
      const span = id === 'win' ? [d.window.from, d.window.to] : [d.zoom.from, d.zoom.to];
      for (let k = 0; k <= 8; k++) {
        const t = span[0] + ((span[1] - span[0]) * k) / 8;
        const tree = nodes(app(ctx(f.vm, d, 'panel', { v: 1, tables: {}, open: {} }, { id, t, kbd: true }), ''));
        const tip = tree.find(n => n.p.class === 'tip');
        assert.ok(tip, `${f.name} ${id} tooltip at ${k}/8`);
        assert.ok(text(tip).length > 4);
        const live = tree.find(n => n.p['aria-live'] === 'polite' && text(n).length > 0);
        assert.ok(live, 'the keyboard cursor is read out');
      }
    }
  }
});

test('the view surface shows disclosures, not the whole dashboard, and an Open dashboard button', () => {
  const f = FIXTURES.find(x => x.name === 'pinned-A1')!;
  const tree = nodes(app(ctx(f.vm, f.detail, 'view', { v: 1, tables: {}, open: {} }), ''));
  const discs = tree.filter(n => n.t === 'button' && /\bdisc\b/.test(n.p.class));
  assert.deepEqual(discs.map(d => d.p['aria-expanded']), ['false', 'false', 'false']);
  assert.ok(!tree.some(n => n.p.role === 'group' && n.p.class.includes('zoom')), 'zoom chart stays collapsed');
  assert.ok(tree.some(n => n.t === 'button' && text(n) === 'Open dashboard'));
  assert.ok(!tree.some(n => n.p.role === 'toolbar'), 'view actions live in the view title bar');
});

test('the signed-out view names the folder as a path', () => {
  const f = FIXTURES.find(x => x.name === 'signed-out')!;
  const tree = nodes(app(ctx(f.vm, f.detail, 'panel', { v: 1, tables: {}, open: {} }), ''));
  const code = tree.find(n => n.t === 'code');
  assert.ok(code && /\.claude$/.test(text(code)), text(code ?? ''));
  assert.ok(tree.some(n => text(n) === 'Preview with sample data'));
});

test('a selection falls back from the user’s pick to the detail’s key to the binding limit', () => {
  const f = FIXTURES.find(x => x.name === 'loose')!;
  assert.equal(selected(f.vm, { v: 1, tables: {}, open: {}, selected: 'five_hour' }, f.detail)?.key, 'five_hour');
  assert.equal(selected(f.vm, { v: 1, tables: {}, open: {}, selected: 'gone' }, f.detail)?.key, f.detail!.key);
  assert.equal(selected(f.vm, { v: 1, tables: {}, open: {} })?.key, f.vm.bindingKey);
});

// ───────────────────────────── marks ─────────────────────────────

test('the Loupe draws its modes: graded bands, a chevron for at-least, staves at each edge', () => {
  const graded = nodes(loupe({ mode: 'graded', from: 61, to: 62, edges: [61, 62], edgeLabels: ['61', '62'], band1: [61.15, 61.21], band2: [61.12, 61.24], tick: 61.18 }, 200));
  assert.equal(graded.filter(n => n.p.class === 'scale').length, 2);
  assert.ok(graded.some(n => n.p.class === 'band1') && graded.some(n => n.p.class === 'tick'));
  assert.equal(graded.filter(n => n.p.class === 'tenth').length, 9);
  const atLeast = nodes(loupe({ mode: 'atLeast', from: 61, to: 62, edges: [61, 62], edgeLabels: ['61', '62'], band2: [61.15, 62] }, 200));
  assert.ok(atLeast.some(n => n.p.class === 'chev'));
  assert.ok(!atLeast.some(n => n.p.class?.startsWith('tick')), 'no estimate tick on a lower bound');
});

test('h() takes classes on the tag, optional props, and hides every svg from screen readers', () => {
  const a = h('div.card.ph', h('span', 'x'));
  assert.deepEqual([a.t, a.p.class, a.c.length], ['div', 'card ph', 1]);
  const b = h('span.chip', { class: 'bind', title: 't' }, 'binds first');
  assert.deepEqual([b.p.class, b.p.title, b.c], ['chip bind', 't', ['binds first']]);
  assert.equal(h('svg').p['aria-hidden'], 'true');
  assert.deepEqual(h('p', false, 'a').c, [false, 'a']);
});

// ───────────────────────────── formats and geometry ─────────────────────────────

test('number formats', () => {
  assert.deepEqual([412, 50_900, 273_000, 1_180_000, 12_800_000, 999_600].map(compact), ['412', '50.9k', '273k', '1.18M', '12.8M', '1.00M']);
  assert.equal(usd(5.414), '$5.41');
  assert.equal(usd(1234.5), '$1,235');
  assert.deepEqual([0.001, 0.76, 0].map(share), ['<1%', '76%', '0%']);
  assert.deepEqual([61, 60.5].map(edgePct), ['61%', '60.5%']);
  assert.equal(etaRange(20 * 60_000, 21.4 * 60_000), 'in 20–21 min');
  assert.equal(etaRange(4.8 * 60_000, 5.2 * 60_000), 'in ~5 min');
  assert.equal(etaRange(-1, 10_000), 'in ~1 min');
});

test('local boundaries follow the display zone, across a DST change', () => {
  const tz = 'Europe/London';
  assert.equal(zoneOffset(Date.parse('2026-10-22T12:00:00Z'), tz), HOUR);
  assert.equal(zoneOffset(Date.parse('2026-10-26T12:00:00Z'), tz), 0);
  // Sunday 25 October 2026 has 25 local hours.
  const day0 = Date.parse('2026-10-24T23:00:00Z'), day1 = Date.parse('2026-10-26T00:00:00Z');
  assert.equal(localBoundaries(day0, day1, 60, tz).length, 25);
  const midnights = localBoundaries(Date.parse('2026-10-19T08:00:00Z'), Date.parse('2026-10-26T08:00:00Z'), 1440, tz);
  assert.deepEqual(midnights.map(t => new Date(t).toISOString().slice(5, 13)),
    ['10-19T23', '10-20T23', '10-21T23', '10-22T23', '10-23T23', '10-24T23', '10-26T00']);
  assert.deepEqual(localBoundaries(0, 7_200_000, 60, 'UTC'), [3_600_000, 7_200_000]);
});

test('ribbons split where there is no band and drop slivers; lines lift the pen at gaps', () => {
  const xs = [0, 1, 2, 3, 4, 5];
  assert.equal(bandPath(xs, [1, 1, NaN, 1, 1, 1], [2, 2, NaN, 2, 2, 2]), 'M0 2L1 2L1 1L0 1ZM3 2L4 2L5 2L5 1L4 1L3 1Z');
  assert.equal(bandPath(xs, [1, 1, NaN, 1, 1, 1], [2, 2, NaN, 2, 2, 2], 3), 'M3 2L4 2L5 2L5 1L4 1L3 1Z');
  assert.equal(bandPath(xs, [1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1]), '', 'a zero-width band draws nothing');
  assert.equal(linePath([0, 1, 2, 3], [5, NaN, 6, 7]), 'M0 5M2 6L3 7');
});

test('lookups', () => {
  assert.equal(nearest([], 5), -1);
  assert.equal(nearest([0, 10, 20], 14), 1);
  assert.equal(nearest([0, 10, 20], 16), 2);
  assert.equal(atOrBefore([0, 10, 20], 9), 0);
  assert.equal(atOrBefore([0, 10, 20], -1), -1);
  const lanes = [{ from: 0, to: 10, lo: 5, hi: 6 }, { from: 12, to: 20, lo: 6, hi: 7 }];
  assert.equal(laneAt(lanes, 15)?.lo, 6);
  assert.equal(laneAt(lanes, 11), undefined);
  assert.deepEqual(fitLabels([0, 10, 50], [20, 20, 20], 8), [true, false, true]);
  assert.deepEqual(gaps([0, 60_000, 400_000], 500_000, 60_000), [[60_000, 400_000]]);
  assert.deepEqual(gaps([0, 60_000], 400_000, 60_000), [[60_000, 400_000]], 'a silence running up to now counts');
});
