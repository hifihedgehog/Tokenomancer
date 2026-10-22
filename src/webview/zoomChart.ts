// "Between the whole numbers": the honesty proof. A few official whole numbers magnified, where
// the endpoint said you were (lanes), when it ticked (the interval between two readings), every
// reading (the rug), and the estimate as it was recorded at the time, tightening at each tick.

import { roundClock } from '../ui/present';
import { axisHour, span } from '../ui/time';
import { BucketVM, DetailVM, ZoomSeries } from '../ui/types';
import { cells, figure, hline, hourLabels, Key, label, lanePaths, Plot, readout, table, tip, Tip, vline } from './chart';
import { Ctx } from './ctx';
import { Child, h, rect, VNode } from './dom';
import { BETWEEN, ceil, clamp, dots, edgePct, hms, localBoundaries, max, min, round, TWO_TICKS, WAITING } from './fmt';
import { bandPath, f1, fitLabels, linePath, scale, textW } from './scale';

const MIN = 60_000;

/** Silences in the readings longer than three poll intervals, including one running up to now. */
export function gaps(polls: number[], now: number, pollMs: number): [number, number][] {
  const ok = [...polls].sort((a, b) => a - b), out: [number, number][] = [];
  for (let i = 1; i <= ok.length; i++) {
    const a = ok[i - 1], e = i < ok.length ? ok[i] : now;
    if (e - a > 3 * pollMs) out.push([a, e]);
  }
  return out;
}

const tickText = (k: ZoomSeries['ticks'][0], c: Ctx) => `Ticked to ${edgePct(k.edge)} between ${hms(k.from, c.vm.fmt)} and ${hms(k.to, c.vm.fmt)}`;

export function zoomFigure(c: Ctx, b: BucketVM, d?: DetailVM): VNode {
  const vm = c.vm, fmt = vm.fmt, z = d?.zoom, now = d?.window.now ?? vm.now;
  const W = c.w('zoom', 860), H = c.surface === 'view' ? 160 : 190;
  const L = 40, R = W - 96, T = 22, B = H - 34;
  const sub = z ? `${b.long}, last ${span(z.to - z.from)}` : b.long;
  const base = { title: BETWEEN, sub, marks: [] as Child[], over: [] as Child[], legend: [] as [Key, string][], caps: [] as string[] };
  const plot: Plot = { id: 'zoom', label: `${BETWEEN}, ${sub}.`, W, H, L, R, T, B, t0: 0, t1: 1, step: MIN, end: 1 };
  if (!z) return figure(c, plot, { ...base, note: WAITING });

  const { marks, over, legend, caps } = base, hs = z.hist, n = hs.t.length;
  const nt = b.pace?.nextTick, spanMs = z.to - z.from, mid = nt && (nt.from + nt.to) / 2;
  const nextT = mid && mid > now && mid - now <= spanMs * 0.25 ? mid : undefined;
  const t1 = nextT ? nextT + spanMs * 0.03 : max(z.to, now);
  const X = scale(z.from, t1, L, R), Y = scale(z.yMin, z.yMax, B, T);
  Object.assign(plot, { t0: z.from, t1, end: min(now, t1), step: spanMs <= 3_600_000 ? MIN : 5 * MIN });
  plot.label = `${BETWEEN}, ${sub}. ${z.ticks.length} official ticks and ${z.polls.length} readings shown. ${b.text.spoken}.`;

  for (const e of z.edges) marks.push(hline('grid', L, R, Y(e))), over.push(label(L - 6, Y(e) + 4, edgePct(e), 'axl', 'end'));
  over.push(...timeAxis(c, z.from, t1, X, B));
  marks.push(...lanePaths(z.lanes, X, Y));

  // Recorded estimate: graded ribbons clipped to its proven bounds; loose stretches are one flat band.
  const xs = hs.t.map(X), yy: number[][] = [[], [], [], [], [], []], line: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = hs.v[i], s = hs.s[i], flat = hs.flat[i];
    const lo = isFinite(hs.lo[i]) ? hs.lo[i] : -Infinity, hi = isFinite(hs.hi[i]) ? hs.hi[i] : Infinity;
    [[v - 2 * s, v + 2 * s, !flat], [v - s, v + s, !flat], [lo, hi, flat]].forEach(([a, e, on], k) => {
      const p = max(a as number, lo), q = min(e as number, hi), ok = on && p < q;
      yy[2 * k].push(ok ? Y(p) : NaN);
      yy[2 * k + 1].push(ok ? Y(q) : NaN);
    });
    line.push(flat ? NaN : Y(v));
  }
  marks.push(h('path.band2', { d: bandPath(xs, yy[4], yy[5]) }), h('path.band2', { d: bandPath(xs, yy[0], yy[1]) }),
    h('path.band1', { d: bandPath(xs, yy[2], yy[3]) }), h('path.line', { d: linePath(xs, line) }));

  // Tick intervals: the official number crossed this edge somewhere between two readings.
  const ticks = z.ticks.filter(k => k.edge >= z.yMin && k.edge <= z.yMax && k.to >= z.from);
  over.push(h('path.tickbar', {
    d: ticks.map(k => {
      const y = Y(k.edge), x0 = max(L, X(k.from)), x1 = max(X(k.to), x0 + 2);
      return `M${f1(x0)} ${f1(y)}H${f1(x1)}M${f1(x0)} ${f1(y - 3)}v6M${f1(x1)} ${f1(y - 3)}v6`;
    }).join(''),
  }));

  // The poll rug and its failures; the rug's own gaps show silences, and the caption names them.
  const ry = B + 6, inSpan = (t: number) => t >= z.from && t <= t1;
  over.push(h('path.rug', { d: z.polls.filter(inSpan).map(t => `M${f1(X(t))} ${ry}v4`).join('') }),
    h('path.fail', { d: z.failed.filter(inSpan).map(t => `M${f1(X(t) - 2)} ${ry}l4 4m0-4l-4 4`).join('') }));
  for (const [a, e] of gaps(z.polls, now, vm.pollMs)) {
    if (e >= z.from) caps.push(e >= now ? `No readings since ${axisHour(a, fmt)}.` : `No readings ${axisHour(a, fmt)}–${axisHour(e, fmt)}.`);
  }

  const xn = X(now), calibrating = b.state === 'calibrating' || !n;
  marks.push(vline('now', xn, T, B));
  // While calibrating, the lanes, ticks and rug are the whole story: say so below, hide nothing.
  if (calibrating) {
    caps.push(b.calib.armed
      ? 'Waiting for one more whole-number tick while you use Claude Code here (1 of 2 seen).'
      : TWO_TICKS);
  } else {
    const v = b.value, yv = Y(clamp(v, z.yMin, z.yMax));
    if (nextT && nt) {
      const xe = X(nextT), ye = Y(nt.edge);
      marks.push(h('path.proj', { d: `M${f1(xn)} ${f1(yv)}L${f1(xe)} ${f1(ye)}` }));
      over.push(h('path.acd', { d: `M${f1(xe)} ${f1(ye - 3.5)}l3.5 3.5-3.5 3.5-3.5-3.5z` }),
        label(xe + 6, ye - 8, `${edgePct(nt.edge)} ~${axisHour(roundClock(nextT, 5), fmt)}`, 'lblf', 'end'));
    }
    if (b.loupe.mode === 'flat' && b.lo !== undefined && b.hi !== undefined) {
      const y0 = Y(clamp(b.hi, z.yMin, z.yMax));
      over.push(rect('band1', xn - 2, y0, 4, max(2, Y(clamp(b.lo, z.yMin, z.yMax)) - y0)));
    } else over.push(h('circle.dotm', { cx: f1(xn), cy: f1(yv), r: 4 }));
    if (R - xn > 12) over.push(h('line.leader', { x1: f1(xn + 6), x2: R + 4, y1: round(yv) + 0.5, y2: round(yv) + 0.5 }));
    const ly = clamp(yv + 4, T + 4, B - 18);
    over.push(label(R + 8, ly, b.text.value, 'endv'), label(R + 8, ly + 16, dots(b.text.pm, b.text.state), 'lbl12'));
  }

  const loose = n > 0 && hs.flat.every(Boolean);
  if (n) legend.push(...(loose ? [['band2', 'Loose bounds, as recorded']] as [Key, string][]
    : [['line', 'Estimate as recorded'], ['band1', '±1σ, about 68%'], ['band2', '±2σ, about 95%']] as [Key, string][]));
  legend.push(['lane', 'Official whole number'], ['tick', 'Tick, between two readings'], ['rug', 'Readings']);
  caps.unshift(b.loupe.mode === 'flat'
    ? 'Loose: usage outside this computer moved the official number; the estimate is only bounded to the band until the next tick.'
    : n ? 'Each band is one official whole percent. The estimate stays inside the band the endpoint reported and tightens at each tick.'
      : 'Each band is one official whole percent; the estimate appears once calibrated.');
  return figure(c, plot, { ...base, tip: tooltip(c, b, z, X, Y, min(now, t1), ticks), table: () => zoomTable(c, b, z) });
}

