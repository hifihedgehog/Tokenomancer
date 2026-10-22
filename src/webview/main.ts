// The webview entry (media/view.js), shared by the dashboard tab and the Explorer view.
// It renders whatever the host last sent; all copy and numbers come from the view model.

import { BucketVM, DetailVM, FromView, RunCommand, ToView, ViewModel } from '../ui/types';
import { banners, cards, header, headline } from './cards';
import { Ctx, Cursor, UiState } from './ctx';
import { Child, h, patch } from './dom';
import { detail, footer, local, signedOut } from './sections';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };

const api = acquireVsCodeApi();
const root = document.getElementById('tk-root')!;
const surface = document.body.dataset.surface === 'view' ? 'view' : 'panel';
const SAY_EVERY = 60_000;

const STUB: ViewModel = {
  v: 1, seq: 0, now: 0, sample: false, fmt: {}, rounding: 'floor', pollMs: 60_000,
  display: { uncertainty: 'off', icon: 'rune', highlight: 'nearLimit', graphics: 'images', show: 'all' },
  fresh: { state: 'starting', stale: false, refreshing: true, role: 'solo' },
  headline: { strong: 'Reading your plan usage…', rest: '', tone: 'neutral' },
  reasons: [], buckets: [], shown: [], extras: [], notes: [],
  local: { from: 0, to: 0, label: '', requests: 0, usd: 0, byFamily: [], tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } },
};

let ui = restore(api.getState());
let vm: ViewModel | undefined = ui.last?.vm, info: DetailVM | undefined = ui.last?.detail;
// Ages run from the model's own clock (sample mode freezes it), advanced by local monotonic time.
let receivedAt = performance.now() - (ui.last ? Math.max(0, Date.now() - ui.last.at) : 0);
let busy = false, cur: Cursor | undefined, focusKey: string | undefined, raf = 0, failed = false;
const widths: Record<string, number> = {};
const seen = new Map<string, string>(), queued = new Map<string, string>();
let said = '', lastSay = -Infinity, sayTimer: ReturnType<typeof setTimeout> | undefined;

function restore(s: unknown): UiState {
  const o = (s && typeof s === 'object' ? s : {}) as Partial<UiState>;
  const rec = (x: unknown) => (x && typeof x === 'object' ? { ...(x as Record<string, boolean>) } : {});
  const ok = o.v === 1 && o.last?.vm?.v === 1 && Array.isArray(o.last.vm.buckets);
  return { v: 1, selected: typeof o.selected === 'string' ? o.selected : undefined, tables: rec(o.tables), open: rec(o.open), last: ok ? o.last : undefined };
}

const post = (m: FromView) => api.postMessage(m);
const save = () => api.setState(ui);

function selected(v: ViewModel): BucketVM | undefined {
  const by = (k?: string) => v.buckets.find(b => b.key === k);
  return by(ui.selected) ?? by(info?.key) ?? v.buckets.find(b => b.binding) ?? v.buckets[0];
}

function ctx(): Ctx {
  const v = vm ?? STUB;
  return {
    vm: v, detail: info, sel: selected(v), surface, busy, ui, cur, focusKey,
    sr: document.body.classList.contains('vscode-using-screen-reader'),
    w: (id, fb) => widths[id] ?? fb,
    ageMs: () => (vm?.fresh.lastOkAt === undefined ? undefined : vm.now - vm.fresh.lastOkAt + (performance.now() - receivedAt)),
    run: (command: RunCommand) => post({ type: 'run', command }),
    select(key) {
      ui.selected = key; focusKey = key; save();
      post({ type: 'select', key });
      paint();
    },
    moveFocus(key) {
      focusKey = key;
      paint();
      root.querySelectorAll<HTMLElement>('.tk-card').forEach(el => { if (el.dataset.key === key) el.focus(); });
    },
    setCur(c) { cur = c; schedule(); },
    toggle(map, id) {
      const now = map === 'tables' ? (ui.tables[id] ?? this.sr) : !!ui.open[id];
      ui[map][id] = !now; save();
      schedule();
    },
  };
}

