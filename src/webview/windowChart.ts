// "This window": the whole window on a fixed 0–100 scale. Official readings as lanes, the local
// reconstruction (anchored at now, so its ribbon widens going back), even use, the limit, now, and
// the projection fan to reset. Dashes mean projection and nothing else.

import { BucketVM, DetailVM, Lane, ViewModel } from '../ui/types';
import { axisDay, axisHour, clock } from '../ui/time';
import { chartHost, legend, sectionHead, table, Tip, tipRow } from './chart';
import { Ctx, tableOpen } from './ctx';
import { Child, h, VNode } from './dom';
import { clamp, digitsFor, localBoundaries, pm, roundEta, windowRange } from './fmt';
import { iconAt } from './icons';
import { atOrBefore, Box, f1, fitLabels, laneAt, linePath, bandPath, nearest, overlaps, scale, textW } from './scale';

const HOUR = 3_600_000, DAY = 86_400_000;
export const crisp = (v: number) => Math.round(v) + 0.5;

export const officialOf = (l: Lane, vm: ViewModel) => (vm.rounding === 'round' ? l.lo + 0.5 : l.lo);

/** SVG text with a surface halo so it stays legible over marks. */
export function label(x: number, y: number, s: string, cls = 'tk-lbl', anchor = 'start'): VNode {
  return h('text', { x: f1(x), y: f1(y), class: `${cls} tk-halo`, 'text-anchor': anchor }, s);
}

