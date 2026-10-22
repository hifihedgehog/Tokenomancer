// The top of every surface: header with the freshness chip, notice banners, the headline and
// one card per limit (state chip, value ±, meter, Loupe, verdict).

import { age } from '../ui/time';
import { BucketVM, FreshState, LoupeVM, RunCommand } from '../ui/types';
import { Ctx } from './ctx';
import { Child, h, rect, VNode } from './dom';
import { abs, ceil, clamp, localBoundaries, max, min, WAITING } from './fmt';
import { icon, IconName, rune } from './icons';

const FRESH: Record<FreshState, [string, string]> = {
  starting: ['Reading usage…', 'hollow'], live: ['Live', 'ok'], delayed: ['Delayed', 'warn'], stale: ['Last known', 'hollow'],
  offline: ['Offline', ''], 'rate-limited': ['Rate-limited', 'warn'], expired: ['Sign-in expired', ''], auth: ['Sign-in refused', 'warn'],
  'signed-out': ['Signed out', ''], format: ['Unavailable', 'warn'],
};

export const button = (label: string, cmd: RunCommand, c: Ctx, cls = 'btn2') =>
  h('button', { class: cls, onclick: () => c.run(cmd) }, label);

/** A status icon: warning at attention 1–2 (or a warn tone), error at 3. */
export const alertIcon = (crit: boolean) => icon(crit ? 'error' : 'warning', crit ? 'ci' : 'wi');

function freshness(c: Ctx): VNode {
  const f = c.vm.fresh, [word, dot] = FRESH[f.state] ?? FRESH.live, ms = c.ageMs();
  const rest = (f.state === 'offline' || f.state === 'rate-limited') && f.nextTryText ? `retry ${f.nextTryText}`
    : ms !== undefined && f.state !== 'signed-out' && f.state !== 'starting' ? age(ms, 'view') : '';
  return h('span.fresh', { title: f.reason ?? null }, h('span.dot', { class: dot || null }), h('span.fw', word), rest && h('span', ` · ${rest}`));
}

const TOOLS: [IconName, string, RunCommand][] = [
  ['refresh', 'Refresh now', 'refresh'], ['copy', 'Copy usage summary', 'copySummary'],
  ['output', 'Open full report', 'showDetails'], ['gear', 'Settings', 'openSettings'],
];

export function header(c: Ctx): VNode {
  const panel = c.surface === 'panel';
  return h('header.head',
    panel && [rune('pinned', 16, true, 'brand'), h('h1.title', 'Claude Usage')],
    c.vm.sample && h('span.chip', icon('beaker'), 'Sample data'),
    freshness(c),
    panel && h('div.tools', { role: 'toolbar', 'aria-label': 'Usage actions' }, TOOLS.map(([ic, label, cmd]) => {
      const busy = cmd === 'refresh' && (c.busy || c.vm.fresh.refreshing);
      return h('button.ib', { 'aria-label': label, title: label, disabled: busy, 'aria-busy': busy ? 'true' : null, onclick: () => c.run(cmd) }, icon(ic));
    })));
}

const NOTICE: Partial<Record<FreshState, [string, RunCommand] | null>> = {
  stale: ['Retry', 'refresh'], offline: ['Retry', 'refresh'], 'rate-limited': ['Retry', 'refresh'],
  expired: null, auth: ['Show log', 'showLog'], format: ['Open report', 'showDetails'],
};

export function banners(c: Ctx): Child[] {
  const vm = c.vm, st = vm.fresh.state, out: Child[] = [];
  if (vm.sample) out.push(banner('beaker', ['Sample data — not your account.'], button('Exit', 'exitSampleData', c, 'link'), true));
  const lines = vm.reasons.length ? vm.reasons : vm.fresh.reason ? [vm.fresh.reason] : [];
  const act = NOTICE[st];
  if (act !== undefined && lines.length) out.push(banner(act ? 'warning' : 'info', lines, act && button(act[0], act[1], c, 'link'), !act));
  return out;
}

