// The top of every surface: header with the freshness chip, notice banners, the headline and
// one card per limit (state chip, value ± , meter, Loupe, verdict).

import { BucketVM, FreshState, LoupeVM, RunCommand } from '../ui/types';
import { age, clock } from '../ui/time';
import { Ctx } from './ctx';
import { Child, h, VNode } from './dom';
import { clamp, localBoundaries } from './fmt';
import { icon, IconName, rune } from './icons';
import { f1 } from './scale';

const FRESH: Record<FreshState, [string, string]> = {
  starting: ['Reading usage…', 'hollow'],
  live: ['Live', 'ok'],
  delayed: ['Delayed', 'warn'],
  stale: ['Last known', 'hollow'],
  offline: ['Offline', 'muted'],
  'rate-limited': ['Rate-limited', 'warn'],
  expired: ['Sign-in expired', 'muted'],
  auth: ['Sign-in refused', 'warn'],
  'signed-out': ['Signed out', 'muted'],
  format: ['Unavailable', 'warn'],
};

export function button(label: string, cmd: RunCommand, c: Ctx, cls = 'tk-btn2'): VNode {
  return h('button', { class: cls, type: 'button', onclick: () => c.run(cmd) }, label);
}

function freshness(c: Ctx): VNode {
  const f = c.vm.fresh, [word, dot] = FRESH[f.state] ?? FRESH.live;
  const ms = c.ageMs();
  let rest = '';
  if ((f.state === 'offline' || f.state === 'rate-limited') && f.nextTryAt) rest = `retry ${f.nextTryText ?? clock(f.nextTryAt, c.vm.now, c.vm.fmt)}`;
  else if (ms !== undefined && f.state !== 'signed-out' && f.state !== 'starting') rest = age(ms, 'view');
  return h('span', { class: 'tk-fresh', title: f.reason ?? null },
    h('span', { class: `tk-dot ${dot}`, 'aria-hidden': 'true' }),
    h('span', { class: 'tk-fw' }, word),
    rest && h('span', null, ` · ${rest}`));
}

const TOOLS: [IconName, string, RunCommand][] = [
  ['refresh', 'Refresh now', 'refresh'], ['copy', 'Copy usage summary', 'copySummary'],
  ['output', 'Open full report', 'showDetails'], ['gear', 'Settings', 'openSettings'],
];

export function header(c: Ctx): VNode {
  const panel = c.surface === 'panel';
  return h('header', { class: 'tk-head' },
    panel && rune('pinned', 16, true, 'tk-brand'),
    panel && h('h1', { class: 'tk-title' }, 'Claude Usage'),
    c.vm.sample && h('span', { class: 'tk-chip' }, icon('beaker'), 'Sample data'),
    freshness(c),
    panel && h('div', { class: 'tk-tools', role: 'toolbar', 'aria-label': 'Usage actions' },
      TOOLS.map(([ic, label, cmd]) => {
        const busy = cmd === 'refresh' && (c.busy || c.vm.fresh.refreshing);
        return h('button', { class: 'tk-ib', type: 'button', 'aria-label': label, title: label, disabled: busy, 'aria-busy': busy ? 'true' : null, onclick: () => c.run(cmd) }, icon(ic));
      })));
}

const NOTICE: Partial<Record<FreshState, { info?: boolean; act?: [string, RunCommand] }>> = {
  stale: { act: ['Retry', 'refresh'] },
  offline: { act: ['Retry', 'refresh'] },
  'rate-limited': { act: ['Retry', 'refresh'] },
  expired: { info: true },
  auth: { act: ['Show log', 'showLog'] },
  format: { act: ['Open report', 'showDetails'] },
};

export function banners(c: Ctx): Child[] {
  const vm = c.vm, out: Child[] = [];
  if (vm.sample) out.push(banner(true, 'beaker', ['Sample data — not your account.'], button('Exit', 'exitSampleData', c, 'tk-link')));
  const n = NOTICE[vm.fresh.state];
  const lines = vm.reasons.length ? vm.reasons : vm.fresh.reason ? [vm.fresh.reason] : [];
  if (n && (lines.length || vm.fresh.state === 'format')) {
    const text = vm.fresh.state === 'format' && !lines.length
      ? ['The usage endpoint answered in an unexpected format. Token counts still work; percentages are paused.'] : lines;
    out.push(banner(!!n.info, n.info ? 'info' : 'warning', text, n.act && button(n.act[0], n.act[1], c, 'tk-link')));
  }
  return out;
}

function banner(info: boolean, ic: IconName, lines: string[], act: Child): VNode {
  return h('div', { class: `tk-banner${info ? ' info' : ''}`, role: 'note' },
    icon(ic, info ? '' : 'tk-warn-ic'),
    h('div', { class: 'tk-btext' }, lines.map(l => h('p', null, l)), act && h('p', null, act)));
}