export function windowFigure(c: Ctx, b: BucketVM, d?: DetailVM): VNode {
  const vm = c.vm, fmt = vm.fmt, tz = fmt.timeZone, ws = d?.window;
  const now = ws?.now ?? vm.now, t0 = ws?.from ?? b.windowStart, t1 = ws?.to ?? b.resetsAt;
  const W = c.w('win', 560), H = c.surface === 'view' ? 150 : W < 560 ? 200 : 220;
  const L = 34, R = W - 56, T = 14, B = H - 24;
  const Y = scale(0, 100, B, T), X = scale(t0 ?? 0, t1 ?? 1, L, R);
  const weekly = !!t0 && !!t1 && t1 - t0 > DAY;
  const lanes = ws?.lanes ?? [], est = ws?.calibrated ? ws.est : { t: [], v: [], s: [] };
  const marks: Child[] = [], boxes: Box[] = [];
  const when = (t: number) => (weekly ? `${axisDay(t, fmt)} ${axisHour(t, fmt)}` : axisHour(t, fmt));

  for (const v of [25, 50, 75]) marks.push(h('line', { class: 'tk-grid', x1: L, x2: R, y1: crisp(Y(v)), y2: crisp(Y(v)) }));
  if (t0 && t1) marks.push(...xAxis(t0, t1, X, B, T, weekly, fmt));
  for (const v of [0, 25, 50, 75, 100]) marks.push(label(L - 6, Y(v) + 4, `${v}%`, 'tk-axl', 'end'));
  marks.push(h('line', { class: 'tk-axis', x1: L, x2: R, y1: crisp(B), y2: crisp(B) }));

  if (!t0 || !t1) {
    marks.push(label((L + R) / 2, (T + B) / 2 + 4, b.state === 'idle' ? 'No usage in this window yet — the next message starts it.' : 'Waiting for the first reading.', 'tk-msg', 'middle'));
    return frame(c, b, d, W, H, marks, undefined, { L, R, t0: 0, t1: 1, now });
  }

  // Official lanes: each run of one whole number, with its floor as a step line.
  let dl = '', de = '';
  for (const l of lanes) {
    const x0 = X(l.from), x1 = Math.max(X(l.to), x0 + 1);
    dl += `M${f1(x0)} ${f1(Y(l.hi))}H${f1(x1)}V${f1(Y(l.lo))}H${f1(x0)}Z`;
    de += `M${f1(x0)} ${f1(Y(l.lo))}H${f1(x1)}`;
  }
  marks.push(h('path', { class: 'tk-lane', d: dl }), h('path', { class: 'tk-lane-edge', d: de }));

  // Ribbons are clipped to the official run at each vertex, and skipped where the reconstruction
  // left it: the official number is the truth the curve answers to.
  const xs = est.t.map(X), band: number[][] = [[], [], [], []];
  est.t.forEach((t, i) => {
    const l = laneAt(lanes, t), a = l ? l.lo : 0, z = l ? l.hi : 100, v = est.v[i], s = est.s[i];
    [[v - 2 * s, v + 2 * s], [v - s, v + s]].forEach(([p, q], k) => {
      const lo = Math.max(p, a), hi = Math.min(q, z);
      band[2 * k].push(lo < hi ? Y(lo) : NaN);
      band[2 * k + 1].push(lo < hi ? Y(hi) : NaN);
    });
  });
  marks.push(h('path', { class: 'tk-band2', d: bandPath(xs, band[0], band[1]) }), h('path', { class: 'tk-band1', d: bandPath(xs, band[2], band[3]) }));
  marks.push(h('line', { class: 'tk-even', x1: L, y1: B, x2: R, y2: T }));
  marks.push(h('path', { class: 'tk-line', d: linePath(xs, est.v.map(Y)) }));
  marks.push(h('line', { class: 'tk-axis', x1: L, x2: R, y1: crisp(T), y2: crisp(T) }), label(R + 6, T + 4, 'limit'));

  const xn = X(now), v0 = b.value, dot = ws?.calibrated || b.state === 'exact' || b.state === 'limit';
  if (now >= t0 && now <= t1) marks.push(h('line', { class: 'tk-now', x1: crisp(xn), x2: crisp(xn), y1: T, y2: B }), label(xn, T - 4, 'now', 'tk-lbl', 'middle'));

  // Projection fan from now to reset, stopping where a line meets the limit.
  const p = b.pace, rates = p ? (p.low === p.high ? [p.high] : [p.low, p.high]) : [];
  const ends = rates.map(r => {
    const hit = r > 0 ? now + ((100 - v0) / r) * HOUR : Infinity;
    return hit < t1 ? [hit, 100] : [t1, Math.min(100, v0 + (r * (t1 - now)) / HOUR)];
  });
  const projY = (t: number) => rates.map(r => Y(Math.min(100, v0 + (r * (t - now)) / HOUR)));
  ends.forEach(([te, ve]) => marks.push(h('path', { class: 'tk-proj', d: `M${f1(xn)} ${f1(Y(v0))}L${f1(X(te))} ${f1(Y(ve))}` })));
  const atReset = ends.filter(e => e[0] >= t1);
  if (p && atReset.length) {
    const lo = Math.round(p.projLow), hi = Math.round(p.projHigh);
    const s = atReset.length === 2 && lo !== hi ? `~${lo}–${hi}%` : `~${atReset.length === 2 ? hi : lo}%`;
    const y = clamp(atReset.reduce((a, e) => a + Y(e[1]), 0) / atReset.length + 4, T + 14, B - 2);
    marks.push(label(R + 4, y, s, 'tk-endl'));
    boxes.push({ x0: R + 4, y0: y - 11, x1: W, y1: y + 3 });
  }

  // Curves the labels must stay off: the estimate before now, the fan after.
  const curveAt = (t: number) => (t <= now ? (est.t.length ? [Y(est.v[nearest(est.t, t)])] : []) : projY(t));
  const clear = (bx: Box) => bx.x0 >= L - 2 && bx.x1 <= W && bx.y0 >= T - 2 && bx.y1 <= B
    && !boxes.some(o => overlaps(o, bx))
    && [bx.x0, (bx.x0 + bx.x1) / 2, bx.x1].every(x => curveAt(t0 + ((x - L) / (R - L)) * (t1 - t0)).every(y => y < bx.y0 - 3 || y > bx.y1 + 3));
  const place = (cands: [number, number, string][], w: number): [number, number, string] | undefined => {
    for (const cd of cands) {
      const x0 = cd[2] === 'end' ? cd[0] - w : cd[0], bx = { x0, y0: cd[1] - 11, x1: x0 + w, y1: cd[1] + 3 };
      if (clear(bx)) { boxes.push(bx); return cd; }
    }
  };

  if (p?.runOut && p.runOut.from <= t1) {
    const tr = p.runOut.mid <= t1 ? p.runOut.mid : p.runOut.from, x = X(tr), y = Y(100);
    marks.push(h('path', { class: 'tk-warnd', d: `M${f1(x)} ${f1(y - 4)}l4 4-4 4-4-4z` }));
    const s = `100% ~${clock(roundEta(tr, b.windowMs), now, fmt)}`, w = textW(s, 12) + 16;
    const at = place([[x + 8, y + 18, 'start'], [x - 8, y + 18, 'end'], [x - 8, y + 34, 'end']], w);
    if (at) {
      const x0 = at[2] === 'end' ? at[0] - w : at[0];
      marks.push(iconAt('warning', x0, at[1] - 10, 12, 'tk-warn-ic'), label(x0 + 16, at[1], s, 'tk-val'));
    }
  }

  if (dot && now >= t0) {
    const s = b.text.value, ps = b.text.pm ? ` ${b.text.pm}` : '', w = textW(s, 12) + textW(ps, 11) + 4, y = Y(v0);
    const at = place([[xn - 8, y - 8, 'end'], [xn - 8, y + 18, 'end'], [xn + 8, y + 18, 'start'], [xn + 8, y - 8, 'start']], w);
    marks.push(h('circle', { class: 'tk-dotm', cx: f1(xn), cy: f1(y), r: 4 }));
    if (at) marks.push(h('text', { x: f1(at[0]), y: f1(at[1]), class: 'tk-val tk-halo', 'text-anchor': at[2] }, s, h('tspan', { class: 'tk-pmt' }, ps)));
  }

  const ew = textW('even use', 11);
  const evenAt = (f: number, below: boolean): [number, number, string] => {
    const x = L + f * (R - L), y = B - f * (B - T);
    return below ? [x + 6, y + 14, 'start'] : [x - 6, y - 6, 'end'];
  };
  const ev = place([0.86, 0.72, 0.3, 0.18].flatMap(f => [evenAt(f, true), evenAt(f, false)]), ew);
  if (ev) marks.push(label(ev[0], ev[1], 'even use', 'tk-lbl', ev[2]));

  return frame(c, b, d, W, H, marks, tooltip(c, b, d, X, Y, now, t0, t1, weekly, when, rates), { L, R, t0, t1, now });
}

