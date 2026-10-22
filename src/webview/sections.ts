// Everything below the cards: the selected limit's detail (window chart and facts, the Between
// chart, where the points went, calibration), the signed-out state and the footer.

import { BucketVM, Family, LocalVM, MixVM } from '../ui/types';
import { age, clock } from '../ui/time';
import { button, chip } from './cards';
import { Ctx } from './ctx';
import { Child, h, VNode } from './dom';
import { compact, etaRange, FAMILY, PART, rate, roundEta, share, usd, edgePct } from './fmt';
import { icon, rune } from './icons';
import { windowFigure } from './windowChart';
import { zoomFigure } from './zoomChart';

export function facts(c: Ctx, b: BucketVM): VNode {
  const vm = c.vm, p = b.pace, ms = c.ageMs(), rows: [string, string, string?][] = [];
  rows.push(['State', `${b.text.state} — ${b.text.stateTip}`]);
  rows.push(['Official', b.text.official + (ms !== undefined ? ` · ${age(ms, 'view')}` : '')]);
  if (b.lo !== undefined && b.hi !== undefined && b.state !== 'calibrating') rows.push(['Bounds', `${b.lo.toFixed(2)}–${b.hi.toFixed(2)}%`]);
  if (p?.nextTick) {
    const n = p.nextTick, at = clock(roundEta((n.from + n.to) / 2), vm.now, vm.fmt);
    rows.push(['Next 1%', `${edgePct(n.edge)} ${etaRange(n.from - vm.now, n.to - vm.now)} (~${at})`]);
  }
  if (p && (p.r15 !== undefined || p.rAvg !== undefined))
    rows.push(['Pace', [p.r15 !== undefined && `${rate(p.r15)} now (this computer)`, p.rAvg !== undefined && `${rate(p.rAvg)} window average`].filter(Boolean).join(' · ')]);
  rows.push(['Projection', b.text.verdict]);
  if (p) rows.push(['Even use', `${Math.abs(p.evenGap).toFixed(1)} pts ${p.evenGap >= 0 ? 'ahead' : 'below'}`]);
  if (b.text.resetsAt) rows.push(['Resets', b.text.resetsAt + (b.text.resetsIn ? ` (in ${b.text.resetsIn})` : '')]);
  if (b.calib.wuPerPct) rows.push(['1% ≈', `${usd(b.calib.wuPerPct)} API-equivalent`, 'API-price value of the tokens that move this limit 1 point; a translation, not a bill']);
  return h('dl', { class: 'tk-facts' }, rows.map(([t, v, tip]) => h('div', null, h('dt', { title: tip ?? null }, t), h('dd', null, v))));
}

function bars(title: string, rows: [string, number][], fmt: (v: number) => string): VNode {
  const total = rows.reduce((a, r) => a + r[1], 0), max = Math.max(1e-12, ...rows.map(r => r[1]));
  return h('table', { class: 'tk-bars' },
    h('caption', null, title),
    h('tbody', null, rows.map(([label, v]) => h('tr', null,
      h('th', { scope: 'row' }, label),
      h('td', null, h('div', { class: 'tk-barc' },
        v > 0 && h('span', { class: 'tk-bar', 'aria-hidden': 'true', style: { width: `max(2px, calc((100% - 84px) * ${(v / max).toFixed(4)}))` } }),
        h('span', { class: 'tk-barv' }, fmt(v)))),
      h('td', { class: 'tk-share' }, total > 0 ? share(v / total) : '—')))));
}

const tokensLine = (t: MixVM['tokens']) => {
  const input = t.input + t.cacheWrite + t.cacheRead;
  return [`in ${compact(t.input)}`, `out ${compact(t.output)}`, `cache write ${compact(t.cacheWrite)}`, `cache read ${compact(t.cacheRead)}`,
    input > 0 && `cache reads ${Math.round((100 * t.cacheRead) / input)}% of input tokens`];
};

export function mix(c: Ctx, m?: MixVM): VNode {
  if (!m) return h('p', { class: 'tk-cap' }, 'Waiting for this computer’s Claude Code logs.');
  const pts = m.unit === 'pts', fmt = (v: number) => (pts ? `${v.toFixed(v >= 10 ? 1 : 2)} pts` : usd(v));
  const fam = m.byFamily.filter(f => f.value > 0 || f.requests > 0);
  const foot = [...tokensLine(m.tokens), `${m.requests.toLocaleString('en-US')} request${m.requests === 1 ? '' : 's'}`,
    `${usd(m.usd)} API-equivalent${m.wuPerPct ? ` (1 pt ≈ ${usd(m.wuPerPct)})` : ''}`];
  return h('div', { class: 'tk-mix' },
    !m.requests ? h('p', { class: 'tk-cap' }, 'No Claude Code requests on this computer in this window yet.') : [
      h('div', { class: 'tk-mixg' },
        bars('By model', fam.map(f => [FAMILY[f.family] ?? 'Other', f.value]), fmt),
        bars('By token type', m.byPart.map(p => [PART[p.part], p.value]), fmt)),
      h('p', { class: 'tk-cap' }, foot.filter(Boolean).join(' · ')),
      !pts && h('p', { class: 'tk-cap' }, 'In $ API-equivalent: points appear once calibrated.'),
    ]);
}

