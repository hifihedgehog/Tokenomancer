// Pure number and local-time helpers for the webview. No DOM, so node:test covers them.
// Copy that every surface shares comes ready-made in the view model (or from present.ts);
// these only format the numbers the charts and facts add.

import { Family, TimeFmt } from '../ui/types';
import { axisDay, axisHour } from '../ui/time';

export const { abs, ceil, floor, max, min, round } = Math;
export const clamp = (v: number, lo: number, hi: number) => min(hi, max(lo, v));

/** Three significant figures with k/M: 412, 50.9k, 273k, 1.18M, 12.8M. */
export function compact(n: number): string {
  for (const [u, s] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']] as const) {
    if (abs(n) < u * 0.9995) continue;
    const x = n / u;
    return (x >= 99.95 ? x.toFixed(0) : x >= 9.995 ? x.toFixed(1) : x.toFixed(2)) + s;
  }
  return String(round(n));
}

export const usd = (n: number) => '$' + (n < 1000 ? n.toFixed(2) : round(n).toLocaleString('en-US'));
export const rate = (r: number) => (r >= 10 ? r.toFixed(0) : r >= 1 ? r.toFixed(1) : r.toFixed(2)) + ' %/h';
export const share = (f: number) => (f > 0 && f < 0.005 ? '<1' : round(f * 100)) + '%';
export const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
/** An official edge: "61%", or "60.5%" in round mode. */
export const edgePct = (e: number) => (Number.isInteger(e) ? String(e) : e.toFixed(1)) + '%';

/** "a · b · c", skipping empty parts. */
export const dots = (...parts: unknown[]) => parts.filter(Boolean).join(' · ');
export const family = (f: Family) => f.charAt(0).toUpperCase() + f.slice(1);
// Copy that more than one renderer prints.
export const WAITING = 'Waiting for the first reading.';
export const BETWEEN = 'Between the whole numbers';
export const TWO_TICKS = 'Waiting for two whole-number ticks while you use Claude Code here.';

export const PART = { in: 'Fresh input & cache writes', out: 'Output', read: 'Cache reads' };

/** "in ~5 min", "in 23–27 min", "in 1.2–1.6 h" from two offsets in ms. */
export function etaRange(fromMs: number, toMs: number): string {
  const a = max(0, fromMs) / 60_000, b = max(0, toMs) / 60_000;
  if (b < 90) {
    const ra = max(1, round(a)), rb = max(1, round(b));
    return ra === rb ? `in ~${max(1, round((a + b) / 2))} min` : `in ${ra}–${rb} min`;
  }
  const ha = (a / 60).toFixed(1), hb = (b / 60).toFixed(1);
  return ha === hb ? `in ~${ha} h` : `in ${ha}–${hb} h`;
}

// ───────────── local time (the VM's time zone, which may differ from the webview's) ─────────────

const cache = new Map<string, Intl.DateTimeFormat>();
function dtf(fmt: TimeFmt, o: Intl.DateTimeFormatOptions, locale = fmt.locale): Intl.DateTimeFormat {
  const k = JSON.stringify([locale, fmt.timeZone, fmt.hour12, o]);
  let f = cache.get(k);
  if (!f) {
    try { f = new Intl.DateTimeFormat(locale, { ...o, timeZone: fmt.timeZone, hour12: o.hour ? fmt.hour12 : undefined }); } catch { f = new Intl.DateTimeFormat(undefined, o); }
    cache.set(k, f);
  }
  return f;
}

/** Local time minus UTC at instant t, in ms (whole minutes). */
export function zoneOffset(t: number, tz?: string): number {
  const p: Record<string, number> = {};
  const f = dtf({ timeZone: tz }, { hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }, 'en-US');
  for (const x of f.formatToParts(t)) p[x.type] = Number(x.value);
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return round((local - (t - (((t % 1000) + 1000) % 1000))) / 60_000) * 60_000;
}

/** Instants in (from, to] where the local clock is a whole multiple of `stepMin` minutes since
 *  midnight: 60 gives each local hour, 1440 each local midnight (DST-aware). */
export function localBoundaries(from: number, to: number, stepMin: number, tz?: string): number[] {
  const out: number[] = [], step = stepMin * 60_000;
  for (let t = from, guard = 0; guard < 500 && t < to; guard++) {
    const off = zoneOffset(t, tz), b = floor((t + off) / step) * step + step;
    let tb = b - off;
    const off2 = zoneOffset(tb, tz);
    if (off2 !== off) tb = b - off2;
    if (tb <= t) { t += step; continue; }
    if (tb > to) break;
    out.push(tb);
    t = tb;
  }
  return out;
}

/** "11:40", or "Thu 11:40" when the span crosses days. */
export const when = (t: number, fmt: TimeFmt, days: boolean) => (days ? `${axisDay(t, fmt)} ${axisHour(t, fmt)}` : axisHour(t, fmt));

/** "10:06 → 15:06" for windows up to a day, "Mon 19 Oct 9:00 → Mon 26 Oct 9:00" beyond. */
export function windowRange(from: number, to: number, fmt: TimeFmt): string {
  const f = (t: number) => (to - from <= 86_400_000 ? axisHour(t, fmt) : `${axisDay(t, fmt)} ${dtf(fmt, { day: 'numeric', month: 'short' }).format(t)} ${axisHour(t, fmt)}`);
  return `${f(from)} → ${f(to)}`;
}

/** "12:41:05": tick intervals are a poll apart, so they need seconds. */
export const hms = (t: number, fmt: TimeFmt) => dtf(fmt, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(t);
