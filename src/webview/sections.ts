// Everything below the cards: the selected limit's detail (window chart and facts, the Between
// chart, where the points went, calibration), the signed-out state and the footer.

import { evenText, roundClock } from '../ui/present';
import { age, clock } from '../ui/time';
import { BucketVM, LocalVM, MixVM } from '../ui/types';
import { button, chip } from './cards';
import { sechead } from './chart';
import { Ctx } from './ctx';
import { Child, h, VNode } from './dom';
import { BETWEEN, compact, dots, edgePct, etaRange, family, max, PART, plural, rate, round, share, TWO_TICKS, usd } from './fmt';
import { icon, rune } from './icons';
import { windowFigure } from './windowChart';
import { zoomFigure } from './zoomChart';

const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function facts(c: Ctx, b: BucketVM): VNode {
  const vm = c.vm, p = b.pace, ms = c.ageMs(), t = b.text, rows: [string, string, string?][] = [];
  // Most tips open with the state's own word; don't say it twice.
  rows.push(['State', t.stateTip.toLowerCase().startsWith(t.state) ? t.stateTip : `${upper(t.state)} — ${t.stateTip}`]);
  rows.push(['Official', t.official + (ms !== undefined ? ` · ${age(ms, 'view')}` : '')]);
  if (b.lo !== undefined && b.hi !== undefined && b.state !== 'calibrating') rows.push(['Bounds', `${b.lo.toFixed(2)}–${b.hi.toFixed(2)}%`]);
  if (p?.nextTick) {
    const n = p.nextTick;
    rows.push(['Next 1%', `${edgePct(n.edge)} ${etaRange(n.from - vm.now, n.to - vm.now)} (~${clock(roundClock((n.from + n.to) / 2, 5), vm.now, vm.fmt)})`]);
  }
  const pace = p && dots(p.r15 !== undefined && `${rate(p.r15)} now (this computer)`, p.rAvg !== undefined && `${rate(p.rAvg)} window average`);
  if (pace) rows.push(['Pace', pace]);
  rows.push(['Projection', t.verdict]);
  if (p) rows.push(['Even use', upper(evenText(p.evenGap))]);
  if (t.resetsAt) rows.push(['Resets', t.resetsAt + (t.resetsIn ? ` (in ${t.resetsIn})` : '')]);
  if (b.calib.wuPerPct) rows.push(['1% ≈', `${usd(b.calib.wuPerPct)} API-equivalent`, 'API-price value of the tokens that move this limit 1 point; a translation, not a bill']);
  return h('dl.facts', rows.map(([k, v, tip]) => h('div', h('dt', { title: tip ?? null }, k), h('dd', v))));
}

function bars(title: string, rows: [string, number][], fmt: (v: number) => string): VNode {
  const total = rows.reduce((a, r) => a + r[1], 0), top = max(1e-12, ...rows.map(r => r[1]));
  return h('table.bars',
    h('caption', title),
    h('tbody', rows.map(([label, v]) => h('tr',
      h('th', { scope: 'row' }, label),
      h('td', h('div.barc',
        v > 0 && h('span.bar', { 'aria-hidden': 'true', style: { width: `max(2px, calc((100% - 84px) * ${(v / top).toFixed(4)}))` } }),
        h('span.barv', fmt(v)))),
      h('td.share', total > 0 ? share(v / total) : '—')))));
}

function tokens(t: MixVM['tokens'], requests: number, dollars: number, wuPerPct?: number): VNode {
  const input = t.input + t.cacheWrite + t.cacheRead;
  return h('p.cap', dots(`in ${compact(t.input)}`, `out ${compact(t.output)}`, `cache write ${compact(t.cacheWrite)}`, `cache read ${compact(t.cacheRead)}`,
    input > 0 && `cache reads ${round((100 * t.cacheRead) / input)}% of input tokens`, plural(requests, 'request'),
    `${usd(dollars)} API-equivalent${wuPerPct ? ` (1 pt ≈ ${usd(wuPerPct)})` : ''}`));
}

export function mix(m?: MixVM): VNode {
  if (!m) return h('p.cap', 'Waiting for this computer’s Claude Code logs.');
  if (!m.requests) return h('p.cap', 'No Claude Code requests on this computer in this window yet.');
  const pts = m.unit === 'pts', fmt = (v: number) => (pts ? `${v.toFixed(v >= 10 ? 1 : 2)} pts` : usd(v));
  return h('div.mix',
    h('div.mixg',
      bars('By model', m.byFamily.filter(f => f.value > 0 || f.requests > 0).map(f => [family(f.family), f.value]), fmt),
      bars('By token type', m.byPart.map(p => [PART[p.part], p.value]), fmt)),
    tokens(m.tokens, m.requests, m.usd, m.wuPerPct),
    !pts && h('p.cap', 'In $ API-equivalent: points appear once calibrated.'));
}

