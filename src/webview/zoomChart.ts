// "Between the whole numbers": the honesty proof. A few official whole numbers magnified, where
// the endpoint said you were (lanes), when it ticked (the interval between two readings), every
// reading (the rug), and the estimate as it was recorded at the time, tightening at each tick.

import { BucketVM, DetailVM, TimeFmt, ZoomSeries } from '../ui/types';
import { axisHour, span } from '../ui/time';
import { chartHost, legend, sectionHead, table, Tip, tipRow } from './chart';
import { Ctx, tableOpen } from './ctx';
import { Child, h, VNode } from './dom';
import { clamp, digitsFor, edgePct, hms, localBoundaries, pm, roundEta } from './fmt';
import { bandPath, f1, fitLabels, laneAt, linePath, nearest, scale, textW } from './scale';
import { crisp, label, officialOf } from './windowChart';

const MIN = 60_000;

/** Greedy word wrap by estimated width. */
function wrap(s: string, w: number, px: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of s.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && textW(next, px) > w) { out.push(line); line = word; } else line = next;
  }
  return line ? [...out, line] : out;
}

function message(x: number, y: number, s: string, w: number): VNode {
  const lines = wrap(s, w, 12);
  return h('text', { class: 'tk-msg tk-halo', x: f1(x), y: f1(y - (lines.length - 1) * 8), 'text-anchor': 'middle' },
    lines.map((l, i) => h('tspan', { x: f1(x), dy: i ? 16 : 0 }, l)));
}

/** Silences in the readings longer than three poll intervals, including one running up to now. */
function gaps(z: ZoomSeries, now: number, pollMs: number): [number, number][] {
  const ok = [...z.polls].sort((a, b) => a - b), out: [number, number][] = [];
  for (let i = 1; i <= ok.length; i++) {
    const a = ok[i - 1], e = i < ok.length ? ok[i] : now;
    if (e - a > 3 * pollMs) out.push([a, e]);
  }
  return out;
}

