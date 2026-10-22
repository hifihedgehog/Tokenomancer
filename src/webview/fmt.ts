// Pure number and local-time helpers for the webview. No DOM, so node:test covers them.
// Copy that every surface shares comes ready-made in the view model; these only format the
// numbers the charts and facts add.

import { Family, TimeFmt } from '../ui/types';
import { axisDay, axisHour } from '../ui/time';

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Decimals a 1σ supports, capped at `max` (the status bar's rule). */
export function digitsFor(s: number | undefined, max: number): number {
  if (!(s! > 0)) return max;
  return clamp(Math.ceil(-Math.log10(2 * s!) - 1e-9), 0, max);
}

/** "±0.03": rounded up, so it never understates, and never below one unit of the last digit. */
export function pm(s: number, d: number): string {
  const u = Math.pow(10, -d);
  return '±' + (Math.max(1, Math.ceil(s / u - 1e-9)) * u).toFixed(d);
}

/** Three significant figures with k/M: 412, 50.9k, 273k, 1.18M, 12.8M. */
export function compact(n: number): string {
  for (const [u, s] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']] as const) {
    if (Math.abs(n) < u * 0.9995) continue;
    const x = n / u;
    return (x >= 99.95 ? x.toFixed(0) : x >= 9.995 ? x.toFixed(1) : x.toFixed(2)) + s;
  }
  return String(Math.round(n));
}

export const usd = (n: number) => '$' + (n < 1000 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US'));
export const rate = (r: number) => (r >= 10 ? r.toFixed(0) : r >= 1 ? r.toFixed(1) : r.toFixed(2)) + ' %/h';
export const share = (f: number) => (f > 0 && f < 0.005 ? '<1' : Math.round(f * 100)) + '%';
/** An official edge: "61%", or "60.5%" in round mode. */
export const edgePct = (e: number) => (Number.isInteger(e) ? String(e) : e.toFixed(1)) + '%';

export const FAMILY: Record<Family, string> = {
  fable: 'Fable', mythos: 'Mythos', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', other: 'Other',
};
export const PART = { in: 'Fresh input & cache writes', out: 'Output', read: 'Cache reads' };

/** "in ~5 min", "in 23–27 min", "in 1.2–1.6 h" from two offsets in ms. */
export function etaRange(fromMs: number, toMs: number): string {
  const a = Math.max(0, fromMs) / 60_000, b = Math.max(0, toMs) / 60_000;
  if (b < 90) {
    const ra = Math.max(1, Math.round(a)), rb = Math.max(1, Math.round(b));
    return b - a < 1 || ra === rb ? `in ~${Math.max(1, Math.round((a + b) / 2))} min` : `in ${ra}–${rb} min`;
  }
  const ha = (a / 60).toFixed(1), hb = (b / 60).toFixed(1);
  return ha === hb ? `in ~${ha} h` : `in ${ha}–${hb} h`;
}

// ───────────── local time (the VM's time zone, which may differ from the webview's) ─────────────

const cache = new Map<string, Intl.DateTimeFormat>();
function dtf(fmt: TimeFmt, o: Intl.DateTimeFormatOptions, locale = fmt.locale): Intl.DateTimeFormat {
  const key = JSON.stringify([locale, fmt.hour12, fmt.timeZone, o]);
  let f = cache.get(key);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions = { ...o, timeZone: fmt.timeZone };
    if (fmt.hour12 !== undefined && o.hour) opts.hour12 = fmt.hour12;
    try { f = new Intl.DateTimeFormat(locale, opts); } catch { f = new Intl.DateTimeFormat(undefined, o); }
    cache.set(key, f);
  }
  return f;
}

/** Local time minus UTC at instant t, in ms (whole minutes). */
export function zoneOffset(t: number, tz?: string): number {
  const p: Record<string, number> = {};
  const f = dtf({ timeZone: tz }, { hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }, 'en-US');
  for (const x of f.formatToParts(t)) p[x.type] = Number(x.value);
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return Math.round((local - (t - (((t % 1000) + 1000) % 1000))) / 60_000) * 60_000;
}

/** Instants in (from, to] where the local clock is a whole multiple of `stepMin` minutes since
 *  midnight: 60 gives each local hour, 1440 each local midnight (DST-aware). */
export function localBoundaries(from: number, to: number, stepMin: number, tz?: string): number[] {
  const out: number[] = [], step = stepMin * 60_000;
  let t = from;
  for (let guard = 0; guard < 500 && t < to; guard++) {
    const off = zoneOffset(t, tz);
    const b = Math.floor((t + off) / step) * step + step;
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

export const hms = (t: number, fmt: TimeFmt) => dtf(fmt, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(t);
const dayMonth = (t: number, fmt: TimeFmt) => dtf(fmt, { day: 'numeric', month: 'short' }).format(t);
/** "Mon 19 Oct 09:00": unambiguous in any week. */
export const dateTime = (t: number, fmt: TimeFmt) => `${axisDay(t, fmt)} ${dayMonth(t, fmt)} ${axisHour(t, fmt)}`;

/** "10:06 → 15:06" for windows up to a day, "Mon 19 Oct 09:00 → Mon 26 Oct 09:00" beyond. */
export function windowRange(from: number, to: number, fmt: TimeFmt): string {
  const f = to - from <= 86_400_000 ? axisHour : dateTime;
  return `${f(from, fmt)} → ${f(to, fmt)}`;
}

/** Rounds an ETA the way the verdict copy does: 5 min for short windows, 30 min for weekly ones. */
export const roundEta = (t: number, windowMs?: number) => {
  const q = (windowMs ?? 0) > 86_400_000 ? 1_800_000 : 300_000;
  return Math.round(t / q) * q;
};