function xAxis(t0: number, t1: number, X: (t: number) => number, B: number, T: number, weekly: boolean, fmt: ViewModel['fmt']): Child[] {
  const out: Child[] = [];
  const ticks = localBoundaries(t0, t1 - 1, weekly ? 1440 : 60, fmt.timeZone);
  for (const t of ticks) out.push(h('line', { class: 'tk-vgrid', x1: crisp(X(t)), x2: crisp(X(t)), y1: T, y2: B }));
  if (weekly) {
    const edges = [t0, ...ticks, t1];
    for (let k = 0; k + 1 < edges.length; k++) {
      const s = axisDay((edges[k] + edges[k + 1]) / 2, fmt);
      if (X(edges[k + 1]) - X(edges[k]) >= textW(s, 11) + 4) out.push(label((X(edges[k]) + X(edges[k + 1])) / 2, B + 16, s, 'tk-axl', 'middle'));
    }
  } else {
    const ls = ticks.map(t => axisHour(t, fmt)), xs = ticks.map(X);
    const keep = fitLabels(xs, ls.map(s => textW(s, 11)), 10, 0, X(t1) + 40);
    ticks.forEach((_, i) => keep[i] && out.push(label(xs[i], B + 16, ls[i], 'tk-axl', 'middle')));
  }
  return out;
}

function tooltip(c: Ctx, b: BucketVM, d: DetailVM | undefined, X: (t: number) => number, Y: (v: number) => number,
  now: number, t0: number, t1: number, weekly: boolean, when: (t: number) => string, rates: number[]): Tip | undefined {
  if (c.cur?.id !== 'win') return;
  const ws = d?.window, est = ws?.calibrated ? ws.est : { t: [], v: [], s: [] }, p = b.pace;
  let t = clamp(c.cur.t, t0, t1), yv: number | undefined;
  const rows: Child[] = [], text: string[] = [];
  if (t > now && p && rates.length) {
    const q = weekly ? HOUR : 300_000;
    t = Math.min(t1, Math.ceil(t / q) * q);
    const at = (r: number) => Math.min(100, b.value + (r * (t - now)) / HOUR);
    const pairs: [number, string][] = p.r15 !== undefined && p.rAvg !== undefined && rates.length > 1
      ? [[p.r15, 'at 15-min pace'], [p.rAvg, 'at window average']] : [[rates[0], weekly ? 'at your average pace' : 'at this pace']];
    for (const [r, what] of pairs) { rows.push(tipRow('dash', `${Math.round(at(r))}%`, what)); text.push(`${Math.round(at(r))}% ${what}`); }
    yv = at(rates[rates.length - 1]);
  } else {
    if (est.t.length && t <= now) {
      const i = nearest(est.t, t), s = est.s[i], dg = digitsFor(s, Math.max(b.digits, 1));
      t = est.t[i];
      yv = est.v[i];
      rows.push(tipRow('line', `${yv.toFixed(dg)}%`, `${pm(s, dg)} estimate`));
      text.push(`estimate ${yv.toFixed(dg)}% ${pm(s, dg)}`);
    }
    const l = ws && laneAt(ws.lanes, t);
    if (l) {
      rows.push(tipRow('lane', `${officialOf(l, c.vm)}%`, 'official'));
      text.push(`official ${officialOf(l, c.vm)}%`);
      if (yv === undefined) yv = l.lo + 0.5;
    }
  }
  const x = X(t), y = Y(yv ?? 50);
  return { x, y, mark: yv !== undefined, text: `${when(t)}: ${text.join(', ') || 'no reading'}`, rows: [h('div', { class: 'tk-th' }, when(t)), rows.length ? rows : h('div', { class: 'tk-tr' }, 'No reading at this time')] };
}