export function zoomFigure(c: Ctx, b: BucketVM, d?: DetailVM): VNode {
  const vm = c.vm, fmt = vm.fmt, z = d?.zoom, now = d?.window.now ?? vm.now;
  const W = c.w('zoom', 860), H = c.surface === 'view' ? 150 : 180;
  const L = 40, R = W - 96, T = 10, B = H - 34;
  const marks: Child[] = [];
  const sub = z ? `${b.long}, last ${span(z.to - z.from)}` : b.long;
  if (!z) {
    marks.push(message((L + R) / 2, (T + B) / 2, 'Waiting for the first reading.', R - L));
    return figure(c, b, d, sub, W, H, marks, undefined, { L, R, t0: 0, t1: 1, now, step: MIN });
  }

  const nt = b.pace?.nextTick, spanMs = z.to - z.from;
  const mid = nt && (nt.from + nt.to) / 2;
  const nextT = mid && mid > now && mid - now <= spanMs * 0.25 ? mid : undefined;
  const t1 = nextT ? nextT + spanMs * 0.03 : Math.max(z.to, now);
  const X = scale(z.from, t1, L, R), Y = scale(z.yMin, z.yMax, B, T);
  const cv = (v: number) => clamp(v, z.yMin, z.yMax);

  // Edges: one gridline per official whole number.
  for (const e of z.edges) marks.push(h('line', { class: 'tk-grid', x1: L, x2: R, y1: crisp(Y(e)), y2: crisp(Y(e)) }), label(L - 6, Y(e) + 4, edgePct(e), 'tk-axl', 'end'));
  marks.push(...timeAxis(z.from, t1, X, B, fmt));

  // Official "said so" regions.
  let dl = '', de = '';
  for (const l of z.lanes) {
    const x0 = X(Math.max(l.from, z.from)), x1 = Math.max(X(l.to), x0 + 1), ya = Y(cv(l.hi)), yb = Y(cv(l.lo));
    dl += `M${f1(x0)} ${f1(ya)}H${f1(x1)}V${f1(yb)}H${f1(x0)}Z`;
    de += `M${f1(x0)} ${f1(ya)}H${f1(x1)}M${f1(x0)} ${f1(yb)}H${f1(x1)}`;
  }
  marks.push(h('path', { class: 'tk-lane', d: dl }), h('path', { class: 'tk-lane-edge', d: de }));

  // Recorded estimate: graded ribbons clipped to its proven bounds; loose stretches are one flat band.
  const hs = z.hist, xs = hs.t.map(X), n = hs.t.length;
  const yy: number[][] = [[], [], [], [], [], []], line: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = hs.v[i], s = hs.s[i], flat = hs.flat[i];
    const lo = isFinite(hs.lo[i]) ? hs.lo[i] : -Infinity, hi = isFinite(hs.hi[i]) ? hs.hi[i] : Infinity;
    const seg = (k: number, a: number, e: number, on: boolean) => {
      const p = Math.max(a, lo), q = Math.min(e, hi), ok = on && p < q;
      yy[k].push(ok ? Y(cv(p)) : NaN);
      yy[k + 1].push(ok ? Y(cv(q)) : NaN);
    };
    seg(0, v - 2 * s, v + 2 * s, !flat);
    seg(2, v - s, v + s, !flat);
    seg(4, lo, hi, flat);
    line.push(flat ? NaN : Y(cv(v)));
  }
  marks.push(
    h('path', { class: 'tk-band2', d: bandPath(xs, yy[4], yy[5]) }),
    h('path', { class: 'tk-band2', d: bandPath(xs, yy[0], yy[1]) }),
    h('path', { class: 'tk-band1', d: bandPath(xs, yy[2], yy[3]) }),
    h('path', { class: 'tk-line', d: linePath(xs, line) }));

  // Tick intervals: the official number crossed this edge somewhere between two readings.
  let dt = '';
  for (const k of z.ticks) {
    const y = f1(Y(k.edge)), x0 = X(k.from), x1 = Math.max(X(k.to), x0 + 2);
    dt += `M${f1(x0)} ${y}H${f1(x1)}M${f1(x0)} ${f1(Y(k.edge) - 3)}v6M${f1(x1)} ${f1(Y(k.edge) - 3)}v6`;
  }
  marks.push(h('path', { class: 'tk-tickbar', d: dt }));

  // The poll rug, its failures and its silences.
  const ry = B + 6;
  marks.push(h('path', { class: 'tk-rug', d: z.polls.map(t => `M${f1(X(t))} ${ry}v4`).join('') }),
    h('path', { class: 'tk-fail', d: z.failed.map(t => `M${f1(X(t) - 2)} ${ry}l4 4m0-4l-4 4`).join('') }));
  for (const [a, e] of gaps(z, now, vm.pollMs)) {
    const s = e >= now ? `no readings since ${axisHour(a, fmt)}` : `no readings ${axisHour(a, fmt)}–${axisHour(e, fmt)}`;
    if (X(e) - X(a) >= textW(s, 11) + 12) marks.push(label((X(a) + X(e)) / 2, ry + 7, s, 'tk-lbl', 'middle'));
  }

  const xn = X(now), calibrating = b.state === 'calibrating' || !n;
  marks.push(h('line', { class: 'tk-now', x1: crisp(xn), x2: crisp(xn), y1: T, y2: B }));
  if (calibrating) {
    const s = b.calib.armed
      ? 'Waiting for one more whole-number tick while you use Claude Code here (1 of 2 seen).'
      : 'Waiting for the official number to tick twice while you use Claude Code here.';
    marks.push(message((L + R) / 2, (T + B) / 2 + 4, s, Math.min(R - L - 24, 420)));
  } else {
    const v = b.value, yv = Y(cv(v));
    if (nextT && nt) {
      const xe = X(nextT), ye = Y(cv(nt.edge));
      marks.push(h('path', { class: 'tk-proj', d: `M${f1(xn)} ${f1(yv)}L${f1(xe)} ${f1(ye)}` }),
        h('path', { class: 'tk-acd', d: `M${f1(xe)} ${f1(ye - 3.5)}l3.5 3.5-3.5 3.5-3.5-3.5z` }),
        label(xe, ye - 8 < T + 10 ? ye + 18 : ye - 8, `${edgePct(nt.edge)} ~${axisHour(roundEta(nextT), fmt)}`, 'tk-lblf', 'middle'));
    }
    if (b.loupe.mode === 'flat' && b.lo !== undefined && b.hi !== undefined) {
      marks.push(h('rect', { class: 'tk-band1', x: f1(xn - 2), y: f1(Y(cv(b.hi))), width: 4, height: f1(Math.max(2, Y(cv(b.lo)) - Y(cv(b.hi)))) }));
    } else marks.push(h('circle', { class: 'tk-dotm', cx: f1(xn), cy: f1(yv), r: 4 }));
    if (R - xn > 12) marks.push(h('line', { class: 'tk-leader', x1: f1(xn + 6), x2: R + 4, y1: crisp(yv), y2: crisp(yv) }));
    const ly = clamp(yv + 4, T + 12, B - 18), sub2 = [b.text.pm, b.text.state].filter(Boolean).join(' · ');
    marks.push(label(R + 8, ly, b.text.value, 'tk-endv'), label(R + 8, ly + 16, sub2, 'tk-lbl12'));
    if (nt && !nextT && mid && mid > now) marks.push(label(R + 8, ly + 32, `next ${edgePct(nt.edge)} ~${axisHour(roundEta(mid), fmt)}`, 'tk-lbl12'));
  }

  return figure(c, b, d, sub, W, H, marks, tooltip(c, b, z, X, Y, now, t1), { L, R, t0: z.from, t1, now, step: spanMs <= 3_600_000 ? MIN : 5 * MIN });
}

