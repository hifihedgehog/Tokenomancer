import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LogTailer } from './logReader';
import { Ledger } from './ledger';
import { BucketEstimator, BucketPersist, Estimate, Reading, Rounding, windowLengthMs } from './estimator';
import { UsageError, claudeDir, fetchUsage } from './usageApi';
import { Price } from './pricing';
import { fmtK, fmtMin, fmtPct, fmtSigma, fmtTime, label } from './format';
import { DemoSource } from './demo';

const HORIZON_MS = 8 * 24 * 3600_000; // weekly window plus a margin
const STATE_KEY = 'tokenomancer.buckets.v2';

interface Cfg {
  dir: string;
  pollMs: number;
  buckets: string[];
  rounding: Rounding;
  decimals: number;
  overrides: Record<string, Partial<Price>>;
}

function cfg(): Cfg {
  const c = vscode.workspace.getConfiguration('tokenomancer');
  return {
    dir: claudeDir(c.get<string>('claudeDir')),
    pollMs: Math.max(30, c.get<number>('pollSeconds', 60)) * 1000,
    buckets: c.get<string[]>('statusBarBuckets', []),
    rounding: c.get<Rounding>('officialRounding', 'floor'),
    decimals: Math.min(3, Math.max(0, c.get<number>('decimals', 2))),
    overrides: c.get<Record<string, Partial<Price>>>('priceOverrides', {}),
  };
}

const KIND_TEXT: Record<Estimate['kind'], string> = {
  official: 'official only (calibrating — needs a 1-point change while VS Code is open)',
  precise: 'endpoint returned decimals',
  anchored: 'pinned between recent ticks',
  'window-start': 'counted from window start (tightens at the next tick)',
  'lower-bound': 'usage elsewhere moved the number; loosely bounded until the next tick',
};