function app(c: Ctx): Child[] {
  const v = c.vm, out: Child[] = [
    h('svg', { class: 'tk-defs', width: 0, height: 0, 'aria-hidden': 'true' },
      h('defs', null, h('pattern', { id: 'tk-hatch', width: 3, height: 3, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
        h('rect', { class: 'tk-hatchl', width: 1, height: 3 })))),
    h('div', { class: 'tk-sr', role: 'status', 'aria-live': 'polite' }, said),
    header(c), banners(c),
  ];
  if (!v.buckets.length && v.fresh.state === 'signed-out') return [...out, signedOut(c), local(c), footer(c)];
  out.push(headline(c), cards(c));
  if (c.sel) out.push(detail(c, c.sel, v.buckets.indexOf(c.sel)));
  else out.push(local(c));
  if (c.surface === 'view') out.push(h('button', { class: 'tk-btn tk-open', type: 'button', onclick: () => c.run('openDashboard') }, 'Open dashboard'));
  if (c.vm.now) out.push(footer(c));
  return out;
}

/** Reads every data-w element's width; true when any changed, so the charts must be redrawn. */
function measure(): boolean {
  let changed = false;
  root.querySelectorAll<HTMLElement>('[data-w]').forEach(el => {
    const w = Math.round(el.getBoundingClientRect().width);
    if (w > 0 && widths[el.dataset.w!] !== w) { widths[el.dataset.w!] = w; changed = true; }
  });
  return changed;
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(paint);
}

function paint() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  try {
    // Draw, measure what layout gave the charts, and redraw at the real width in the same frame.
    for (let pass = 0; pass < 3; pass++) {
      const active = document.activeElement as HTMLElement | null;
      patch(root, app(ctx()));
      if (active && active.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
      if (!measure()) break;
    }
    root.setAttribute('aria-busy', vm ? 'false' : 'true');
    failed = false;
  } catch (e) {
    fail(e);
  }
}

function fail(e: unknown) {
  if (!failed) post({ type: 'error', message: String(e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : e).slice(0, 2000) });
  failed = true;
  const box = document.createElement('div'), p = document.createElement('p'), b = document.createElement('button');
  box.className = 'tk-failed';
  box.setAttribute('role', 'alert');
  p.textContent = 'Something went wrong drawing this view.';
  b.className = 'tk-btn2';
  b.type = 'button';
  b.textContent = 'Open report';
  b.onclick = () => post({ type: 'run', command: 'showDetails' });
  box.append(p, b);
  root.replaceChildren(box);
  root.setAttribute('aria-busy', 'false');
}

/** Speaks state, verdict and attention changes only — never ticking numbers — at most once a minute. */
function announce(next: ViewModel) {
  for (const b of next.buckets) {
    const sig = `${b.state}|${b.verdict}|${b.attention}`, old = seen.get(b.key);
    seen.set(b.key, sig);
    if (old === undefined || old === sig) continue;
    const [os, ov, oa] = old.split('|');
    const parts = [os !== b.state && `${b.long} is now ${b.text.state}.`, (ov !== b.verdict || oa !== String(b.attention)) && `${b.long}: ${b.text.verdict}.`];
    queued.set(b.key, parts.filter(Boolean).join(' '));
  }
  if (!queued.size || sayTimer) return;
  sayTimer = setTimeout(() => {
    said = [...queued.values()].join(' ');
    queued.clear();
    lastSay = performance.now();
    sayTimer = undefined;
    schedule();
  }, Math.max(0, lastSay + SAY_EVERY - performance.now()));
}

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as ToView;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'model' && m.vm?.v === 1 && Array.isArray(m.vm.buckets)) {
    vm = m.vm;
    if (m.detail && m.detail.key && m.detail.window && m.detail.zoom && m.detail.mix) info = m.detail;
    receivedAt = performance.now();
    ui.last = { vm, detail: info, at: Date.now() };
    save();
    announce(vm);
    schedule();
  } else if (m.type === 'busy') {
    busy = !!m.value;
    schedule();
  } else if (m.type === 'select' && typeof m.key === 'string') {
    ui.selected = m.key;
    focusKey = undefined;
    save();
    schedule();
  }
});

new ResizeObserver(() => { if (measure()) schedule(); }).observe(root);
// VS Code toggles body classes for theme, reduced motion and screen-reader mode.
new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['class'] });
setInterval(schedule, 15_000);   // keeps "read 40 s ago" current; patch() rewrites only that text
paint();
post({ type: 'ready', surface });