function timeAxis(c: Ctx, t0: number, t1: number, X: (t: number) => number, B: number): Child[] {
  const m = (t1 - t0) / MIN, step = m <= 40 ? 5 : m <= 70 ? 10 : m <= 130 ? 15 : m <= 200 ? 30 : 60;
  return hourLabels(c, localBoundaries(t0, t1, step, c.vm.fmt.timeZone), X, B + 26, X(t0) - 30, X(t1) + 30);
}

function tooltip(c: Ctx, b: BucketVM, z: ZoomSeries, X: (t: number) => number, Y: (v: number) => number, end: number,
  ticks: ZoomSeries['ticks']): Tip | undefined {
  if (c.cur?.id !== 'zoom') return;
  const fmt = c.vm.fmt, r = readout(c, b, z.hist, z.lanes, clamp(c.cur.t, z.from, end));
  const tol = (8 * (end - z.from)) / max(1, X(end) - X(z.from)), near = (a: number, e = a) => r.t >= a - tol && r.t <= e + tol;
  for (const k of ticks) if (near(k.from, k.to)) r.rows.push([null, '', tickText(k, c)]);
  for (const f of z.failed) if (near(f)) r.rows.push([null, '', `Poll failed at ${hms(f, fmt)}`]);
  return tip(X(r.t), r.y === undefined ? undefined : Y(clamp(r.y, z.yMin, z.yMax)), hms(r.t, fmt), r.rows);
}

function zoomTable(c: Ctx, b: BucketVM, z: ZoomSeries): VNode {
  const fmt = c.vm.fmt, hs = z.hist, step = max(1, ceil(hs.t.length / 36)), rows: [number, string[]][] = [];
  for (let i = 0; i < hs.t.length; i += step) {
    const x = cells(c, b, hs, i, z.lanes, hs.t[i]);
    rows.push([hs.t[i], [axisHour(hs.t[i], fmt), x.v, x.pm, x.off, '']]);
  }
  for (const k of z.ticks) rows.push([k.to, [hms(k.to, fmt), '', '', '', tickText(k, c)]]);
  for (const f of z.failed) rows.push([f, [hms(f, fmt), '', '', '', 'Poll failed']]);
  rows.sort((x, y) => x[0] - y[0]);
  return table(`${BETWEEN}, ${b.long}`, ['Time', 'Estimate', '±1σ', 'Official', 'Event'], rows.map(r => r[1]));
}