function frame(c: Ctx, b: BucketVM, d: DetailVM | undefined, W: number, H: number, marks: Child[], tip: Tip | undefined,
  g: { L: number; R: number; t0: number; t1: number; now: number }): VNode {
  const ws = d?.window, fmt = c.vm.fmt, weekly = g.t1 - g.t0 > DAY;
  if (tip) {
    marks.push(h('line', { class: 'tk-cross', x1: crisp(tip.x), x2: crisp(tip.x), y1: 14, y2: H - 24 }));
    if (tip.mark) marks.push(h('circle', { class: 'tk-dotm', cx: f1(tip.x), cy: f1(tip.y), r: 3.5 }));
  }
  const range = b.windowStart && b.resetsAt ? windowRange(g.t0, g.t1, fmt) : '';
  const host = chartHost(c, {
    id: 'win', label: `${b.long} this window${range ? `, ${range}` : ''}. ${b.text.spokenFull}`, W, H, left: g.L, right: g.R,
    t0: g.t0, t1: g.t1, step: weekly ? HOUR : 300_000, home: g.t0, end: g.t1, start: g.now,
  }, marks, tip);
  const items: Parameters<typeof legend>[0] = [];
  if (ws?.calibrated) items.push(['line', 'Estimate, reconstructed from this computer’s logs']);
  items.push(['lane', 'Official whole number'], ['even', 'Even use']);
  if (b.pace) items.push(['dash', b.pace.low === b.pace.high ? 'Projection at your average pace' : 'Projection: 15-minute pace (this computer) to window average (every device)']);
  return h('figure', { class: 'tk-fig' },
    sectionHead(c, 'This window', [b.long, range].filter(Boolean).join(' · '), 'win'),
    host,
    h('figcaption', null,
      legend(items),
      ws && !ws.calibrated && h('p', { class: 'tk-cap' }, 'Official whole numbers only for now: the estimate line appears once calibration completes.'),
      ws?.calibrated && h('p', { class: 'tk-cap' }, 'Ribbons: ±1σ and ±2σ, widening back in time as the reconstruction counts further from now.')),
    tableOpen(c, 'win') && winTable(c, b, d, weekly));
}

function winTable(c: Ctx, b: BucketVM, d: DetailVM | undefined, weekly: boolean): VNode {
  const ws = d?.window, fmt = c.vm.fmt;
  if (!ws) return table(`${b.long} this window`, ['Time', 'Estimate', '±1σ', 'Official'], []);
  const est = ws.calibrated ? ws.est : { t: [], v: [], s: [] };
  const times = [...localBoundaries(ws.from, ws.now - 1, weekly ? 360 : 15, fmt.timeZone), ws.now];
  const rows = times.map(t => {
    const i = atOrBefore(est.t, t), l = laneAt(ws.lanes, t), dg = i >= 0 ? digitsFor(est.s[i], Math.max(b.digits, 1)) : 0;
    return [
      t === ws.now ? `${weekly ? axisDay(t, fmt) + ' ' : ''}${axisHour(t, fmt)} (now)` : weekly ? `${axisDay(t, fmt)} ${axisHour(t, fmt)}` : axisHour(t, fmt),
      i >= 0 ? `${est.v[i].toFixed(dg)}%` : '—',
      i >= 0 ? pm(est.s[i], dg).slice(1) : '—',
      l ? `${officialOf(l, c.vm)}%` : '—',
    ];
  });
  return table(`${b.long} this window, every ${weekly ? '6 hours' : '15 minutes'}`, ['Time', 'Estimate', '±1σ', 'Official'], rows);
}
