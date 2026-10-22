// One official reading per poll interval, shared by every VS Code window on this machine.
//
// Lease model: every window runs the same loop. If usage.json holds a fresh reading, the
// window applies it. Otherwise it takes fetch.lock, re-reads usage.json (another window
// may have just written it), fetches, and replaces usage.json atomically. Backoff lives
// in the file too, so a 429 slows every window, not just the one that received it.
// Pure Node, no vscode: the extension passes the folder (<globalStorage>/shared).

import * as fs from 'fs';
import * as path from 'path';
import { UsageError, UsageResponse } from './usageApi';
import { UsageErrorKind } from './ui/types';

export interface SharedReading {
  v: 1;
  seq: number;
  t: number;                              // request-sent time
  ok: boolean;
  buckets?: Record<string, { utilization: number; resets_at: string | null }>;
  raw?: unknown;                          // the response JSON, verbatim
  error?: { kind: UsageErrorKind; message: string; code?: string };
  lastOkAt?: number;                      // t of the latest successful reading, carried on failures too
  nextTryAt: number;                      // no window fetches before this (backoff)
  by: string;                             // id of the window that fetched it
}

export interface Poll { t: number; ok: boolean }

/** usage.json: the latest reading plus the state every window shares. */
interface SharedFile extends SharedReading { pollLog: Poll[]; backoffMs: number }

export interface PollerTiming {
  lockStaleMs: number;                    // a lock this old belongs to a window that stopped mid-fetch
  statMs: number;                         // stat fallback for missed watch events
  manualMs: number;                       // manual refresh throttle
  jitterMs: number;                       // spreads windows' timers so they don't wake together
  renameRetryMs: number;                  // Windows: a reader holding usage.json blocks the rename briefly
  waitMs: number;                         // how long a manual refresh waits on another window's fetch
}

export interface PollerOptions {
  dir?: string;
  fetch: () => Promise<UsageResponse>;
  pollMs: () => number;
  now?: () => number;
  log: (level: 'info' | 'warn' | 'debug', msg: string) => void;
  id?: string;
  timing?: Partial<PollerTiming>;
}

const TIMING: PollerTiming = { lockStaleMs: 30_000, statMs: 5_000, manualMs: 10_000, jitterMs: 3_000, renameRetryMs: 50, waitMs: 20_000 };
const MIN = 60_000;
const MAX_AGE_MS = 8 * 24 * 60 * MIN;    // a weekly window plus a margin
const LOG_MS = 8 * 60 * MIN, LOG_MAX = 1000;
const FILE = 'usage.json', LOCK = 'fetch.lock';
const READ_RETRY = new Set(['ENOENT', 'EBUSY', 'EPERM', 'EACCES']);
const RENAME_RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Delay before the next try after a failure; 0 keeps the normal interval. */
export function backoffMs(kind: UsageErrorKind, pollMs: number, prevMs: number, retryAfterMs?: number): number {
  switch (kind) {
    // retry-after: 0 (or none) still backs off; a huge one is capped.
    case 'rate-limited': return Math.min(30 * MIN, Math.max(retryAfterMs ?? 0, Math.min(10 * MIN, Math.max(2 * pollMs, 2 * prevMs))));
    case 'network': case 'format': return Math.min(5 * MIN, Math.max(pollMs, 2 * prevMs));
    default: return 0; // signed out or token expired: recovers as soon as Claude Code refreshes its token
  }
}

/** Seq order, with time as the guard: a reading never replaces one requested later. */
function later(a: SharedReading, b: SharedReading): boolean {
  return a.t > b.t || (a.t === b.t && a.seq > b.seq);
}

function parse(text: string): SharedFile | undefined {
  const f = JSON.parse(text);
  if (f?.v !== 1 || typeof f.ok !== 'boolean' || ![f.seq, f.t, f.nextTryAt].every(Number.isFinite)) return undefined;
  f.pollLog = Array.isArray(f.pollLog) ? f.pollLog.filter((p: any) => Number.isFinite(p?.t) && typeof p.ok === 'boolean') : [];
  if (!Number.isFinite(f.backoffMs)) f.backoffMs = 0;
  return f;
}

function reading(f: SharedFile): SharedReading {
  const { pollLog: _log, backoffMs: _wait, ...r } = f;
  return r;
}

const waitText = (ms: number) => ms >= MIN ? `${Math.round(ms / MIN)} min` : `${Math.round(ms / 1000)} s`;

type Outcome = { ok: true; res: UsageResponse } | { ok: false; err: UsageError };

