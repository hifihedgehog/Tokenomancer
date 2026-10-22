import * as vscode from 'vscode';
import * as path from 'path';
import { LogTailer } from './logReader';
import { BucketPersist } from './estimator';
import { fetchUsage } from './usageApi';
import { Config, changeKind, normalizeConfig } from './config';
import { SharedPoller, SharedReading } from './poller';
import { HORIZON_MS, Model, ModelState, Reading } from './model';
import { DemoSource, demoNow } from './demo';
import { StatusBar, colorOverrides, themeKind } from './ui/statusBar';
import { WebviewHosts } from './ui/webviewHost';
import { ReportProvider } from './ui/report';
import { reportMarkdown } from './ui/reportText';
import { summaryText } from './ui/summaryText';
import { Alerts } from './ui/alerts';
import { showGlance } from './ui/glance';
import { LogWatcher } from './watch';
import { FreshInput, RunCommand, UsageErrorKind, ViewModel } from './ui/types';

const STATE_KEY = 'tokenomancer.model.v3';
const LEGACY_KEY = 'tokenomancer.buckets.v2'; // 0.1 calibration, carried over

function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('tokenomancer');
  return normalizeConfig(k => c.get(k), k => {
    const i = c.inspect(k);
    return !!i && [i.globalValue, i.workspaceValue, i.workspaceFolderValue].some(v => v !== undefined);
  }, process.env);
}

interface Sample { model: Model; timer: NodeJS.Timeout; demo: DemoSource; clock: () => number; lastOkAt?: number }

class Tokenomancer implements vscode.Disposable {
  private cfg = readConfig();
  private readonly log = vscode.window.createOutputChannel('Tokenomancer', { log: true });
  private readonly shared: string;
  private readonly real: Model;
  private readonly poller: SharedPoller;
  private readonly statusBar: StatusBar;
  private readonly hosts: WebviewHosts;
  private readonly report: ReportProvider;
  private readonly alerts: Alerts;
  private watcher?: LogWatcher;
  private sample?: Sample;
  private vm?: ViewModel;
  private fresh: { lastOkAt?: number; error?: FreshInput['error']; nextTryAt?: number; own: boolean } = { own: false };
  private lastRaw?: unknown;
  private keys: Record<string, unknown> = {};
  private renderTimer?: NodeJS.Timeout;
  private lastRender = 0;
  private timers: NodeJS.Timeout[] = [];
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.shared = path.join(ctx.globalStorageUri.fsPath, 'shared');
    const tailer = new LogTailer(() => path.join(this.cfg.dir, 'projects'), HORIZON_MS, () => this.cfg.overrides, { log: m => this.log.warn(m) });
    this.real = new Model({ tailer, clock: Date.now, sample: false });
    this.restore();

    this.poller = new SharedPoller({
      dir: this.shared,
      fetch: () => fetchUsage(this.cfg.dir),
      pollMs: () => this.cfg.pollMs,
      log: (level, msg) => this.log[level](msg),
    });
    this.statusBar = new StatusBar(this.cfg.alignment, this.cfg.priority);
    this.hosts = new WebviewHosts(ctx, {
      detail: key => this.active.detail(key, this.ui, this.polls()),
      run: c => this.run(c),
      log: m => this.log.warn(m),
    });
    this.report = new ReportProvider(() => this.reportText());
    this.alerts = new Alerts(path.join(this.shared, 'alerts'), key => this.hosts.openDashboard(key));