export function headline(c: Ctx): VNode {
  const { strong, rest, tone } = c.vm.headline;
  const sep = rest && !/^\s*[—–\-·,.:;]/.test(rest) ? ' — ' : ' ';
  return h('p', { class: `tk-headline ${tone}`, tabindex: 0 },
    tone !== 'neutral' && icon(tone === 'crit' ? 'error' : 'warning', tone === 'crit' ? 'tk-crit-ic' : 'tk-warn-ic'),
    h('span', null, h('b', null, strong), rest ? sep + rest.trim() : ''));
}

// ───────────────────────────── cards ─────────────────────────────

export function chip(b: Pick<BucketVM, 'rune' | 'text'>): VNode {
  return h('span', { class: 'tk-chip', title: b.text.stateTip }, rune(b.rune, 10), b.text.state);
}

const dividers = new Map<string, number[]>();
/** Local hours (5-hour) or midnights (weekly) inside the window, as fractions of it. */
function calendar(b: BucketVM, tz?: string): number[] {
  if (!b.windowStart || !b.windowMs) return [];
  const key = `${b.windowStart}:${b.windowMs}:${tz}`;
  let out = dividers.get(key);
  if (!out) {
    const step = b.windowMs > 86_400_000 ? 1440 : 60;
    out = localBoundaries(b.windowStart, b.windowStart + b.windowMs - 60_000, step, tz).map(t => (t - b.windowStart!) / b.windowMs!);
    if (dividers.size > 20) dividers.clear();
    dividers.set(key, out);
  }
  return out;
}

function meter(b: BucketVM, W: number, tz?: string): VNode {
  const m = b.meter, x = (p: number) => (W * clamp(p, 0, 100)) / 100;
  const fill = Math.max(2, x(m.fill)), tone = m.tone === 'accent' ? '' : ` ${m.tone}`;
  const runsOut = b.pace?.runOut && b.resetsAt && b.pace.runOut.from <= b.resetsAt;
  return h('svg', { class: 'tk-meter', width: W, height: 12, viewBox: `0 0 ${W} 12`, 'aria-hidden': 'true' },
    h('rect', { class: 'tk-track', x: 0, y: 3, width: W, height: 6, rx: 3 }),
    m.ghost && m.ghost[1] > m.ghost[0] && h('rect', { class: 'tk-ghost', x: f1(Math.max(0, x(m.ghost[0]) - 3)), y: 3, width: f1(x(m.ghost[1]) - Math.max(0, x(m.ghost[0]) - 3)), height: 6, rx: 3 }),
    m.fill > 0 && h('rect', { class: `tk-fill${tone}`, x: 0, y: 3, width: f1(fill), height: 6, rx: 3 }),
    calendar(b, tz).map(f => h('rect', { class: 'tk-div', x: f1(W * f - 0.75), y: 3, width: 1.5, height: 6 })),
    runsOut && h('rect', { class: 'tk-endcap', x: W - 2, y: 1, width: 2, height: 10 }),
    m.elapsed !== undefined && h('rect', { class: 'tk-marker', x: f1(clamp(x(m.elapsed) - 1, 0.5, W - 2.5)), y: 0.5, width: 2, height: 11, rx: 1 }));
}

/** The Loupe: one or two official whole numbers, magnified, with the estimate's bands on them. */
export function loupe(l: LoupeVM, W: number): VNode {
  const span = l.to - l.from || 1, x = (p: number) => 1 + ((W - 2) * (clamp(p, l.from, l.to) - l.from)) / span;
  const kids: Child[] = [h('rect', { class: 'tk-mid', x: 2, y: 10.5, width: W - 4, height: 1 })];
  for (let k = Math.ceil(l.from * 10 + 1e-6); k < l.to * 10 - 1e-6; k++) {
    const p = k / 10;
    if (l.edges.some(e => Math.abs(e - p) < 1e-6)) continue;
    const centre = Math.abs(((p - l.from) % 1) - 0.5) < 1e-6;
    kids.push(h('rect', { class: 'tk-tenth', x: f1(x(p) - 0.5), y: centre ? 6.5 : 8.5, width: 1, height: centre ? 9 : 5 }));
  }
  const band = (r: [number, number] | undefined, cls: string, y: number, hgt: number, toEnd = false) => {
    if (!r) return null;
    const a = x(r[0]), b = toEnd ? W - 1 : x(r[1]);
    return h('rect', { class: cls, x: f1(Math.min(a, b - 1)), y, width: f1(Math.max(1.5, b - a)), height: hgt });
  };
  if (l.mode === 'graded') kids.push(band(l.band2, 'tk-band2', 6, 10), band(l.band1, 'tk-band1', 4, 14));
  else if (l.mode === 'flat') kids.push(band(l.band2, 'tk-flat', 4, 14));
  else if (l.mode === 'range') kids.push(band(l.band2 ?? [l.from, l.to], 'tk-wash', 4, 14));
  else if (l.mode === 'atLeast') kids.push(band(l.band2, 'tk-wash', 4, 14, true), h('path', { class: 'tk-chev', d: `M${W - 6} 7l5 4-5 4z` }));
  l.edges.forEach((e, i) => {
    const mid = i > 0 && i < l.edges.length - 1;
    kids.push(h('rect', { class: 'tk-scale', x: f1(clamp(x(e) - (mid ? 0.5 : 1), 0, W - 2)), y: 0, width: mid ? 1 : 2, height: 22 }));
  });
  if (l.tick !== undefined && (l.mode === 'graded' || l.mode === 'flat'))
    kids.push(h('rect', { class: l.mode === 'flat' ? 'tk-tick soft' : 'tk-tick', x: f1(x(l.tick) - (l.mode === 'flat' ? 0.5 : 1)), y: 0, width: l.mode === 'flat' ? 1 : 2, height: 22 }));
  if (l.overL) kids.push(h('path', { class: 'tk-chev', d: 'M5 7L0 11l5 4z' }));
  if (l.overR) kids.push(h('path', { class: 'tk-chev', d: `M${W - 5} 7l5 4-5 4z` }));
  return h('svg', { width: W, height: 22, viewBox: `0 0 ${W} 22`, 'aria-hidden': 'true' }, kids);
}