function stepFor(spanMs: number): number {
  const m = spanMs / MIN;
  return m <= 40 ? 5 : m <= 70 ? 10 : m <= 130 ? 15 : m <= 200 ? 30 : 60;
}

function timeAxis(t0: number, t1: number, X: (t: number) => number, B: number, fmt: TimeFmt): Child[] {
  const ticks = localBoundaries(t0, t1, stepFor(t1 - t0), fmt.timeZone), xs = ticks.map(X), ls = ticks.map(t => axisHour(t, fmt));
  const keep = fitLabels(xs, ls.map(s => textW(s, 11)), 12, X(t0) - 30, X(t1) + 30);
  return ticks.map((t, i) => keep[i] && label(xs[i], B + 26, ls[i], 'tk-axl', 'middle'));
}

function events(z: ZoomSeries, fmt: TimeFmt): [number, string][] {
  return [
    ...z.ticks.map(k => [k.to, `Ticked to ${edgePct(k.edge)} between ${hms(k.from, fmt)} and ${hms(k.to, fmt)}`] as [number, string]),
    ...z.failed.map(t => [t, `Poll failed at ${hms(t, fmt)}`] as [number, string]),
  ];
}

function tooltip(c: Ctx, b: BucketVM, z: ZoomSeries, X: (t: number) => number, Y: (v: number) => number, now: number, t1: number): Tip | undefined {
  if (c.cur?.id !== 'zoom') return;
  const fmt = c.vm.fmt, hs = z.hist, rows: Child[] = [], text: string[] = [];
  let t = clamp(c.cur.t, z.from, Math.min(t1, now)), yv: number | undefined;
  const i = nearest(hs.t, t);
  if (i >= 0) {
    t = hs.t[i];
    if (hs.flat[i]) {
      const s = `${hs.lo[i].toFixed(1)}–${hs.hi[i].toFixed(1)}%`;
      rows.push(tipRow('band2', s, 'loose bounds')); text.push(`between ${s}, loose`);
      yv = (hs.lo[i] + hs.hi[i]) / 2;
    } else {
      const dg = digitsFor(hs.s[i], Math.max(b.digits, 1));
      rows.push(tipRow('line', `${hs.v[i].toFixed(dg)}%`, `${pm(hs.s[i], dg)} estimate`)); text.push(`estimate ${hs.v[i].toFixed(dg)}% ${pm(hs.s[i], dg)}`);
      yv = hs.v[i];
    }
  }
  const l = laneAt(z.lanes, t);
  if (l) { rows.push(tipRow('lane', `${officialOf(l, c.vm)}%`, 'official')); text.push(`official ${officialOf(l, c.vm)}%`); }
  const tol = (8 * (t1 - z.from)) / Math.max(1, X(t1) - X(z.from));
  for (const k of z.ticks) if (t >= k.from - tol && t <= k.to + tol) {
    const s = `Ticked to ${edgePct(k.edge)} between ${hms(k.from, fmt)} and ${hms(k.to, fmt)}`;
    rows.push(h('div', { class: 'tk-tr tk-tev' }, s)); text.push(s);
  }
  for (const f of z.failed) if (Math.abs(f - t) <= tol) { rows.push(h('div', { class: 'tk-tr tk-tev' }, `Poll failed at ${hms(f, fmt)}`)); text.push('poll failed'); }
  return {
    x: X(t), y: Y(clamp(yv ?? (z.yMin + z.yMax) / 2, z.yMin, z.yMax)), mark: yv !== undefined,
    text: `${hms(t, fmt)}: ${text.join(', ') || 'no reading'}`,
    rows: [h('div', { class: 'tk-th' }, hms(t, fmt)), rows.length ? rows : h('div', { class: 'tk-tr' }, 'No reading at this time')],
  };
}

