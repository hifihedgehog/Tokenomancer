// The parts both charts share: the figure (heading, Table toggle, caption, table twin), the
// focusable host (a group with a chart role description; the SVG itself is hidden from screen
// readers), pointer and keyboard crosshair input, the tooltip, the live readout, keys and labels.

import { digitsFor, pmText } from '../ui/present';
import { axisHour } from '../ui/time';
import { BucketVM, Lane, ViewModel } from '../ui/types';
import { Ctx, tableOpen } from './ctx';
import { Child, h, rect, VNode } from './dom';
import { clamp, max, round } from './fmt';
import { icon } from './icons';
import { f1, fitLabels, laneAt, nearest, textW } from './scale';

export interface Plot {
  id: 'win' | 'zoom';
  label: string;                          // the chart's spoken summary
  W: number; H: number;
  L: number; R: number; T: number; B: number;   // plot edges in px
  t0: number; t1: number;                 // x domain
  step: number;                           // arrow-key step in ms
  end: number;                            // where End and the keyboard cursor land (now)
}

export interface Tip { x: number; y?: number; rows: Child[]; text: string }

export interface FigureParts {
  title: string; sub: string;
  marks: Child[];                         // inside the plot clip
  over?: Child[];                         // unclipped: axes, labels
  tip?: Tip;
  note?: string;                          // a message centred over the plot
  legend: [Key, string][];
  caps: (string | false | undefined)[];
  table?: () => VNode;
}

export const crisp = (v: number) => round(v) + 0.5;
export const officialOf = (l: Lane, vm: ViewModel) => (vm.rounding === 'round' ? l.lo + 0.5 : l.lo);

/** SVG text with a surface halo so it stays legible over marks. */
export const label = (x: number, y: number, s: string, cls = 'lbl', anchor = 'start') =>
  h('text', { class: cls + ' halo', x: f1(x), y: f1(y), 'text-anchor': anchor }, s);

/** Hour labels at the given instants, centred, dropping any that would collide. */
export function hourLabels(c: Ctx, ts: number[], X: (t: number) => number, y: number, lo: number, hi: number): Child[] {
  const ls = ts.map(t => axisHour(t, c.vm.fmt)), xs = ts.map(X), keep = fitLabels(xs, ls.map(s => textW(s, 11)), 10, lo, hi);
  return ts.map((_, i) => keep[i] && label(xs[i], y, ls[i], 'axl', 'middle'));
}

/** A section heading, its subtitle, and anything aligned to its right. */
export const sechead = (title: string, sub: string, ...right: Child[]) => h('div.sechead', h('h2', title), sub && h('span.sub', sub), right);

export const hline = (cls: string, x1: number, x2: number, y: number) => h('line', { class: cls, x1, x2, y1: crisp(y), y2: crisp(y) });
export const vline = (cls: string, x: number, y1: number, y2: number) => h('line', { class: cls, x1: crisp(x), x2: crisp(x), y1, y2 });

/** Official runs: one fill path and one edge path. With `join`, runs less than that many ms apart
 *  share one staircase along their floors (a tick is one poll wide, so separate runs would read as
 *  dashes); without it each run gets its floor and its ceiling, as the zoom chart needs. */
export function lanePaths(lanes: Lane[], X: (t: number) => number, Y: (v: number) => number, join = 0): VNode[] {
  let fill = '', edge = '', prev: Lane | undefined;
  for (const l of lanes) {
    const a = X(l.from), x0 = f1(a), x1 = f1(max(X(l.to), a + 1)), yt = f1(Y(l.hi)), yb = f1(Y(l.lo));
    fill += `M${x0} ${yt}H${x1}V${yb}H${x0}Z`;
    edge += !join ? `M${x0} ${yb}H${x1}M${x0} ${yt}H${x1}`
      : (prev && l.from - prev.to <= join ? `H${f1((X(prev.to) + a) / 2)}V${yb}` : `M${x0} ${yb}`) + `H${x1}`;
    prev = l;
  }
  return [h('path.lane', { d: fill }), h('path.ledge', { d: edge })];
}

export function figure(c: Ctx, f: Plot, o: FigureParts): VNode {
  const tip = c.cur?.id === f.id ? o.tip : undefined, open = tableOpen(c, f.id);
  const toT = (e: PointerEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const px = ((e.clientX - r.left) * f.W) / (r.width || f.W);
    return f.t0 + ((clamp(px, f.L, f.R) - f.L) / (f.R - f.L || 1)) * (f.t1 - f.t0);
  };
  const flip = tip && tip.x > f.W * 0.6;
  const clip = `tk-clip-${f.id}`;
  return h('figure.fig',
    sechead(o.title, o.sub, h('button.tbtn', { 'aria-pressed': String(open), onclick: () => c.toggle('tables', f.id) }, icon('table'), 'Table')),
    h('div.chart', {
      class: f.id, tabindex: 0, role: 'group', 'aria-roledescription': 'chart', 'aria-label': f.label, 'data-w': f.id,
      onpointermove: (e: PointerEvent) => { if (e.pointerType !== 'touch' || e.buttons) c.setCur({ id: f.id, t: toT(e), kbd: false }); },
      onpointerleave: () => { if (c.cur?.id === f.id && !c.cur.kbd) c.setCur(undefined); },
      onfocus: () => { if (c.cur?.id !== f.id) c.setCur({ id: f.id, t: f.end, kbd: true }); },
      onblur: () => { if (c.cur?.id === f.id) c.setCur(undefined); },
      onkeydown: (e: KeyboardEvent) => chartKey(c, f, e),
    },
      h('svg', { width: f.W, height: f.H, viewBox: `0 0 ${f.W} ${f.H}` },
        h('clipPath', { id: clip }, rect(null, f.L, f.T - 1, max(0, f.R - f.L), f.B - f.T + 2)),
        h('g', { 'clip-path': `url(#${clip})` }, o.marks),
        o.over,
        tip && [vline('cross', tip.x, f.T, f.B), tip.y !== undefined && h('circle.dotm', { cx: f1(tip.x), cy: f1(tip.y), r: 3.5 })]),
      o.note && h('div.note', h('span', o.note)),
      tip && h('div.tip', {
        'aria-hidden': 'true',
        style: { transform: `translate(${round(tip.x + (flip ? -12 : 12))}px,${round(clamp((tip.y ?? f.T) - 20, 0, f.H - 40))}px)${flip ? ' translateX(-100%)' : ''}` },
      }, tip.rows),
      h('div.sr', { 'aria-live': 'polite' }, tip && c.cur?.kbd ? tip.text : '')),
    h('figcaption', h('ul.legend', o.legend.map(([k, s]) => h('li', key(k), s))), o.caps.map(s => s && h('p.cap', s))),
    open && o.table?.());
}