export class SharedPoller {
  readonly id: string;
  private dir?: string;
  private readonly timing: PollerTiming;
  private readonly now: () => number;
  private readonly fns = new Set<(r: SharedReading, own: boolean) => void>();
  private state?: SharedFile;             // newest known, delivered or not
  private delivered?: SharedReading;
  private maxSeq = 0;                     // keeps seq rising even if usage.json is lost
  private inflight?: Promise<void>;
  private busy = false;                   // fetching, or waiting on another window's fetch
  private lastManual = -Infinity;
  private retryAt?: number;
  private held = false;
  private lockFaults = 0;
  private started = false;
  private disposed = false;
  private timer?: NodeJS.Timeout;
  private statTimer?: NodeJS.Timeout;
  private soon?: NodeJS.Timeout;
  private watcher?: fs.FSWatcher;
  private seen = '';

  constructor(private readonly o: PollerOptions) {
    this.id = o.id ?? `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.now = o.now ?? Date.now;
    this.timing = { ...TIMING, ...o.timing };
    this.dir = this.usable(o.dir);
  }

  /** No shared folder: this window fetches for itself. */
  get solo(): boolean { return !this.dir; }
  get last(): SharedReading | undefined { return this.delivered; }
  /** Every window's polls over the last 8 hours (at most 1000). */
  get pollLog(): Poll[] { return this.state?.pollLog ?? []; }
  /** True until the reading arrives, so a render from onReading never still says "Refreshing…". */
  get refreshing(): boolean { return this.busy; }

  /** Each reading once, in order. `own`: this window fetched it. */
  onReading(fn: (r: SharedReading, own: boolean) => void): { dispose(): void } {
    this.fns.add(fn);
    return { dispose: () => { this.fns.delete(fn); } };
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    if (this.dir) {
      // A new window renders from the shared reading at once instead of waiting for a poll.
      const f = this.readSync();
      if (f) this.accept(f, false);
      this.watch();
      this.statTimer = setInterval(() => void this.poke(), this.timing.statMs);
      this.statTimer.unref?.();
    }
    if (this.due(false)) void this.refresh(false);
    else this.schedule();
  }

  /** Single-flight: callers during a run share it. Manual refreshes are throttled to one per manualMs. */
  refresh(manual: boolean): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.disposed) return Promise.resolve();
    if (manual) {
      const now = this.now();
      // Throttled: pick up anything another window wrote, but never deliver a reading twice.
      if (now >= this.lastManual && now - this.lastManual < this.timing.manualMs) return this.check();
      this.lastManual = now;
    }
    this.busy = true;
    const run = this.run(manual)
      .catch(e => this.o.log('warn', `Poll failed: ${e?.message ?? e}`))
      .finally(() => { this.inflight = undefined; this.busy = false; this.schedule(); });
    this.inflight = run;
    return run;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    clearInterval(this.statTimer);
    clearTimeout(this.soon);
    this.watcher?.close();
    this.watcher = undefined;
    this.unlock();
    this.fns.clear();
  }

  // ───────────────────────────── the loop ─────────────────────────────

  private async run(manual: boolean): Promise<void> {
    if (!this.dir) {
      if (this.due(manual)) await this.fetchOnce();
      return;
    }
    await this.check();
    for (let waited = false; this.due(manual) && !this.disposed; waited = true) {
      const lock = this.lock();
      if (lock === 'busy') {
        // Another window is fetching; its reading arrives through the watcher.
        if (!manual || waited) { this.retryAt = this.now() + this.timing.statMs; return; }
        await this.waitForOther();
        continue;
      }
      try {
        if (lock === 'held') await this.check(); // another window may have written just before we locked
        if (this.due(manual)) await this.fetchOnce();
      } finally {
        this.unlock();
      }
      return;
    }
  }

  private pollMs(): number {
    const p = Number(this.o.pollMs());
    return p > 0 ? p : 60_000;
  }

  private dueAt(s: SharedFile): number {
    return s.ok ? s.t + this.pollMs() : s.nextTryAt;
  }

  private due(manual: boolean): boolean {
    this.dropFuture();
    const s = this.state, now = this.now();
    if (!s) return true;
    if (manual) {
      const limited = !s.ok && s.error?.kind === 'rate-limited' && now < s.nextTryAt;
      return !limited && now - s.t >= this.timing.manualMs;
    }
    // Windows wake a little apart; a reading this close to due still counts as fresh.
    return now >= this.dueAt(s) - Math.min(2000, this.pollMs() / 10);
  }

  private schedule(): void {
    if (!this.started || this.disposed) return;
    clearTimeout(this.timer);
    this.dropFuture();
    const now = this.now();
    const at = Math.max(this.state ? this.dueAt(this.state) : now, this.retryAt ?? -Infinity);
    this.retryAt = undefined;
    const delay = Math.max(at - now, Math.min(1000, this.pollMs() / 10)) + Math.random() * this.timing.jitterMs;
    this.timer = setTimeout(() => void this.refresh(false), delay);
    this.timer.unref?.();
  }

  private async fetchOnce(): Promise<void> {
    this.busy = true;
    const t = this.now();
    let out: Outcome;
    try {
      out = { ok: true, res: await this.o.fetch() };
    } catch (e: any) {
      out = { ok: false, err: e instanceof UsageError ? e : new UsageError(String(e?.message ?? e), 'network') };
    }
    if (this.disposed) return;
    await this.check(); // build on the latest seq, poll log and backoff
    if (this.state && this.state.t > t) {
      this.o.log('debug', 'A newer reading arrived during the fetch; keeping it.');
      return;
    }
    const f = this.compose(t, out, this.state);
    if (this.dir) await this.write(f);
    this.o.log('debug', `Fetched usage (seq ${f.seq}, ${f.ok ? 'ok' : f.error?.code ?? f.error?.kind}).`);
    this.accept(f, true);
  }

  private compose(t: number, out: Outcome, base?: SharedFile): SharedFile {
    const now = this.now(), pollMs = this.pollMs();
    const pollLog = [...(base?.pollLog ?? []), { t, ok: out.ok }].filter(p => p.t >= now - LOG_MS).slice(-LOG_MAX);
    const common = { v: 1 as const, seq: Math.max(base?.seq ?? 0, this.maxSeq) + 1, t, by: this.id, pollLog };
    if (out.ok) {
      const buckets: NonNullable<SharedReading['buckets']> = {};
      for (const [k, b] of out.res.buckets) buckets[k] = { utilization: b.utilization, resets_at: b.resetsAt ?? null };
      return { ...common, ok: true, buckets, raw: out.res.raw, lastOkAt: t, nextTryAt: t + pollMs, backoffMs: 0 };
    }
    const { err } = out;
    const wait = backoffMs(err.kind, pollMs, base?.backoffMs ?? 0, err.retryAfterMs);
    if (wait) this.o.log('info', `Backing off for ${waitText(wait)} after ${err.code ?? err.kind}.`);
    return {
      ...common, ok: false,
      error: { kind: err.kind, message: err.message, ...(err.code ? { code: err.code } : {}) },
      ...(err.raw !== undefined ? { raw: err.raw } : {}),
      lastOkAt: base?.lastOkAt,
      nextTryAt: wait ? now + wait : t + pollMs,
      backoffMs: wait,
    };
  }

  private accept(f: SharedFile, own: boolean): void {
    this.dropFuture();
    this.maxSeq = Math.max(this.maxSeq, f.seq);
    if (f.t > this.now() + MIN) return;
    if (!this.state || later(f, this.state)) this.state = f;
    if (this.delivered && !later(f, this.delivered)) return;
    if (this.now() - f.t > MAX_AGE_MS) return;
    const r = reading(f);
    this.delivered = r;
    this.busy = false;
    for (const fn of [...this.fns]) {
      try { fn(r, own); } catch (e: any) { this.o.log('warn', `Reading handler failed: ${e?.message ?? e}`); }
    }
    if (!own && !this.inflight) this.schedule(); // wake when this reading goes stale, not at the old time
  }

  /** The clock was set back: a reading "from the future" would otherwise block every newer one. */
  private dropFuture(): void {
    const limit = this.now() + MIN;
    if (this.state && this.state.t > limit) this.state = undefined;
    if (this.delivered && this.delivered.t > limit) this.delivered = undefined;
  }

  /** A manual refresh while another window fetches: wait for its reading rather than fetch twice. */
  private async waitForOther(): Promise<void> {
    const seq = this.state?.seq;
    const lock = path.join(this.dir!, LOCK);
    for (let i = 0; i * 100 < this.timing.waitMs && !this.disposed; i++) {
      await sleep(100);
      await this.check();
      if (this.state?.seq !== seq || !fs.existsSync(lock)) return;
    }
  }

  // ───────────────────────────── files ─────────────────────────────

  private usable(dir?: string): string | undefined {
    if (!dir) return undefined;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
      return dir;
    } catch (e: any) {
      this.o.log('warn', `Can't use ${dir} (${e?.code ?? e?.message ?? e}); this window will poll on its own.`);
      return undefined;
    }
  }

  /** 'none': the lock can't be made at all; fetch unlocked this time, and go solo if it keeps failing. */
  private lock(): 'held' | 'busy' | 'none' {
    const file = path.join(this.dir!, LOCK);
    for (let retry = false; ; retry = true) {
      try {
        fs.writeFileSync(file, JSON.stringify({ id: this.id, pid: process.pid, t: this.now() }), { flag: 'wx' });
        this.held = true;
        this.lockFaults = 0;
        return 'held';
      } catch (e: any) {
        if (e?.code === 'ENOENT' && !retry) { // the folder was deleted under us
          try { fs.mkdirSync(this.dir!, { recursive: true }); continue; } catch (m) { return this.lockFault(m); }
        }
        if (e?.code !== 'EEXIST') return this.lockFault(e);
        if (retry) return 'busy';
        let mtime: number;
        try { mtime = fs.statSync(file).mtimeMs; } catch { continue; } // released meanwhile
        if (Math.abs(this.now() - mtime) <= this.timing.lockStaleMs) return 'busy';
        try { fs.unlinkSync(file); } catch (u: any) { if (u?.code !== 'ENOENT') return 'busy'; }
        this.o.log('info', 'Removed a fetch lock left by a window that stopped mid-fetch.');
      }
    }
  }

  private lockFault(e: any): 'none' {
    if (++this.lockFaults >= 3) this.goSolo(`can't create ${LOCK} (${e?.code ?? e?.message ?? e})`);
    return 'none';
  }

  private unlock(): void {
    if (!this.held || !this.dir) return;
    this.held = false;
    const file = path.join(this.dir, LOCK);
    // Only our own: if ours went stale and another window took over, its lock stays.
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).id === this.id) fs.unlinkSync(file); } catch { /* gone */ }
  }

  private goSolo(why: string): void {
    this.o.log('warn', `This window will poll on its own: ${why}.`);
    this.dir = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    clearInterval(this.statTimer);
  }

  private readSync(): SharedFile | undefined {
    try { return parse(fs.readFileSync(path.join(this.dir!, FILE), 'utf8')); } catch { return undefined; }
  }

  private async read(): Promise<SharedFile | undefined> {
    if (!this.dir) return undefined;
    const file = path.join(this.dir, FILE);
    for (let i = 0; ; i++) {
      try {
        return parse(await fs.promises.readFile(file, 'utf8'));
      } catch (e: any) {
        // Not written yet, mid-rename on Windows, or a torn read: try again shortly.
        if (i >= 2 || !(e instanceof SyntaxError || READ_RETRY.has(e?.code))) return undefined;
        await sleep(25);
      }
    }
  }

  private async check(): Promise<void> {
    const f = await this.read();
    if (f && !this.disposed) this.accept(f, false);
  }

  private async write(f: SharedFile): Promise<void> {
    const file = path.join(this.dir!, FILE), tmp = `${file}.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(f));
      for (let i = 0; ; i++) {
        try {
          await fs.promises.rename(tmp, file);
          return;
        } catch (e: any) {
          if (i >= 3 || !RENAME_RETRY.has(e?.code)) throw e;
          await sleep(this.timing.renameRetryMs);
        }
      }
    } catch (e: any) {
      this.o.log('warn', `Couldn't share the reading with other windows (${e?.code ?? e?.message ?? e}).`);
    }
  }

  private watch(): void {
    try {
      const w = fs.watch(this.dir!, { persistent: false }, (_ev, name) => {
        if (name && name !== FILE) return;
        clearTimeout(this.soon);
        this.soon = setTimeout(() => void this.check(), 20);
      });
      w.on('error', () => { w.close(); if (this.watcher === w) this.watcher = undefined; });
      this.watcher = w;
    } catch (e: any) {
      this.o.log('debug', `Not watching ${this.dir} (${e?.code ?? e}); checking every ${this.timing.statMs / 1000} s.`);
    }
  }

  /** Stat fallback: re-read only when usage.json changed. */
  private async poke(): Promise<void> {
    if (!this.dir) return;
    let sig: string;
    try {
      const s = await fs.promises.stat(path.join(this.dir, FILE));
      sig = `${s.mtimeMs}:${s.size}`;
    } catch { return; }
    if (sig === this.seen) return;
    this.seen = sig;
    await this.check();
  }
}