function card(c: Ctx, b: BucketVM, i: number, many: boolean): VNode {
  const selected = c.sel?.key === b.key, focus = (c.focusKey ?? c.sel?.key) === b.key;
  const W = c.w('card', 240), LW = c.w('loupe', 200), tz = c.vm.fmt.timeZone;
  const att = b.attention;
  return h('div', {
    key: b.key, class: 'tk-card', role: 'tab', id: `tk-tab-${i}`, 'data-key': b.key,
    'aria-selected': String(selected), 'aria-controls': 'tk-detail', tabindex: focus ? 0 : -1,
    'aria-label': b.text.spoken, 'aria-describedby': `tk-vd-${i} tk-cap-${i}`,
    onclick: () => c.select(b.key),
    onkeydown: (e: KeyboardEvent) => cardKey(c, e, b.key),
  },
    h('div', { class: 'tk-row1' },
      h('span', { class: 'tk-label' }, b.long),
      chip(b),
      b.binding && many && h('span', { class: 'tk-chip tk-bind', title: 'The status bar shows this limit: it binds first.' }, 'binds first')),
    h('div', { class: 'tk-value' },
      h('span', { class: 'tk-big' }, b.text.value),
      b.text.pm && h('span', { class: 'tk-pm' }, b.text.pm)),
    h('div', { class: 'tk-mw', 'data-w': i ? null : 'card' }, meter(b, W, tz)),
    b.loupe.mode === 'none'
      ? h('div', { class: 'tk-loupe none' })
      : h('div', { class: 'tk-loupe', title: b.text.caption },
        h('span', { class: 'tk-edge' }, b.loupe.edgeLabels[0]),
        h('div', { class: 'tk-lw', 'data-w': i ? null : 'loupe' }, loupe(b.loupe, LW)),
        h('span', { class: 'tk-edge' }, b.loupe.edgeLabels[1])),
    h('div', { class: 'tk-verdict', id: `tk-vd-${i}` },
      att > 0 && icon(att >= 3 ? 'error' : 'warning', att >= 3 ? 'tk-crit-ic' : 'tk-warn-ic'),
      h('span', null, b.text.verdict)),
    h('span', { class: 'tk-sr', id: `tk-cap-${i}` }, b.text.caption));
}

function cardKey(c: Ctx, e: KeyboardEvent, key: string) {
  const keys = c.vm.buckets.map(b => b.key), i = keys.indexOf(key);
  const go = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: keys.length - 1 }[e.key];
  if (go !== undefined) {
    e.preventDefault();
    c.moveFocus(keys[(go + keys.length) % keys.length]);
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    c.select(key);
  }
}

/** Placeholder cards while the first reading is in flight: the frame, no numbers, no shimmer. */
function placeholder(label: string): VNode {
  return h('div', { class: 'tk-card ph', 'aria-hidden': 'true' },
    h('div', { class: 'tk-row1' }, h('span', { class: 'tk-label' }, label), h('span', { class: 'tk-chip' }, rune('empty', 10), 'waiting')),
    h('div', { class: 'tk-value' }, h('span', { class: 'tk-big' }, '—')),
    h('div', { class: 'tk-mw' }, h('svg', { class: 'tk-meter', width: '100%', height: 12 }, h('rect', { class: 'tk-track', x: 0, y: 3, width: '100%', height: 6, rx: 3 }))),
    h('div', { class: 'tk-loupe none' }),
    h('div', { class: 'tk-verdict' }, h('span', null, 'Waiting for the first reading.')));
}

export function cards(c: Ctx): VNode {
  const bs = c.vm.buckets;
  return h('div', { class: 'tk-cards', role: 'tablist', 'aria-label': 'Limits' },
    bs.length ? bs.map((b, i) => card(c, b, i, bs.length > 1)) : [placeholder('5-hour'), placeholder('Weekly')]);
}