function chartKey(c: Ctx, f: Plot, e: KeyboardEvent) {
  const t = c.cur?.id === f.id ? c.cur.t : f.end, k = f.step * (e.shiftKey ? 10 : 1);
  const next = { ArrowRight: t + k, ArrowLeft: t - k, Home: f.t0, End: f.end }[e.key];
  if (next !== undefined) {
    e.preventDefault();
    c.setCur({ id: f.id, t: clamp(next, f.t0, f.t1), kbd: true });
  } else if (e.key === 'Escape' && c.cur?.id === f.id) {
    e.preventDefault();
    c.setCur(undefined);
  }
}

export type Key = 'line' | 'lane' | 'dash' | 'even' | 'band1' | 'band2' | 'tick' | 'rug';
const KEYS: Record<Key, [string, string]> = {
  line: ['line', 'M0 5h14'], dash: ['proj', 'M0 5h14'], even: ['even', 'M0 5.5h14'],
  lane: ['klane', 'M.5 1.5h13v7H.5z'], band1: ['band1', 'M0 1h14v8H0z'], band2: ['band2', 'M0 1h14v8H0z'],
  tick: ['tickbar', 'M1 2v6m12-6v6M1 5h12'], rug: ['rug', 'M2 3v4m4-4v4m4-4v4'],
};

/** A short stroke keying a tooltip or legend row to its mark. */
export const key = (k: Key) => h('svg.key', { viewBox: '0 0 14 10' }, h('path', { class: KEYS[k][0], d: KEYS[k][1] }));

type Est = { t: number[]; v: number[]; s: number[]; lo?: number[]; hi?: number[]; flat?: boolean[] };

/** Estimate, ±1σ and official at vertex i (−1: none) and time t, as tooltips and tables print them. */
export function cells(c: Ctx, b: BucketVM, e: Est, i: number, lanes: Lane[], t: number) {
  const flat = i >= 0 && !!e.flat?.[i], dg = i >= 0 ? digitsFor(e.s[i], max(b.digits, 1)) : 0, l = laneAt(lanes, t);
  return {
    v: i < 0 ? '—' : flat ? `${e.lo![i].toFixed(1)}–${e.hi![i].toFixed(1)}%` : `${e.v[i].toFixed(dg)}%`,
    pm: i < 0 || flat ? '—' : pmText(e.s[i], dg).slice(1),
    off: l ? `${officialOf(l, c.vm)}%` : '—',
    flat, y: i < 0 ? (l && l.lo + 0.5) : flat ? (e.lo![i] + e.hi![i]) / 2 : e.v[i],
  };
}

/** A tooltip row: a key, the value in strong ink, what it is. Rows without a value are events. */
export type Row = [Key | null, string, string];

/** The estimate vertex nearest t and the official run there. */
export function readout(c: Ctx, b: BucketVM, e: Est, lanes: Lane[], t: number): { t: number; y?: number; rows: Row[] } {
  const i = nearest(e.t, t), at = i < 0 ? t : e.t[i], x = cells(c, b, e, i, lanes, at), rows: Row[] = [];
  if (i >= 0) rows.push(x.flat ? ['band2', x.v, 'loose bounds'] : ['line', x.v, `±${x.pm} estimate`]);
  if (x.off !== '—') rows.push(['lane', x.off, 'official']);
  return { t: at, y: x.y, rows };
}

/** The tooltip and its spoken twin for the keyboard readout. */
export const tip = (x: number, y: number | undefined, head: string, rows: Row[]): Tip => ({
  x, y, text: `${head}: ${rows.map(r => (r[1] ? `${r[1]} ${r[2]}` : r[2])).join(', ') || 'no reading'}`,
  rows: [h('div.th', head), rows.length ? rows.map(([k, v, w]) => (v ? h('div.tr', k && key(k), h('b', v), h('span', w)) : h('div.tr.tev', w)))
    : h('div.tr', 'No reading at this time')],
});

export function table(caption: string, head: string[], rows: string[][]): VNode {
  return h('div.twin',
    h('table',
      h('caption.sr', caption),
      h('thead', h('tr', head.map(x => h('th', { scope: 'col' }, x)))),
      h('tbody', rows.map(r => h('tr', r.map((x, i) => (i ? h('td', x) : h('th', { scope: 'row' }, x))))))));
}
