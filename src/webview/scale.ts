// Pure chart geometry: scales, path strings, lookups and label fitting. No DOM.

import { Lane } from '../ui/types';
import { abs, round } from './fmt';

export type Scale = (v: number) => number;

export function scale(d0: number, d1: number, r0: number, r1: number): Scale {
  const k = (r1 - r0) / (d1 - d0 || 1);
  return v => r0 + (v - d0) * k;
}

/** One decimal, trailing ".0" dropped: path data stays small. */
export const f1 = (n: number) => String(round(n * 10) / 10);

/** A polyline; non-finite y values lift the pen. */
export function linePath(xs: number[], ys: number[]): string {
  let d = '', pen = false;
  for (let i = 0; i < xs.length; i++) {
    if (!isFinite(ys[i])) { pen = false; continue; }
    d += (pen ? 'L' : 'M') + f1(xs[i]) + ' ' + f1(ys[i]);
    pen = true;
  }
  return d;
}

/** A filled ribbon between two pixel series, split wherever a vertex has no band (NaN or lo ≥ hi);
 *  runs shorter than `least` vertices are dropped, so a clipped ribbon leaves no slivers. */
export function bandPath(xs: number[], y0: number[], y1: number[], least = 2): string {
  let d = '', run: number[] = [];
  const pt = (y: number[]) => (i: number) => f1(xs[i]) + ' ' + f1(y[i]);
  for (let i = 0; i <= xs.length; i++) {
    if (i < xs.length && isFinite(y0[i]) && isFinite(y1[i]) && abs(y0[i] - y1[i]) > 1e-6) { run.push(i); continue; }
    if (run.length >= least) d += 'M' + run.map(pt(y1)).join('L') + 'L' + run.reverse().map(pt(y0)).join('L') + 'Z';
    run = [];
  }
  return d;
}

/** Index of the value in sorted `ts` nearest to t (−1 when empty). */
export function nearest(ts: number[], t: number): number {
  if (!ts.length) return -1;
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid; else hi = mid;
  }
  return abs(ts[lo] - t) <= abs(ts[hi] - t) ? lo : hi;
}

/** Index of the last element of sorted `ts` at or before t (−1 if none). */
export function atOrBefore(ts: number[], t: number): number {
  let lo = 0, hi = ts.length - 1, r = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) { r = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return r;
}

/** The official run covering t, if any (lanes are sorted and don't overlap). */
export function laneAt(lanes: Lane[], t: number): Lane | undefined {
  let lo = 0, hi = lanes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, l = lanes[mid];
    if (t < l.from) hi = mid - 1;
    else if (t > l.to) lo = mid + 1;
    else return l;
  }
  return undefined;
}

/** Rough text width in px for a 11–13 px UI sans; good enough to keep labels apart. */
export const textW = (s: string, px: number) => s.length * px * 0.58;

export interface Box { x0: number; y0: number; x1: number; y1: number }
export const overlaps = (a: Box, b: Box, pad = 2) =>
  a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;

/** Keeps centred labels that don't collide, scanning left to right. */
export function fitLabels(xs: number[], widths: number[], gap = 8, lo = -Infinity, hi = Infinity): boolean[] {
  let right = -Infinity;
  return xs.map((x, i) => {
    const l = x - widths[i] / 2, r = x + widths[i] / 2;
    if (l < lo || r > hi || l < right + gap) return false;
    right = r;
    return true;
  });
}

/** Up to n evenly spaced indices of an array of length len, always ending with the last. */
export function sampleIdx(len: number, n: number): number[] {
  if (len <= n) return Array.from({ length: len }, (_, i) => i);
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(round((k * (len - 1)) / (n - 1)));
  return out;
}
