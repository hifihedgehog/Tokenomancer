// "This window": the whole window on a fixed 0–100 scale. Official readings as lanes, the local
// reconstruction (anchored at now, so its ribbon widens going back), even use, the limit, now, and
// the projection fan to reset. Dashes mean projection and nothing else.

import { runOutClock } from '../ui/present';
import { axisDay, axisHour, clock } from '../ui/time';
import { BucketVM, DetailVM } from '../ui/types';
import { cells, figure, hline, hourLabels, label, lanePaths, Plot, readout, ribbons, Row, table, tip, Tip, vline } from './chart';
import { Ctx } from './ctx';
import { Child, h, VNode } from './dom';
import { ceil, clamp, dots, localBoundaries, max, min, round, WAITING, when, windowRange } from './fmt';
import { icon } from './icons';
import { atOrBefore, bandPath, Box, f1, fitLabels, linePath, nearest, overlaps, scale, textW } from './scale';

const HOUR = 3_600_000, DAY = 86_400_000, NONE = { t: [], v: [], s: [] };

export function windowFigure(c: Ctx, b: BucketVM, d?: DetailVM): VNode {
  const vm = c.vm, fmt = vm.fmt, ws = d?.window;
  const now = ws?.now ?? vm.now, t0 = ws?.from ?? b.windowStart ?? 0, t1 = ws?.to ?? b.resetsAt ?? 0;
  const W = c.w('win', 560), H = c.surface === 'view' ? 150 : W < 560 ? 200 : 220;
  const L = 34, R = W - 56, T = 14, B = H - 24, Y = scale(0, 100, B, T), X = scale(t0, t1, L, R);
  const days = t1 - t0 > DAY, ok = t0 > 0 && t1 > t0;
  const est = ws?.calibrated ? ws.est : NONE, lanes = ws?.lanes ?? [];
  const marks: Child[] = [25, 50, 75].map(v => hline('grid', L, R, Y(v))), over: Child[] = [], boxes: Box[] = [];
  for (const v of [0, 25, 50, 75, 100]) over.push(label(L - 6, Y(v) + 4, `${v}%`, 'axl', 'end'));
  const range = ok ? windowRange(t0, t1, fmt) : '';
  const plot: Plot = {
    id: 'win', label: `${b.long} this window${range ? `, ${range}` : ''}. ${b.text.spokenFull}`, W, H, L, R, T, B,
    t0, t1: max(t1, t0 + 1), step: days ? HOUR : 300_000, end: clamp(now, t0, t1),
  };
  const parts = { title: 'This window', sub: dots(b.long, range), marks, over, legend: [] as [any, string][], caps: [] as string[] };
  marks.push(hline('axis', L, R, B));
  if (!ok) {
    return figure(c, plot, { ...parts, note: b.state === 'idle' ? 'No usage in this window yet — the next message starts it.' : WAITING });
  }

  marks.push(...xAxis(c, t0, t1, X, T, B, days, over));
  marks.push(...lanePaths(lanes, X, Y, 3 * vm.pollMs));

  // At this scale the ribbon is left unclipped: clipping each vertex to its official run made it
  // flicker between runs. The zoom chart below does the exact clipping.
  const xs = est.t.map(X);
  marks.push(...ribbons(xs, est.v, est.s, () => 0, () => 100, Y, 3),
    h('line.even', { x1: L, y1: B, x2: R, y2: T }), h('path.line', { d: linePath(xs, est.v.map(Y)) }), hline('axis', L, R, T));
  over.push(label(R + 6, T + 4, 'limit'));

  const xn = X(now), v0 = b.value, live = now >= t0 && now <= t1;
  if (live) {
    marks.push(vline('now', xn, T, B));
    over.push(label(xn, T - 4, 'now', 'lbl', 'middle'));
  }

  // Projection fan from now to reset, stopping where a line meets the limit.
  const p = b.pace, rates = p ? (p.low === p.high ? [p.high] : [p.low, p.high]) : [];
  const proj = (r: number, t: number) => min(100, v0 + (r * (t - now)) / HOUR);
  const ends = rates.map(r => {
    const hit = r > 0 ? now + ((100 - v0) / r) * HOUR : Infinity;
    return hit < t1 ? [hit, 100] : [t1, proj(r, t1)];
  });
  ends.forEach(([te, ve]) => marks.push(h('path.proj', { d: `M${f1(xn)} ${f1(Y(v0))}L${f1(X(te))} ${f1(Y(ve))}` })));
  const atReset = ends.filter(e => e[0] >= t1);
  if (p && atReset.length) {
    const lo = round(p.projLow), hi = round(p.projHigh);
    const s = atReset.length === 2 && lo !== hi ? `~${lo}–${hi}%` : `~${atReset.length === 2 ? hi : lo}%`;
    const y = clamp(atReset.reduce((a, e) => a + Y(e[1]), 0) / atReset.length + 4, T + 14, B - 2);
    over.push(label(R + 4, y, s, 'endl'));
    boxes.push({ x0: R + 4, y0: y - 11, x1: W, y1: y + 3 });
  }

  // Labels keep off the curves: the estimate before now, the fan after.
  const curveAt = (t: number) => (t <= now
    ? (est.t.length ? [Y(est.v[nearest(est.t, t)])] : [])
    : rates.map(r => Y(proj(r, t))));
  const place = (cands: [number, number, string][], w: number) => cands.find(([x, y, anchor]) => {
    const x0 = anchor === 'end' ? x - w : x, bx = { x0, y0: y - 11, x1: x0 + w, y1: y + 3 };
    const clear = bx.x0 >= L - 2 && bx.x1 <= W && bx.y0 >= T - 2 && bx.y1 <= B && !boxes.some(o => overlaps(o, bx))
      && Array.from({ length: ceil(w / 6) + 1 }, (_, k) => min(bx.x1, bx.x0 + 6 * k))
        .every(px => curveAt(t0 + ((px - L) / (R - L)) * (t1 - t0)).every(cy => cy < bx.y0 - 3 || cy > bx.y1 + 3));
    if (clear) boxes.push(bx);
    return clear;
  });

  if (p?.runOut && p.runOut.from <= t1) {
    const tr = p.runOut.mid <= t1 ? p.runOut.mid : p.runOut.from, x = X(tr), y = Y(100);
    over.push(h('path.warnd', { d: `M${f1(x)} ${f1(y - 4)}l4 4-4 4-4-4z` }));
    const s = `100% ~${clock(runOutClock(b.key, tr), now, fmt)}`, w = textW(s, 12) + 16;
    const at = place([[x + 8, y + 18, 'start'], [x - 8, y + 18, 'end'], [x + 8, y + 34, 'start'], [x - 8, y + 34, 'end']], w);
    if (at) {
      const x0 = at[2] === 'end' ? at[0] - w : at[0];
      over.push(icon('warning', 'wi', [x0, at[1] - 10, 12]), label(x0 + 16, at[1], s, 'val'));
    }
  }

  if (live && (ws?.calibrated || b.state === 'exact' || b.state === 'limit')) {
    const s = b.text.value, ps = b.text.pm ? ` ${b.text.pm}` : '', w = textW(s, 12) + textW(ps, 11) + 4, y = Y(v0);
    const at = place([[xn - 8, y - 8, 'end'], [xn - 8, y + 18, 'end'], [xn + 8, y + 18, 'start'], [xn + 8, y - 8, 'start']], w);
    over.push(h('circle.dotm', { cx: f1(xn), cy: f1(y), r: 4 }));
    if (at) over.push(h('text.val.halo', { x: f1(at[0]), y: f1(at[1]), 'text-anchor': at[2] }, s, h('tspan.pmt', ps)));
  }

  const ev = place([0.86, 0.3].flatMap(f => {
    const x = L + f * (R - L), y = B - f * (B - T);
    return [[x + 6, y + 14, 'start'], [x - 6, y - 6, 'end']] as [number, number, string][];
  }), textW('even use', 11));
  if (ev) over.push(label(ev[0], ev[1], 'even use', 'lbl', ev[2]));

  if (ws?.calibrated) parts.legend.push(['line', 'Estimate, reconstructed from this computer’s logs']);
  parts.legend.push(['lane', 'Official whole number'], ['even', 'Even use']);
  if (p) parts.legend.push(['dash', p.low === p.high ? 'Projection at your average pace' : 'Projection: 15-minute pace (this computer) to window average (every device)']);
  parts.caps.push(!ws ? '' : ws.calibrated
    ? 'Ribbons: ±1σ and ±2σ, widening back from now as the reconstruction counts further.'
    : 'Official whole numbers only for now: the estimate appears once calibrated.');
  return figure(c, plot, { ...parts, tip: tooltip(c, b, d, X, Y, now, days, rates), table: () => winTable(c, b, d, days) });
}