function calibText(b: BucketVM): string {
  const k = b.calib;
  if (b.state === 'calibrating' || !k.samples) return k.armed
    ? '1 of 2 ticks seen; the next one while you use Claude Code here completes calibration.'
    : TWO_TICKS;
  return dots(k.wuPerPct && `1% ≈ ${usd(k.wuPerPct)} API-equivalent`, plural(k.samples, 'calibration tick'),
    k.spread !== undefined && `model error ±${max(1, round(k.spread * 100))}% per point`);
}

export const calibration = (c: Ctx) => h('div.calib',
  h('ul', c.vm.buckets.map(b => h('li', h('div', h('b', b.long), chip(b)), h('p', calibText(b))))),
  button('Reset calibration…', 'resetCalibration', c));

const sec = (title: string, sub: string, body: Child) => h('section.sec', sechead(title, sub), body);

/** A view-surface disclosure: a 22 px button, collapsed by default, remembered per section. */
function disclosure(c: Ctx, id: string, title: string, body: () => Child): Child[] {
  const open = !!c.ui.open[id];
  return [
    h('button.disc', { 'aria-expanded': String(open), 'aria-controls': `tk-sec-${id}`, onclick: () => c.toggle('open', id) },
      icon(open ? 'chevron-down' : 'chevron-right'), title),
    h('div.discb', { id: `tk-sec-${id}`, hidden: !open }, open && body()),
  ];
}

export function detail(c: Ctx, b: BucketVM, tab: number): VNode {
  const d = c.detail?.key === b.key ? c.detail : undefined, pending = !!c.detail && !d;
  const kids: Child[] = c.surface === 'view'
    ? [windowFigure(c, b, d), facts(c, b),
      disclosure(c, 'zoom', BETWEEN, () => zoomFigure(c, b, d)),
      disclosure(c, 'mix', 'Where it went', () => mix(d?.mix)),
      disclosure(c, 'calib', 'Calibration', () => calibration(c))]
    : [h('div.r5', windowFigure(c, b, d), h('div.side', facts(c, b))),
      zoomFigure(c, b, d),
      h('div.r7', sec('Where it went', d ? `${b.long} window so far, this computer` : '', mix(d?.mix)),
        sec('Calibration', 'what 1% costs, learned from official ticks', calibration(c)))];
  return h('section.detail', { id: 'tk-detail', class: pending ? 'pending' : null, role: 'tabpanel', 'aria-labelledby': `tk-tab-${tab}`, 'aria-busy': pending ? 'true' : null }, kids);
}

/** Usage from this computer's logs alone, for when there are no official numbers to show. */
export function local(l: LocalVM): Child {
  if (!l.requests) return null;
  return sec('Where it went', `${l.label}, in $ API-equivalent`, h('div.mix',
    bars('By model', l.byFamily.map(f => [family(f.family), f.usd]), usd),
    tokens(l.tokens, l.requests, l.usd)));
}

export function signedOut(c: Ctx): VNode {
  // The reason names the folder searched; show it as a path, not prose.
  const m = c.vm.reasons.map(r => /^(Looked for .*? in )(.+?)(\.\s.*)?$/.exec(r));
  return h('section.empty',
    rune('empty', 32, true, 'dim'),
    h('h2', 'No Claude Code sign-in found'),
    h('p', 'Tokenomancer reads your plan usage with the Claude Code login on this computer. Sign in to Claude Code and this view fills in by itself.'),
    c.vm.reasons.map((r, i) => h('p.cap', m[i] ? [m[i]![1], h('code', m[i]![2]), '.'] : r)),
    h('div.acts', button('Preview with sample data', 'previewSampleData', c), button('Set Claude folder…', 'setClaudeDir', c, 'link')));
}

export function footer(c: Ctx): VNode {
  const vm = c.vm, role = vm.fresh.role === 'shared' ? 'another VS Code window reads the endpoint for this one' : 'this window reads the endpoint';
  return h('footer.foot',
    h('p', dots(`Official every ${round(vm.pollMs / 1000)} s`, role, 'logs stay on this computer', (c.busy || vm.fresh.refreshing) && 'Refreshing…')),
    vm.extras.length > 0 && h('p', vm.extras.map(e => `${e.label}: ${e.text}`).join(' · ')),
    vm.notes.map(n => h('p', n)));
}