/** A notice: a rule, an icon and sentences, with the action at the end of the last one. */
function banner(ic: IconName, lines: string[], act: Child, info = false): VNode {
  return h('div.banner', { class: info ? 'info' : null, role: 'note' }, icon(ic, info ? '' : 'wi'),
    h('div.btext', lines.map((l, i) => h('p', l, i === lines.length - 1 && act && [' ', act]))));
}

export function headline(c: Ctx): VNode {
  const { strong, rest, tone } = c.vm.headline;
  const sep = rest && !/^\s*[—–\-·,.:;]/.test(rest) ? ' — ' : ' ';
  return h('p.headline', { class: tone, tabindex: 0 },
    tone !== 'neutral' && alertIcon(tone === 'crit'),
    h('span', h('b', strong), rest ? sep + rest.trim() : ''));
}

// ───────────────────────────── cards ─────────────────────────────

export const chip = (b: Pick<BucketVM, 'rune' | 'text'>) => h('span.chip', { title: b.text.stateTip }, rune(b.rune, 10), b.text.state);

const dividers = new Map<string, number[]>();
/** Local hours (5-hour) or midnights (weekly) inside the window, as fractions of it. */
function calendar(b: BucketVM, tz?: string): number[] {
  const s = b.windowStart, w = b.windowMs;
  if (!s || !w) return [];
  const key = `${s}:${w}:${tz}`;
  let out = dividers.get(key);
  if (!out) {
    out = localBoundaries(s, s + w - 60_000, w > 86_400_000 ? 1440 : 60, tz).map(t => (t - s) / w);
    if (dividers.size > 20) dividers.clear();
    dividers.set(key, out);
  }
  return out;
}

function meter(b: BucketVM, W: number, tz?: string): VNode {
  const m = b.meter, x = (p: number) => (W * clamp(p, 0, 100)) / 100, g0 = m.ghost && max(0, x(m.ghost[0]) - 3);
  const runsOut = b.pace?.runOut && b.resetsAt && b.pace.runOut.from <= b.resetsAt;
  return h('svg.meter', { width: W, height: 12, viewBox: `0 0 ${W} 12` },
    rect('track', 0, 3, W, 6, 3),
    m.ghost && m.ghost[1] > m.ghost[0] && rect('ghost', g0!, 3, x(m.ghost[1]) - g0!, 6, 3),
    m.fill > 0 && rect(m.tone === 'accent' ? 'fill' : `fill ${m.tone}`, 0, 3, max(2, x(m.fill)), 6, 3),
    calendar(b, tz).map(f => rect('div', W * f - 0.75, 3, 1.5, 6)),
    runsOut && rect('endcap', W - 2, 1, 2, 10),
    m.elapsed !== undefined && rect('marker', clamp(x(m.elapsed) - 1, 0.5, W - 2.5), 0.5, 2, 11, 1));
}