function calibText(b: BucketVM): string {
  const k = b.calib;
  if (b.state === 'calibrating' || !k.samples) return k.armed
    ? '1 of 2 ticks seen. The next whole-number tick while you use Claude Code here completes calibration.'
    : 'Waiting for two whole-number ticks while you use Claude Code here.';
  return [k.wuPerPct && `1% ≈ ${usd(k.wuPerPct)} API-equivalent`, `${k.samples} calibration tick${k.samples === 1 ? '' : 's'}`,
    k.spread !== undefined && `model error ±${Math.max(1, Math.round(k.spread * 100))}% per point`].filter(Boolean).join(' · ');
}

export function calibration(c: Ctx): VNode {
  return h('div', { class: 'tk-calib' },
    h('ul', null, c.vm.buckets.map(b => h('li', null, h('span', { class: 'tk-cname' }, b.long), chip(b), h('span', { class: 'tk-ctext' }, calibText(b))))),
    button('Reset calibration…', 'resetCalibration', c));
}

const sec = (title: string, sub: string, body: Child) =>
  h('section', { class: 'tk-sec' }, h('div', { class: 'tk-sechead' }, h('h2', null, title), sub && h('span', { class: 'tk-sub' }, sub)), body);

/** A view-surface disclosure: a 22 px button, collapsed by default, remembered per section. */
function disclosure(c: Ctx, id: string, title: string, body: () => Child): Child[] {
  const open = !!c.ui.open[id];
  return [
    h('button', { class: 'tk-disc', type: 'button', 'aria-expanded': String(open), 'aria-controls': `tk-sec-${id}`, onclick: () => c.toggle('open', id) },
      icon(open ? 'chevron-down' : 'chevron-right'), title),
    h('div', { class: 'tk-discb', id: `tk-sec-${id}`, hidden: !open }, open && body()),
  ];
}

export function detail(c: Ctx, b: BucketVM, tab: number): VNode {
  const d = c.detail?.key === b.key ? c.detail : undefined, pending = !!c.detail && !d;
  const mixSub = d ? `${b.long} window so far, this computer` : '';
  const kids: Child[] = c.surface === 'view'
    ? [windowFigure(c, b, d), facts(c, b),
      disclosure(c, 'zoom', 'Between the whole numbers', () => zoomFigure(c, b, d)),
      disclosure(c, 'mix', 'Where it went', () => mix(c, d?.mix)),
      disclosure(c, 'calib', 'Calibration', () => calibration(c))]
    : [h('div', { class: 'tk-r5' }, windowFigure(c, b, d), h('div', { class: 'tk-side' }, facts(c, b))),
      h('div', { class: 'tk-r6' }, zoomFigure(c, b, d)),
      h('div', { class: 'tk-r7' }, sec('Where it went', mixSub, mix(c, d?.mix)), sec('Calibration', 'what 1% costs, learned from official ticks', calibration(c)))];
  return h('section', { id: 'tk-detail', class: `tk-detail${pending ? ' pending' : ''}`, role: 'tabpanel', 'aria-labelledby': `tk-tab-${tab}`, 'aria-busy': pending ? 'true' : null }, kids);
}

function localBars(l: LocalVM): VNode {
  const rows: [string, number][] = l.byFamily.map(f => [FAMILY[f.family as Family] ?? 'Other', f.usd]);
  return h('div', { class: 'tk-mix' },
    bars('By model', rows, usd),
    h('p', { class: 'tk-cap' }, [...tokensLine({ ...l.tokens }), `${l.requests.toLocaleString('en-US')} requests`, `${usd(l.usd)} API-equivalent`].filter(Boolean).join(' · ')));
}

/** Usage from this computer's logs alone, for when there are no official numbers to show. */
export function local(c: Ctx): Child {
  const l = c.vm.local;
  if (!l.requests) return null;
  return sec('Where it went', `${l.label}, in $ API-equivalent`, localBars(l));
}

export function signedOut(c: Ctx): VNode {
  return h('section', { class: 'tk-empty' },
    rune('empty', 32, true, 'tk-dim'),
    h('h2', null, 'No Claude Code sign-in found'),
    h('p', null, 'Tokenomancer reads your plan usage with the Claude Code login on this computer. Sign in to Claude Code and this view fills in by itself.'),
    c.vm.reasons.map(r => h('p', { class: 'tk-cap' }, r)),
    h('div', { class: 'tk-acts' }, button('Preview with sample data', 'previewSampleData', c), button('Set Claude folder…', 'setClaudeDir', c, 'tk-link')));
}

export function footer(c: Ctx): VNode {
  const vm = c.vm, role = vm.fresh.role === 'shared' ? 'another VS Code window reads the endpoint for this one' : 'this window reads the endpoint';
  return h('footer', { class: 'tk-foot' },
    h('p', null, [`Official every ${Math.round(vm.pollMs / 1000)} s`, role, 'logs stay on this computer', (c.busy || vm.fresh.refreshing) && 'Refreshing…'].filter(Boolean).join(' · ')),
    vm.extras.length > 0 && h('p', null, vm.extras.map(e => `${e.label}: ${e.text}`).join(' · ')),
    vm.notes.map(n => h('p', null, n)));
}