function xAxis(c: Ctx, t0: number, t1: number, X: (t: number) => number, T: number, B: number, days: boolean, over: Child[]): Child[] {
  const fmt = c.vm.fmt, ticks = localBoundaries(t0, t1 - 1, days ? 1440 : 60, fmt.timeZone);
  if (days) {
    const edges = [t0, ...ticks, t1];
    for (let k = 0; k + 1 < edges.length; k++) {
      const s = axisDay((edges[k] + edges[k + 1]) / 2, fmt), x0 = X(edges[k]), x1 = X(edges[k + 1]);
      if (x1 - x0 >= textW(s, 11) + 4) over.push(label((x0 + x1) / 2, B + 16, s, 'axl', 'middle'));
    }
  } else over.push(...hourLabels(c, ticks, X, B + 16, 0, X(t1) + 40));
  return ticks.map(t => vline('grid', X(t), T, B));
}

function tooltip(c: Ctx, b: BucketVM, d: DetailVM | undefined, X: (t: number) => number, Y: (v: number) => number,
  now: number, days: boolean, rates: number[]): Tip | undefined {
  if (c.cur?.id !== 'win' || !d) return;
  const ws = d.window, p = b.pace;
  let t = clamp(c.cur.t, ws.from, ws.to), y: number | undefined, rows: Row[];
  if (t > now && p && rates.length) {
    const q = days ? HOUR : 300_000, at = (r: number) => min(100, b.value + (r * (t - now)) / HOUR);
    t = min(ws.to, ceil(t / q) * q);
    const pairs: [number, string][] = p.r15 !== undefined && p.rAvg !== undefined && rates.length > 1
      ? [[p.r15, 'at 15-min pace'], [p.rAvg, 'at window average']] : [[rates[0], days ? 'at your average pace' : 'at this pace']];
    rows = pairs.map(([r, what]) => ['dash', `${round(at(r))}%`, what]);
    y = at(rates[rates.length - 1]);
  } else ({ t, y, rows } = readout(c, b, ws.calibrated ? ws.est : NONE, ws.lanes, t));
  return tip(X(t), y === undefined ? undefined : Y(y), when(t, c.vm.fmt, days), rows);
}

function winTable(c: Ctx, b: BucketVM, d: DetailVM | undefined, days: boolean): VNode {
  const head = ['Time', 'Estimate', '±1σ', 'Official'], cap = `${b.long} this window, every ${days ? '6 hours' : '15 minutes'}`;
  if (!d) return table(cap, head, []);
  const ws = d.window, fmt = c.vm.fmt, est = ws.calibrated ? ws.est : NONE;
  return table(cap, head, [...localBoundaries(ws.from, ws.now - 1, days ? 360 : 15, fmt.timeZone), ws.now].map(t => {
    const x = cells(c, b, est, atOrBefore(est.t, t), ws.lanes, t);
    return [when(t, fmt, days) + (t === ws.now ? ' (now)' : ''), x.v, x.pm, x.off];
  }));
}
