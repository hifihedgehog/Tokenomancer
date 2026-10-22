// The webview entry (media/view.js), shared by the dashboard tab and the Explorer view.
// It renders whatever the host last sent; all copy and numbers come from the view model.

import { DetailVM, FromView, ToView, ViewModel } from '../ui/types';
import { app, selected } from './app';
import { Ctx, Cursor, UiState } from './ctx';
import { h, patch } from './dom';
import { max, round } from './fmt';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };

const api = acquireVsCodeApi();
const root = document.getElementById('tk-root')!;
const surface = document.body.dataset.surface === 'view' ? 'view' : 'panel';
const SAY_EVERY = 60_000;

let ui = restore(api.getState());
let vm: ViewModel | undefined = ui.last?.vm, info: DetailVM | undefined = ui.last?.detail;
// Ages run from the model's own clock (sample mode freezes it), advanced by local monotonic time.
let receivedAt = performance.now() - (ui.last ? max(0, Date.now() - ui.last.at) : 0);
let busy = false, cur: Cursor | undefined, focusKey: string | undefined, raf = 0, failed = false;
const widths: Record<string, number> = {}, seen = new Map<string, string>(), queued = new Map<string, string>();
let said = '', lastSay = -Infinity, sayTimer: ReturnType<typeof setTimeout> | undefined;

/** Saved state from an older build, or none, starts fresh. */
function restore(s: unknown): UiState {
  const o = s as UiState | undefined;
  return o?.v === 1 && o.tables && o.open && (!o.last || Array.isArray(o.last.vm?.buckets)) ? o : { v: 1, tables: {}, open: {} };
}

const post = (m: FromView) => api.postMessage(m);
const save = () => api.setState(ui);
const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };

function ctx(v: ViewModel): Ctx {
  return {
    vm: v, detail: info, sel: selected(v, ui, info), surface, busy, ui, cur, focusKey,
    sr: document.body.classList.contains('vscode-using-screen-reader'),
    w: (id, fb) => widths[id] ?? fb,
    ageMs: () => (v.fresh.lastOkAt === undefined ? undefined : v.now - v.fresh.lastOkAt + (performance.now() - receivedAt)),
    run: command => post({ type: 'run', command }),
    select(key) {
      ui.selected = focusKey = key;
      save();
      post({ type: 'select', key });
      paint();
    },
    moveFocus(key) {
      focusKey = key;
      paint();
      root.querySelector<HTMLElement>(`.card[data-key="${CSS.escape(key)}"]`)?.focus();
    },
    setCur(c) { cur = c; schedule(); },
    toggle(map, id) {
      ui[map][id] = !(map === 'tables' ? (ui.tables[id] ?? this.sr) : ui.open[id]);
      save();
      schedule();
    },
  };
}

/** Reads every data-w element's width; true when any changed, so the charts must be redrawn. */
function measure(): boolean {
  let changed = false;
  root.querySelectorAll<HTMLElement>('[data-w]').forEach(el => {
    const w = round(el.getBoundingClientRect().width), id = el.dataset.w!;
    if (w > 0 && widths[id] !== w) { widths[id] = w; changed = true; }
  });
  return changed;
}

// Until the host's first model arrives (it answers 'ready' at once) the root stays empty and busy.
function paint() {
  cancelAnimationFrame(raf);
  raf = 0;
  if (!vm) return;
  try {
    // Draw, measure what layout gave the charts, and redraw at the real width in the same frame.
    for (let pass = 0; pass < 3; pass++) {
      const active = document.activeElement as HTMLElement | null;
      patch(root, app(ctx(vm), said));
      if (active?.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
      if (!measure()) break;
    }
    failed = false;
  } catch (e) {
    if (!failed) post({ type: 'error', message: String(e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : e).slice(0, 2000) });
    failed = true;
    root.replaceChildren();
    patch(root, [h('div.failed', { role: 'alert' }, h('p', 'Something went wrong drawing this view.'),
      h('button.btn2', { onclick: () => post({ type: 'run', command: 'showDetails' }) }, 'Open report'))]);
  }
  root.setAttribute('aria-busy', 'false');
}

/** Speaks state, verdict and attention changes only — never ticking numbers — at most once a minute. */
function announce(next: ViewModel) {
  for (const b of next.buckets) {
    const sig = `${b.state}|${b.verdict}|${b.attention}`, old = seen.get(b.key);
    seen.set(b.key, sig);
    if (old !== undefined && old !== sig) queued.set(b.key, `${b.long}: ${b.text.state}. ${b.text.verdict}.`);
  }
  if (!queued.size || sayTimer) return;
  sayTimer = setTimeout(() => {
    said = [...queued.values()].join(' ');
    queued.clear();
    lastSay = performance.now();
    sayTimer = undefined;
    schedule();
  }, max(0, lastSay + SAY_EVERY - performance.now()));
}

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as ToView;
  if (m?.type === 'model' && m.vm?.v === 1 && Array.isArray(m.vm.buckets)) {
    vm = m.vm;
    if (m.detail?.key && m.detail.window && m.detail.zoom && m.detail.mix) info = m.detail;
    receivedAt = performance.now();
    ui.last = { vm, detail: info, at: Date.now() };
    save();
    announce(vm);
  } else if (m?.type === 'busy') busy = !!m.value;
  else if (m?.type === 'select' && typeof m.key === 'string') {
    ui.selected = m.key;
    focusKey = undefined;
    save();
  } else return;
  schedule();
});

new ResizeObserver(() => { if (measure()) schedule(); }).observe(root);
// VS Code toggles body classes for theme, reduced motion and screen-reader mode.
new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['class'] });
setInterval(schedule, 15_000);   // keeps "read 40 s ago" current; patch() rewrites only that text
paint();
post({ type: 'ready', surface });