    const cmd = (id: string, fn: (...a: any[]) => unknown) => vscode.commands.registerCommand(`tokenomancer.${id}`, fn);
    this.disposables.push(
      this.log, this.statusBar, this.hosts, this.report,
      this.poller.onReading((r, own) => this.onReading(r, own)),
      cmd('openDashboard', (key?: unknown) => this.hosts.openDashboard(typeof key === 'string' ? key : undefined)),
      cmd('glance', () => this.vm && showGlance(this.vm, { openDashboard: k => this.hosts.openDashboard(k), run: c => this.run(c) })),
      cmd('refresh', () => this.refresh()),
      cmd('showDetails', () => this.report.open()),
      cmd('copySummary', () => this.copySummary()),
      cmd('showLog', () => this.log.show(true)),
      cmd('openSettings', (q?: unknown) => vscode.commands.executeCommand('workbench.action.openSettings', typeof q === 'string' ? q : `@ext:${ctx.extension.id}`)),
      cmd('previewSampleData', () => this.enterSample()),
      cmd('exitSampleData', () => this.exitSample()),
      cmd('resetCalibration', () => this.resetCalibration()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('tokenomancer')) this.onConfig();
        else if (e.affectsConfiguration('workbench.colorCustomizations') || e.affectsConfiguration('workbench.colorTheme')) this.requestRender(true);
      }),
      vscode.window.onDidChangeActiveColorTheme(() => this.requestRender(true)),
      vscode.window.onDidChangeWindowState(s => { if (s.focused) this.requestRender(true); }),
    );

    this.restartWatcher();
    this.timers.push(setInterval(() => this.onLogs(), 5000)); // catches anything the watcher misses
    this.timers.push(setInterval(() => {
      // Keep ages and pace current; slower when the window is in the background.
      if (vscode.window.state.focused || Date.now() - this.lastRender > 60_000) this.requestRender(false);
    }, 15_000));

    this.real.scan();
    this.render();
    this.poller.start();
    if (process.env.TOKENOMANCER_DEMO === '1') this.enterSample();
  }

  private get active(): Model { return this.sample?.model ?? this.real; }

  /** The config the active model renders with: the sample scenario's readings are floored. */
  private get ui(): Config { return this.sample ? { ...this.cfg, rounding: 'floor' } : this.cfg; }

  // ── state ──

  private restore() {
    const saved = this.ctx.globalState.get<ModelState>(STATE_KEY);
    if (saved) { this.real.restore(saved); return; }
    const legacy = this.ctx.globalState.get<Record<string, BucketPersist>>(LEGACY_KEY);
    if (legacy) this.real.restore({ buckets: legacy });
  }

  private persist() {
    void this.ctx.globalState.update(STATE_KEY, this.real.state());
  }

  // ── inputs ──

  private onLogs() {
    try {
      if (this.active.scan()) this.requestRender(false);
    } catch (e: any) {
      this.log.error(`Log scan failed: ${e?.message ?? e}`);
    }
  }

  private onReading(r: SharedReading, own: boolean) {
    if (r.ok && r.buckets) {
      try { this.real.scan(); } catch (e: any) { this.log.error(`Log scan failed: ${e?.message ?? e}`); }
      const before = new Map([...this.real.estimators].map(([k, e]) => [k, e.sampleCount]));
      this.real.apply({ t: r.t, buckets: r.buckets }, this.cfg.rounding);
      for (const [k, est] of this.real.estimators) {
        if (est.sampleCount !== before.get(k)) this.log.info(`${k}: tick to ${r.buckets[k]?.utilization}%, 1% ≈ $${est.wuPerPct?.toFixed(3)} (${est.sampleCount} samples)`);
      }
      this.lastRaw = r.raw;
      this.persist();
    }
    this.fresh = { lastOkAt: r.lastOkAt ?? (r.ok ? r.t : this.fresh.lastOkAt), error: r.ok ? undefined : r.error, nextTryAt: r.nextTryAt, own };
    if (r.error && !r.ok) this.log.warn(r.error.message);
    this.hosts.busy(false);
    this.requestRender(true);
  }

  private freshInput(): FreshInput {
    if (this.sample) return { lastOkAt: this.sample.lastOkAt, refreshing: false, role: 'solo', claudeDir: this.cfg.dir };
    return {
      lastOkAt: this.fresh.lastOkAt, error: this.fresh.error, nextTryAt: this.fresh.nextTryAt,
      refreshing: this.poller.refreshing, role: this.fresh.own ? 'fetcher' : 'shared', claudeDir: this.cfg.dir,
    };
  }

  private polls() {
    return this.sample ? this.sample.demo.pollLog : this.poller.pollLog;
  }

  private onConfig() {
    const next = readConfig();
    const ck = changeKind(this.cfg, next);
    const dirChanged = next.dir !== this.cfg.dir;
    this.cfg = next;
    if (ck.recreate) this.statusBar.place(next.alignment, next.priority);
    if (dirChanged) this.restartWatcher();
    if (ck.poll && !this.sample) void this.poller.refresh(false);
    this.requestRender(true);
  }

  private restartWatcher() {
    this.watcher?.dispose();
    this.watcher = new LogWatcher(path.join(this.cfg.dir, 'projects'), () => this.onLogs(), m => this.log.info(m));
  }

  // ── output ──

  /** Renders soon: urgent changes at once, routine ones no more than every max(2 s, 20× the last estimate cost). */
  private requestRender(urgent: boolean) {
    const gap = Math.max(2000, 20 * this.active.lastEstimateMs);
    const due = this.lastRender + gap - Date.now();
    if (urgent || due <= 0) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
      this.render();
    } else if (!this.renderTimer) {
      this.renderTimer = setTimeout(() => { this.renderTimer = undefined; this.render(); }, due);
    }
  }

  private render() {
    this.lastRender = Date.now();
    let vm: ViewModel;
    try {
      vm = this.active.viewModel(this.ui, this.freshInput());
    } catch (e: any) {
      this.log.error(`Render failed: ${e?.stack ?? e}`);
      return;
    }
    this.vm = vm;
    const theme = themeKind();
    this.statusBar.update(vm, theme, colorOverrides(), this.clickCommand());
    this.hosts.update(vm, theme);
    this.alerts.check(vm, this.cfg);
    this.setContext('tokenomancer.sample', !!this.sample);
    this.setContext('tokenomancer.signedIn', this.fresh.error?.kind !== 'no-credentials');
    this.setContext('tokenomancer.calibrated', vm.buckets.some(b => b.calib.samples > 0));
  }

  private setContext(key: string, value: unknown) {
    if (this.keys[key] === value) return;
    this.keys[key] = value;
    void vscode.commands.executeCommand('setContext', key, value);
  }

  private clickCommand(): string {
    switch (this.cfg.clickAction) {
      case 'glance': return 'tokenomancer.glance';
      case 'report': return 'tokenomancer.showDetails';
      case 'refresh': return 'tokenomancer.refresh';
      default: return 'tokenomancer.openDashboard';
    }
  }

  private reportText(): string {
    const m = this.active;
    return reportMarkdown({
      vm: this.vm ?? m.viewModel(this.ui, this.freshInput()),
      buckets: m.diagnostics(this.ui.rounding),
      raw: this.sample ? undefined : this.lastRaw,
      events: m.ledger.size,
      oldestEvent: m.ledger.firstEventTime(),
      logDir: path.join(this.cfg.dir, 'projects'),
      pollLog: this.polls(),
      pollMs: this.cfg.pollMs,
      role: this.sample ? 'solo' : this.fresh.own ? 'fetcher' : 'shared',
      version: this.ctx.extension.packageJSON.version,
    });
  }

  // ── commands ──

  private run(c: RunCommand) {
    const map: Record<RunCommand, string> = {
      refresh: 'tokenomancer.refresh', showDetails: 'tokenomancer.showDetails', copySummary: 'tokenomancer.copySummary',
      openSettings: 'tokenomancer.openSettings', resetCalibration: 'tokenomancer.resetCalibration',
      previewSampleData: 'tokenomancer.previewSampleData', exitSampleData: 'tokenomancer.exitSampleData',
      showLog: 'tokenomancer.showLog', openDashboard: 'tokenomancer.openDashboard', setClaudeDir: 'tokenomancer.openSettings',
    };
    void vscode.commands.executeCommand(map[c], c === 'setClaudeDir' ? 'tokenomancer.claudeDir' : undefined);
  }

  private async refresh() {
    if (this.sample) { await this.sampleTick(); return; }
    this.hosts.busy(true);
    this.requestRender(true);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Reading Claude usage' }, () => this.poller.refresh(true));
    this.hosts.busy(false);
    const err = this.fresh.error;
    if (err) {
      const kinds: UsageErrorKind[] = ['expired'];
      if (!kinds.includes(err.kind)) {
        void vscode.window.showWarningMessage(`Tokenomancer: ${err.message}`, 'Show Log').then(p => { if (p) this.log.show(true); });
      }
    }
    this.requestRender(true);
  }

  private async copySummary() {
    if (!this.vm) return;
    await vscode.env.clipboard.writeText(summaryText(this.vm));
    vscode.window.setStatusBarMessage('$(check) Claude usage summary copied', 2500);
  }

  private async resetCalibration() {
    const ok = await vscode.window.showWarningMessage('Forget all learned calibration samples?', { modal: true }, 'Reset');
    if (ok !== 'Reset') return;
    this.real.resetCalibration();
    this.persist();
    this.requestRender(true);
  }

  // ── sample data ──

  private enterSample() {
    if (this.sample) return;
    const offset = demoNow() - Date.now();
    const clock = () => Date.now() + offset;
    const now0 = clock();
    const demo = new DemoSource(now0);
    const model = new Model({ events: () => demo.scan(clock()), clock, sample: true });
    // Replay the scenario's readings, recording estimates for the last few hours so the
    // "between the whole numbers" chart has history to draw.
    demo.bootstrap(model.ledger, model.estimators, (t, buckets) => {
      if (t < now0 - 6 * 3600_000) return;
      for (const k of Object.keys(buckets)) {
        const est = model.estimators.get(k);
        if (est) model.history.record(k, t, est.estimate(t, model.ledger, 'floor'), true);
      }
    });
    const s: Sample = { model, demo, clock, timer: setInterval(() => void this.sampleTick(), this.cfg.pollMs) };
    this.sample = s;
    void this.sampleTick().then(() => this.hosts.openDashboard());
  }

  private async sampleTick() {
    const s = this.sample;
    if (!s) return;
    const now = s.clock();
    const res = await s.demo.fetch(now);
    s.model.scan();
    const reading: Reading = { t: now, buckets: {} };
    for (const [k, r] of res.buckets) reading.buckets[k] = { utilization: r.utilization, resets_at: r.resetsAt ?? null };
    s.model.apply(reading, 'floor'); // the scenario's readings are floored
    s.lastOkAt = now;
    this.requestRender(true);
  }

  private exitSample() {
    if (!this.sample) return;
    clearInterval(this.sample.timer);
    this.sample = undefined;
    this.requestRender(true);
  }

  dispose() {
    this.timers.forEach(clearInterval);
    clearTimeout(this.renderTimer);
    if (this.sample) clearInterval(this.sample.timer);
    this.watcher?.dispose();
    this.poller.dispose();
    this.persist();
    this.disposables.forEach(d => d.dispose());
  }
}

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(new Tokenomancer(ctx));
}

export function deactivate() { /* disposed via subscriptions */ }
