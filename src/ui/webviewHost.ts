// Hosts the one webview app in two places: the dashboard editor tab and the
// "Claude Usage" view in the Explorer. Hidden webviews get no work; a newly
// shown one is painted at once from the latest model.

import * as vscode from 'vscode';
import { DetailVM, FromView, RunCommand, ThemeKind, ToView, ViewModel } from './types';
import { renderShell } from './webviewShell';

const PANEL_TYPE = 'tokenomancer.dashboard';
const VIEW_ID = 'tokenomancer.usage';
const COMMANDS: RunCommand[] = ['refresh', 'showDetails', 'copySummary', 'openSettings', 'resetCalibration',
  'previewSampleData', 'exitSampleData', 'showLog', 'openDashboard', 'setClaudeDir'];

interface Host { webview: vscode.Webview; visible: () => boolean; lastPost: number; pending?: NodeJS.Timeout; ready: boolean }

export class WebviewHosts implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private panelHost?: Host;
  private viewHost?: Host;
  private selected?: string;
  private latest?: { vm: ViewModel; theme: ThemeKind };
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly o: {
    detail: (key: string) => DetailVM | undefined;
    run: (cmd: RunCommand) => void;
    log: (msg: string) => void;
  }) {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(VIEW_ID, {
        resolveWebviewView: view => {
          this.viewHost = this.attach(view.webview, () => view.visible, 'view');
          view.onDidChangeVisibility(() => { if (view.visible) this.flush(this.viewHost); });
          view.onDidDispose(() => { this.viewHost = undefined; });
        },
      }),
      vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, {
        deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown) => {
          const sel = (state as { selected?: unknown } | undefined)?.selected;
          if (typeof sel === 'string') this.selected = sel;
          this.adopt(panel);
        },
      }),
    );
  }

  /** True while either host is on screen, so callers can skip building detail. */
  get visible(): boolean {
    return !!(this.panelHost?.visible() || this.viewHost?.visible());
  }

  openDashboard(key?: string) {
    if (key) this.selected = key;
    if (this.panel) {
      this.panel.reveal(undefined, false);
      if (key) this.send(this.panelHost, { type: 'select', key });
      return;
    }
    // Don't cover another extension's webview (usually the Claude Code chat): open beside it.
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const besideChat = active instanceof vscode.TabInputWebview && !active.viewType.endsWith(PANEL_TYPE);
    const panel = vscode.window.createWebviewPanel(PANEL_TYPE, 'Claude Usage',
      { viewColumn: besideChat ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, preserveFocus: besideChat },
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] });
    this.adopt(panel);
  }

  private adopt(panel: vscode.WebviewPanel) {
    this.panel = panel;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'panel-light.svg'),
      dark: vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'panel-dark.svg'),
    };
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] };
    this.panelHost = this.attach(panel.webview, () => panel.visible, 'panel');
    panel.onDidChangeViewState(() => { if (panel.visible) this.flush(this.panelHost); });
    panel.onDidDispose(() => { this.panel = undefined; this.panelHost = undefined; });
  }

  private attach(webview: vscode.Webview, visible: () => boolean, surface: 'panel' | 'view'): Host {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f)).toString();
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] };
    webview.html = renderShell({ cspSource: webview.cspSource, nonce: nonce(), scriptUri: media('view.js'), styleUri: media('view.css'), surface });
    const host: Host = { webview, visible, lastPost: 0, ready: false };
    this.disposables.push(webview.onDidReceiveMessage((m: unknown) => this.receive(host, m)));
    return host;
  }

  private receive(host: Host, m: unknown) {
    const msg = m as FromView;
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
    switch (msg.type) {
      case 'ready': host.ready = true; this.flush(host); break;
      case 'select':
        if (typeof msg.key === 'string' && msg.key.length < 64) { this.selected = msg.key; this.flush(host); }
        break;
      case 'run':
        if (COMMANDS.includes(msg.command)) this.o.run(msg.command);
        break;
      case 'error':
        this.o.log(`Webview: ${String(msg.message).slice(0, 300)}`);
        break;
    }
  }

  /** New model: post to visible, ready hosts, at most once a second each. */
  update(vm: ViewModel, theme: ThemeKind) {
    this.latest = { vm, theme };
    for (const h of [this.panelHost, this.viewHost]) {
      if (!h || !h.ready || !h.visible()) continue;
      const wait = 1000 - (Date.now() - h.lastPost);
      if (wait <= 0) this.flush(h);
      else if (!h.pending) h.pending = setTimeout(() => { h.pending = undefined; this.flush(h); }, wait);
    }
  }

  busy(value: boolean) {
    for (const h of [this.panelHost, this.viewHost]) if (h?.ready) this.send(h, { type: 'busy', value });
  }

  private flush(h: Host | undefined) {
    if (!h || !h.ready || !this.latest || !h.visible()) return;
    const { vm, theme } = this.latest;
    const keys = vm.buckets.map(b => b.key);
    const key = this.selected && keys.includes(this.selected) ? this.selected : vm.bindingKey ?? keys[0];
    const detail = key ? this.o.detail(key) : undefined;
    h.lastPost = Date.now();
    this.send(h, { type: 'model', vm, detail, theme });
  }

  private send(h: Host | undefined, m: ToView) {
    if (h) void h.webview.postMessage(m);
  }

  dispose() {
    for (const h of [this.panelHost, this.viewHost]) if (h?.pending) clearTimeout(h.pending);
    this.panel?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

function nonce(): string {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += a.charAt(Math.floor(Math.random() * a.length));
  return s;
}