function figure(c: Ctx, b: BucketVM, d: DetailVM | undefined, sub: string, W: number, H: number, marks: Child[], tip: Tip | undefined,
  g: { L: number; R: number; t0: number; t1: number; now: number; step: number }): VNode {
  if (tip) {
    marks.push(h('line', { class: 'tk-cross', x1: crisp(tip.x), x2: crisp(tip.x), y1: 10, y2: H - 34 }));
    if (tip.mark) marks.push(h('circle', { class: 'tk-dotm', cx: f1(tip.x), cy: f1(tip.y), r: 3.5 }));
  }
  const z = d?.zoom, loose = b.loupe.mode === 'flat';
  const host = chartHost(c, {
    id: 'zoom', label: `Between the whole numbers, ${sub}. ${z ? `${z.ticks.length} official ticks and ${z.polls.length} readings shown. ` : ''}${b.text.spoken}.`,
    W, H, left: g.L, right: g.R, t0: g.t0, t1: g.t1, step: g.step, home: g.t0, end: g.now, start: g.now,
  }, marks, tip);
  return h('figure', { class: 'tk-fig' },
    sectionHead(c, 'Between the whole numbers', sub, 'zoom'),
    host,
    h('figcaption', null,
      legend([['line', 'Estimate as recorded'], ['band1', '±1σ, about 68%'], ['band2', '±2σ, about 95%'], ['lane', 'Official whole number'], ['tick', 'Tick, between two readings'], ['rug', 'Readings']]),
      h('p', { class: 'tk-cap' }, loose
        ? 'Loose: usage outside this computer moved the official number, so the estimate is only bounded to the band until the next tick.'
        : 'Each band is one official whole percent. The estimate stays inside the band the endpoint reported and tightens at each tick.')),
    z && tableOpen(c, 'zoom') && zoomTable(c, b, z));
}

function zoomTable(c: Ctx, b: BucketVM, z: ZoomSeries): VNode {
  const fmt = c.vm.fmt, hs = z.hist, step = Math.max(1, Math.ceil(hs.t.length / 36));
  const rows: [number, string[]][] = [];
  for (let i = 0; i < hs.t.length; i += step) {
    const t = hs.t[i], l = laneAt(z.lanes, t), dg = digitsFor(hs.s[i], Math.max(b.digits, 1));
    rows.push([t, [axisHour(t, fmt),
      hs.flat[i] ? `${hs.lo[i].toFixed(1)}–${hs.hi[i].toFixed(1)}%` : `${hs.v[i].toFixed(dg)}%`,
      hs.flat[i] ? '—' : pm(hs.s[i], dg).slice(1), l ? `${officialOf(l, c.vm)}%` : '—', '']]);
  }
  for (const [t, s] of events(z, fmt)) rows.push([t, [hms(t, fmt), '', '', '', s]]);
  rows.sort((a, b2) => a[0] - b2[0]);
  return table(`Between the whole numbers, ${b.long}`, ['Time', 'Estimate', '±1σ', 'Official', 'Event'], rows.map(r => r[1]));
}