class Lens implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private out = vscode.window.createOutputChannel('Tokenomancer');
  private ledger = new Ledger();
  private tailer: LogTailer;
  private estimators = new Map<string, BucketEstimator>();
  private official = new Map<string, Reading>();
  private lastRaw?: unknown;
  private lastPollOk?: number;
  private lastError?: UsageError;
  private pollTimer?: NodeJS.Timeout;
  private scanTimer?: NodeJS.Timeout;
  private uiTimer?: NodeJS.Timeout;
  private watcher?: fs.FSWatcher;
  private debounce?: NodeJS.Timeout;
  private backoffMs = 0;
  private c = cfg();
  private disposables: vscode.Disposable[] = [];
  private demo = process.env.TOKENOMANCER_DEMO === '1' ? new DemoSource() : undefined;

  constructor(private ctx: vscode.ExtensionContext) {
    this.tailer = new LogTailer(() => path.join(this.c.dir, 'projects'), HORIZON_MS, () => this.c.overrides);
    if (this.demo) this.demo.bootstrap(this.ledger, this.estimators);
    else {
      const saved = ctx.globalState.get<Record<string, BucketPersist>>(STATE_KEY, {});
      for (const [k, v] of Object.entries(saved)) this.estimators.set(k, new BucketEstimator(k, v));
    }

    this.item.command = 'tokenomancer.showDetails';
    this.item.text = '$(pulse) Claude usage…';
    this.item.show();

    this.disposables.push(
      vscode.commands.registerCommand('tokenomancer.refresh', () => this.poll(true)),
      vscode.commands.registerCommand('tokenomancer.showDetails', () => this.showDetails()),
      vscode.commands.registerCommand('tokenomancer.resetCalibration', () => this.resetCalibration()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('tokenomancer')) { this.c = cfg(); this.restartWatch(); this.schedulePoll(0); this.render(); }
      }),
    );

    this.scan();
    this.restartWatch();
    this.scanTimer = setInterval(() => this.scan(), 5000); // fallback if file events are missed
    this.uiTimer = setInterval(() => this.render(), 15_000); // keep pace/ETA fresh while idle
    this.schedulePoll(0);
  }

  private log(msg: string) { this.out.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`); }

  private restartWatch() {
    this.watcher?.close();
    this.watcher = undefined;
    const dir = path.join(this.c.dir, 'projects');
    try {
      this.watcher = fs.watch(dir, { recursive: true }, (_ev, file) => {
        if (file && !String(file).endsWith('.jsonl')) return;
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.scan(), 250);
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
    } catch (e: any) {
      this.log(`Not watching ${dir} (${e?.message ?? e}); using 5-second polling instead.`);
    }
  }

  private scan() {
    try {
      const evs = this.demo ? this.demo.scan() : this.tailer.scan();
      if (evs.length) {
        this.ledger.add(evs);
        this.ledger.prune(Date.now() - HORIZON_MS);
        this.render();
      }
    } catch (e: any) {
      this.log(`Log scan failed: ${e?.message ?? e}`);
    }
  }

  private schedulePoll(delay: number) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.poll(false), delay);
  }

  private async poll(manual: boolean) {
    clearTimeout(this.pollTimer);
    this.scan(); // ledger must be current before ticks are timed
    try {
      // A reading describes the moment the server counted, so stamp it when the request is sent.
      const now = Date.now();
      const res = this.demo ? await this.demo.fetch(now) : await fetchUsage(this.c.dir);
      this.official = res.buckets;
      this.lastRaw = res.raw;
      for (const [k, r] of res.buckets) {
        if (windowLengthMs(k) === undefined) continue; // e.g. extra-usage credit, shown as-is
        let est = this.estimators.get(k);
        if (!est) { est = new BucketEstimator(k); this.estimators.set(k, est); }
        const before = est.sampleCount;
        est.onReading(r, now, this.ledger, this.c.rounding);
        const after = est.sampleCount;
        if (after !== before) this.log(`${label(k)}: tick to ${r.utilization}%, 1% ≈ $${est.wuPerPct?.toFixed(3)} (n=${after})`);
      }
      this.persist();
      this.lastPollOk = now;
      this.lastError = undefined;
      this.backoffMs = 0;
      if (manual) vscode.window.setStatusBarMessage('Claude usage refreshed', 2000);
    } catch (e: any) {
      const err = e instanceof UsageError ? e : new UsageError(String(e?.message ?? e), 'network');
      if (this.lastError?.message !== err.message) this.log(err.message);
      if (err.raw !== undefined) this.lastRaw = err.raw;
      this.lastError = err;
      if (err.kind === 'rate-limited') this.backoffMs = err.retryAfterMs ?? Math.min(10 * 60_000, Math.max(2 * this.c.pollMs, this.backoffMs * 2));
      else if (err.kind === 'network') this.backoffMs = Math.min(5 * 60_000, Math.max(this.c.pollMs, this.backoffMs * 2));
      if (manual) vscode.window.showWarningMessage(`Tokenomancer: ${err.message}`);
    }
    this.render();
    this.schedulePoll(Math.max(this.c.pollMs, this.backoffMs));
  }

  private persist() {
    if (this.demo) return; // sample data must never overwrite real calibration
    const obj: Record<string, BucketPersist> = {};
    for (const [k, e] of this.estimators) obj[k] = e.toJSON();
    void this.ctx.globalState.update(STATE_KEY, obj);
  }

  private estimates(now: number): Estimate[] {
    const list: Estimate[] = [];
    for (const k of this.official.keys()) {
      const est = this.estimators.get(k);
      if (est) list.push(est.estimate(now, this.ledger, this.c.rounding));
    }
    return list;
  }

  private shownKeys(all: string[]): string[] {
    if (this.c.buckets.length) return this.c.buckets.filter(k => all.includes(k));
    return all.filter(k => k === 'five_hour' || k === 'seven_day' || /fable/i.test(k));
  }

  private render() {
    const now = Date.now();
    const ests = this.estimates(now);
    const byKey = new Map(ests.map(e => [e.key, e]));
    const shown = this.shownKeys(ests.map(e => e.key)).map(k => byKey.get(k)!).filter(Boolean);

    if (!shown.length) {
      this.item.text = this.lastError ? '$(warning) Claude usage' : '$(pulse) Claude usage…';
    } else {
      const parts = shown.map(e => `${label(e.key)} ${fmtPct(e, this.c.decimals)}`);
      const stale = this.lastError ? ' $(warning)' : '';
      this.item.text = `$(pulse) ${parts.join(' · ')}${stale}`;
    }
    const worst = Math.max(0, ...shown.map(e => e.value));
    this.item.backgroundColor = worst >= 95
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : worst >= 80 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.tooltip = this.tooltip(ests, now);
  }

  private tooltip(ests: Estimate[], now: number): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.appendMarkdown('**Tokenomancer**\n\n');
    if (this.lastError) md.appendMarkdown(`$(warning) ${this.lastError.message}\n\n`);

    if (ests.length) {
      md.appendMarkdown('| Limit | Estimate | Official | 1% ≈ | Pace | Next 1% | 100% in | Resets |\n|---|---|---|---|---|---|---|---|\n');
      for (const e of ests) {
        const pace = e.ratePctPerHour !== undefined ? `${e.ratePctPerHour.toFixed(2)}%/h` : '—';
        const wpp = e.wuPerPct ? `$${e.wuPerPct.toFixed(2)}` : '—';
        md.appendMarkdown(`| ${label(e.key)} | ${fmtPct(e, this.c.decimals)}${e.sigma !== undefined ? ` ${fmtSigma(e.sigma, this.c.decimals)}` : ''} | ${e.official}% | ${wpp} | ${pace} | ${fmtMin(e.minutesToNextPct)} | ${fmtMin(e.minutesTo100)} | ${fmtTime(e.resetsAt)} |\n`);
      }
      md.appendMarkdown('\n');
    }
    for (const [k, r] of this.official) {
      if (windowLengthMs(k) === undefined) md.appendMarkdown(`${label(k)}: ${r.utilization}%  \n`);
    }

    const five = ests.find(e => e.key === 'five_hour');
    const from = five?.windowStart ?? now - 5 * 3600_000;
    const t = this.ledger.tokens(from, now);
    const wu = this.ledger.wu(from, now);
    md.appendMarkdown(`\n**This 5-hour window, this computer** (${t.requests} requests, $${wu.toFixed(2)} API-equivalent)  \n`);
    md.appendMarkdown(`in ${fmtK(t.input)} · out ${fmtK(t.output)} · cache write ${fmtK(t.cacheWrite5m + t.cacheWrite1h)} · cache read ${fmtK(t.cacheRead)}  \n`);
    const fam = [...this.ledger.byFamily(from, now)].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    if (fam.length && wu > 0) md.appendMarkdown(`by model: ${fam.map(([f, v]) => `${f} ${Math.round((v / wu) * 100)}%`).join(' · ')}  \n`);

    md.appendMarkdown('\n');
    for (const e of ests) md.appendMarkdown(`${label(e.key)}: ${KIND_TEXT[e.kind]}${e.samples ? `, ${e.samples} samples${e.spread !== undefined ? `, model error ±${Math.round(e.spread * 100)}% per point` : ''}` : ''}  \n`);
    const last = this.ledger.lastEventTime();
    md.appendMarkdown(`\nLast request seen: ${last ? fmtMin((now - last) / 60_000) + ' ago' : 'none yet'} · last official reading: ${this.lastPollOk ? fmtMin((now - this.lastPollOk) / 60_000) + ' ago' : 'none yet'}  \n`);
    md.appendMarkdown('_Click for the full report._');
    return md;
  }

  private showDetails() {
    const now = Date.now();
    this.out.appendLine('');
    this.out.appendLine(`===== Report ${new Date().toLocaleString()} =====`);
    for (const e of this.estimates(now)) {
      this.out.appendLine(`${label(e.key).padEnd(10)} est ${fmtPct(e, 3).padEnd(9)}${e.sigma !== undefined ? ` ±${e.sigma.toFixed(3)}` : ''}  official ${e.official}%  [${KIND_TEXT[e.kind]}]`);
      const est = this.estimators.get(e.key);
      const feats = est ? est.features().map(([k, g]) => `${k} ×${g.toFixed(2)}`).join(', ') : '';
      if (feats) this.out.appendLine(`           learned weight corrections vs API prices: ${feats}`);
      this.out.appendLine(`           1% ≈ ${e.wuPerPct ? '$' + e.wuPerPct.toFixed(3) : 'n/a'} (${e.samples} samples${e.spread !== undefined ? `, spread ±${Math.round(e.spread * 100)}%` : ''}), pace ${e.ratePctPerHour?.toFixed(2) ?? '—'}%/h, next 1% in ${fmtMin(e.minutesToNextPct)}, 100% in ${fmtMin(e.minutesTo100)}, resets ${fmtTime(e.resetsAt)}`);
    }
    for (const [k, r] of this.official) if (windowLengthMs(k) === undefined) this.out.appendLine(`${label(k).padEnd(10)} official ${r.utilization}%`);
    this.out.appendLine(`Buckets returned by the endpoint: ${[...this.official.keys()].join(', ') || 'none yet'}`);
    // Undocumented endpoint: show it verbatim so null or unrecognized buckets are visible too.
    if (this.lastRaw !== undefined) this.out.appendLine(`Raw endpoint response:\n${JSON.stringify(this.lastRaw, null, 2)}`);
    this.out.appendLine(`Log events in memory: ${this.ledger.size} (folder: ${path.join(this.c.dir, 'projects')})`);
    this.out.show(true);
  }

  private async resetCalibration() {
    const ok = await vscode.window.showWarningMessage('Forget all learned calibration samples?', { modal: true }, 'Reset');
    if (ok !== 'Reset') return;
    for (const e of this.estimators.values()) e.resetCalibration();
    this.persist();
    this.render();
  }

  dispose() {
    clearTimeout(this.pollTimer);
    clearInterval(this.scanTimer);
    clearInterval(this.uiTimer);
    clearTimeout(this.debounce);
    this.watcher?.close();
    this.persist();
    this.disposables.forEach(d => d.dispose());
    this.item.dispose();
    this.out.dispose();
  }
}

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(new Lens(ctx));
}

export function deactivate() { /* disposed via subscriptions */ }
