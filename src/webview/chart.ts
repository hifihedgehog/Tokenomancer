// The parts both charts share: the focusable host (a group with a chart role description, the
// SVG itself hidden from screen readers), pointer and keyboard crosshair input, the tooltip, the
// live readout and the table-twin toggle.

import { Ctx, tableOpen } from './ctx';
import { Child, h, VNode } from './dom';
import { clamp } from './fmt';
import { icon } from './icons';

export interface Frame {
  id: string;
  label: string;                          // the chart's spoken summary
  W: number; H: number;
  left: number; right: number;            // plot edges in px
  t0: number; t1: number;                 // x domain
  step: number;                           // arrow-key step in ms
  home: number; end: number;              // Home/End targets
  start: number;                          // where the keyboard cursor appears
}

export interface Tip { x: number; y: number; rows: Child[]; text: string; mark?: boolean }

export function chartHost(c: Ctx, f: Frame, marks: Child[], tip?: Tip): VNode {
  const toT = (e: PointerEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const px = ((e.clientX - r.left) * f.W) / (r.width || f.W);
    return f.t0 + ((clamp(px, f.left, f.right) - f.left) / (f.right - f.left || 1)) * (f.t1 - f.t0);
  };
  const flip = tip && tip.x > f.W * 0.6;
  return h('div', {
    class: 'tk-chart', tabindex: 0, role: 'group', 'aria-roledescription': 'chart', 'aria-label': f.label, 'data-w': f.id,
    onpointermove: (e: PointerEvent) => { if (e.pointerType !== 'touch' || e.buttons) c.setCur({ id: f.id, t: toT(e), kbd: false }); },
    onpointerleave: () => { if (c.cur?.id === f.id && !c.cur.kbd) c.setCur(undefined); },
    onfocus: () => { if (c.cur?.id !== f.id) c.setCur({ id: f.id, t: f.start, kbd: true }); },
    onblur: () => { if (c.cur?.id === f.id) c.setCur(undefined); },
    onkeydown: (e: KeyboardEvent) => chartKey(c, f, e),
  },
    h('svg', { width: f.W, height: f.H, viewBox: `0 0 ${f.W} ${f.H}`, 'aria-hidden': 'true' }, marks),
    tip && h('div', {
      class: 'tk-tip', 'aria-hidden': 'true',
      style: { transform: `translate(${Math.round(tip.x + (flip ? -12 : 12))}px, ${Math.round(clamp(tip.y - 20, 0, f.H - 40))}px)${flip ? ' translateX(-100%)' : ''}` },
    }, tip.rows),
    h('div', { class: 'tk-sr', 'aria-live': 'polite' }, tip && c.cur?.kbd ? tip.text : ''));
}

function chartKey(c: Ctx, f: Frame, e: KeyboardEvent) {
  const t = c.cur?.id === f.id ? c.cur.t : f.start;
  const k = f.step * (e.shiftKey ? 10 : 1);
  const next = { ArrowRight: t + k, ArrowLeft: t - k, Home: f.home, End: f.end }[e.key];
  if (next !== undefined) {
    e.preventDefault();
    c.setCur({ id: f.id, t: clamp(next, f.t0, f.t1), kbd: true });
  } else if (e.key === 'Escape' && c.cur?.id === f.id) {
    e.preventDefault();
    c.setCur(undefined);
  }
}

/** A short stroke keying a tooltip or legend row to its mark. */
export function key(kind: 'line' | 'lane' | 'dash' | 'even' | 'band1' | 'band2' | 'tick' | 'rug'): VNode {
  const m: Record<string, VNode> = {
    line: h('rect', { class: 'tk-k-line', x: 0, y: 4, width: 14, height: 2, rx: 1 }),
    dash: h('path', { class: 'tk-proj', d: 'M0 5h14' }),
    even: h('rect', { class: 'tk-k-even', x: 0, y: 4.5, width: 14, height: 1 }),
    lane: h('rect', { class: 'tk-k-lane', x: 0.5, y: 1.5, width: 13, height: 7 }),
    band1: h('rect', { class: 'tk-band1', x: 0, y: 1, width: 14, height: 8 }),
    band2: h('rect', { class: 'tk-band2', x: 0, y: 1, width: 14, height: 8 }),
    tick: h('path', { class: 'tk-k-tick', d: 'M1 2v6M13 2v6M1 5h12' }),
    rug: h('path', { class: 'tk-k-rug', d: 'M2 3v4M6 3v4M10 3v4' }),
  };
  return h('svg', { class: 'tk-key', width: 14, height: 10, viewBox: '0 0 14 10', 'aria-hidden': 'true' }, m[kind]);
}

export function legend(items: [Parameters<typeof key>[0], string][]): VNode {
  return h('ul', { class: 'tk-legend' }, items.map(([k, label]) => h('li', null, key(k), label)));
}

/** A section heading with its subtitle and, for charts, the Table toggle. */
export function sectionHead(c: Ctx, title: string, sub: string, tableId?: string): VNode {
  const open = tableId ? tableOpen(c, tableId) : false;
  return h('div', { class: 'tk-sechead' },
    h('h2', null, title),
    sub && h('span', { class: 'tk-sub' }, sub),
    tableId && h('button', { class: 'tk-tbtn', type: 'button', 'aria-pressed': String(open), onclick: () => c.toggle('tables', tableId) }, icon('table'), 'Table'));
}

export function table(caption: string, head: string[], rows: Child[][]): VNode {
  return h('div', { class: 'tk-twin' },
    h('table', null,
      h('caption', { class: 'tk-sr' }, caption),
      h('thead', null, h('tr', null, head.map(x => h('th', { scope: 'col' }, x)))),
      h('tbody', null, rows.map(r => h('tr', null, r.map((x, i) => i ? h('td', null, x) : h('th', { scope: 'row' }, x)))))));
}

/** Tooltip row: key, the value in strong ink, then what it is. */
export const tipRow = (k: Parameters<typeof key>[0] | null, value: string, what: string) =>
  h('div', { class: 'tk-tr' }, k ? key(k) : h('span', { class: 'tk-key' }), h('b', null, value), what && h('span', null, what));