/** The Loupe: one or two official whole numbers, magnified, with the estimate's bands on them. */
export function loupe(l: LoupeVM, W: number): VNode {
  const span = l.to - l.from || 1, x = (p: number) => 1 + ((W - 2) * (clamp(p, l.from, l.to) - l.from)) / span;
  const kids: Child[] = [rect('mid', 2, 10.5, W - 4, 1)];
  for (let k = ceil(l.from * 10 + 1e-6); k < l.to * 10 - 1e-6; k++) {
    const p = k / 10, centre = abs(((p - l.from) % 1) - 0.5) < 1e-6;
    if (!l.edges.some(e => abs(e - p) < 1e-6)) kids.push(rect('tenth', x(p) - 0.5, centre ? 6.5 : 8.5, 1, centre ? 9 : 5));
  }
  const band = (r: [number, number] | undefined, cls: string, y: number, ht: number, toEnd = false) => {
    if (!r) return null;
    const a = x(r[0]), b = toEnd ? W - 1 : x(r[1]);
    return rect(cls, min(a, b - 1), y, max(1.5, b - a), ht);
  };
  if (l.mode === 'graded') kids.push(band(l.band2, 'band2', 6, 10), band(l.band1, 'band1', 4, 14));
  else if (l.mode === 'flat') kids.push(band(l.band2, 'flat', 4, 14));
  else if (l.mode === 'range') kids.push(band(l.band2 ?? [l.from, l.to], 'wash', 4, 14));
  else if (l.mode === 'atLeast') kids.push(band(l.band2, 'wash', 4, 14, true), h('path.chev', { d: `M${W - 6} 7l5 4-5 4z` }));
  l.edges.forEach((e, i) => {
    const inner = i > 0 && i < l.edges.length - 1;
    kids.push(rect('scale', clamp(x(e) - (inner ? 0.5 : 1), 0, W - 2), 0, inner ? 1 : 2, 22));
  });
  const soft = l.mode === 'flat';
  if (l.tick !== undefined && (l.mode === 'graded' || soft)) kids.push(rect(soft ? 'tick soft' : 'tick', x(l.tick) - (soft ? 0.5 : 1), 0, soft ? 1 : 2, 22));
  if (l.overL) kids.push(h('path.chev', { d: 'M5 7 0 11l5 4z' }));
  if (l.overR) kids.push(h('path.chev', { d: `M${W - 5} 7l5 4-5 4z` }));
  return h('svg', { width: W, height: 22, viewBox: `0 0 ${W} 22` }, kids);
}

function card(c: Ctx, b: BucketVM, i: number, many: boolean): VNode {
  const sel = c.sel?.key === b.key, att = b.attention;
  return h('div.card', {
    key: b.key, role: 'tab', id: `tk-tab-${i}`, 'data-key': b.key, 'aria-selected': String(sel), 'aria-controls': 'tk-detail',
    tabindex: (c.focusKey ?? c.sel?.key) === b.key ? 0 : -1, 'aria-label': b.text.spoken, 'aria-describedby': `tk-vd-${i}`,
    onclick: () => c.select(b.key), onkeydown: (e: KeyboardEvent) => cardKey(c, e, b.key),
  },
    h('div.row1', h('span.label', b.long), chip(b),
      b.binding && many && h('span.chip.bind', { title: 'The status bar leads with this limit: it binds first.' }, 'binds first')),
    h('div.value', h('span.big', b.text.value), b.text.pm && h('span.pm', b.text.pm)),
    h('div.mw', { 'data-w': i ? null : 'card' }, meter(b, c.w('card', 240), c.vm.fmt.timeZone)),
    b.loupe.mode === 'none' ? h('div.loupe.none') : h('div.loupe', { title: b.text.caption },
      h('span.edge', b.loupe.edgeLabels[0]), h('div.lw', { 'data-w': i ? null : 'loupe' }, loupe(b.loupe, c.w('loupe', 200))), h('span.edge', b.loupe.edgeLabels[1])),
    h('div.verdict', { id: `tk-vd-${i}` }, att > 0 && alertIcon(att >= 3), h('span', b.text.verdict), h('span.sr', `. ${b.text.caption}`)));
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
const placeholder = (label: string) => h('div.card.ph', { 'aria-hidden': 'true' },
  h('div.row1', h('span.label', label), h('span.chip', rune('empty', 10), 'waiting')),
  h('div.value', h('span.big', '—')),
  h('div.mw', h('svg.meter', { height: 12 }, rect('track', 0, 3, '100%', 6, 3))),
  h('div.loupe.none'),
  h('div.verdict', h('span', WAITING)));

export function cards(c: Ctx): VNode {
  const bs = c.vm.buckets;
  return h('div.cards', { role: 'tablist', 'aria-label': 'Limits' },
    bs.length ? bs.map((b, i) => card(c, b, i, bs.length > 1)) : [placeholder('5-hour'), placeholder('Weekly')]);
}
