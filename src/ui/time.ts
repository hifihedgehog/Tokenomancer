// Time formatting shared by the host and the webview, so every surface prints
// the same clock and span for the same instant. Pure: no vscode, no Node.

import { TimeFmt } from './types';

const cache = new Map<string, Intl.DateTimeFormat>();
function dtf(fmt: TimeFmt, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([fmt.locale, fmt.hour12, fmt.timeZone, opts]);
  let f = cache.get(key);
  if (!f) {
    const o: Intl.DateTimeFormatOptions = { ...opts, timeZone: fmt.timeZone };
    if (fmt.hour12 !== undefined && (opts.hour || opts.timeStyle)) o.hour12 = fmt.hour12;
    try { f = new Intl.DateTimeFormat(fmt.locale, o); } catch { f = new Intl.DateTimeFormat(undefined, { ...opts }); }
    cache.set(key, f);
  }
  return f;
}

/** Day number of an instant in the display time zone (days since the epoch). */
export function dayIndex(t: number, fmt: TimeFmt = {}): number {
  const parts = dtf(fmt, { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(t);
  const get = (k: string) => Number(parts.find(p => p.type === k)?.value);
  return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / 86_400_000);
}

/** "16:00" today, "Thu 09:00" within the next 6 days, otherwise "Thu 29 Oct 09:00". */
export function clock(t: number, now: number, fmt: TimeFmt = {}): string {
  const time = dtf(fmt, { hour: 'numeric', minute: '2-digit' }).format(t);
  const d = dayIndex(t, fmt) - dayIndex(now, fmt);
  if (d === 0) return time;
  const wd = dtf(fmt, { weekday: 'short' }).format(t);
  if (d > 0 && d < 7) return `${wd} ${time}`;
  const date = dtf(fmt, { day: 'numeric', month: 'short' }).format(t);
  return `${wd} ${date} ${time}`;
}

/** Spoken clock for screen readers: "1:30 PM", "Saturday 1:30 PM", "Thursday 29 October 9:00 AM". */
export function spokenClock(t: number, now: number, fmt: TimeFmt = {}): string {
  const time = dtf(fmt, { hour: 'numeric', minute: '2-digit' }).format(t);
  const d = dayIndex(t, fmt) - dayIndex(now, fmt);
  if (d === 0) return time;
  const wd = dtf(fmt, { weekday: 'long' }).format(t);
  if (d > 0 && d < 7) return `${wd} ${time}`;
  return `${wd} ${dtf(fmt, { day: 'numeric', month: 'long' }).format(t)} ${time}`;
}

/** Compact duration: "<1m", "7m", "1h 34m", "3d 20h". */
export function span(ms: number): string {
  if (!isFinite(ms)) return '—';
  const m = Math.max(0, Math.round(ms / 60_000));
  if (ms < 60_000) return '<1m';
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) {
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }
  const hTotal = Math.round(ms / 3_600_000);
  const d = Math.floor(hTotal / 24), h = hTotal % 24;
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** Spoken duration: "less than a minute", "7 minutes", "1 hour 34 minutes", "3 days 20 hours". */
export function spokenSpan(ms: number): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (!isFinite(ms) || ms < 60_000) return 'less than a minute';
  const m = Math.round(ms / 60_000);
  if (m < 60) return plural(m, 'minute');
  if (m < 24 * 60) {
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${plural(h, 'hour')} ${plural(r, 'minute')}` : plural(h, 'hour');
  }
  const hTotal = Math.round(ms / 3_600_000);
  const d = Math.floor(hTotal / 24), h = hTotal % 24;
  return h ? `${plural(d, 'day')} ${plural(h, 'hour')}` : plural(d, 'day');
}

/**
 * How long ago a reading was taken.
 *  bar:   "12m ago", "2h ago", "2d ago"                      (status bar suffix)
 *  hover: "read just now", "read 3 min ago", "read 2 h ago"  (minute-granular, so an open hover doesn't churn)
 *  view:  "read 40 s ago", "read 3 min ago"                   (the webview refreshes it locally)
 */
export function age(ms: number, style: 'bar' | 'hover' | 'view'): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (style === 'bar') return d >= 1 ? `${d}d ago` : h >= 1 ? `${h}h ago` : `${Math.max(1, m)}m ago`;
  if (style === 'view' && s < 60) return s < 5 ? 'read just now' : `read ${Math.round(s / 5) * 5} s ago`;
  if (m < 1) return 'read just now';
  if (h < 1) return `read ${m} min ago`;
  if (d < 1) return `read ${h} h ago`;
  return `read ${d} d ago`;
}

/** Hour and minute for chart axes and tooltips: "11:00", "Tue", "Thu 11:40". */
export function axisHour(t: number, fmt: TimeFmt = {}): string {
  return dtf(fmt, { hour: 'numeric', minute: '2-digit' }).format(t);
}
export function axisDay(t: number, fmt: TimeFmt = {}): string {
  return dtf(fmt, { weekday: 'short' }).format(t);
}
export function tipTime(t: number, now: number, fmt: TimeFmt = {}): string {
  return clock(t, now, fmt);
}
