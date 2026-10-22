// The status bar item and its hover. Everything shown comes from the
// ViewModel; this file only owns the VS Code objects and avoids redundant
// assignments (an open hover is replaced in place whenever its markdown changes).

import * as vscode from 'vscode';
import { ThemeKind, ViewModel } from './types';
import { statusText } from './statusText';
import { HOVER_COMMANDS, hoverMarkdown } from './hoverMarkdown';
import { Palette } from './hoverArt';

export function themeKind(): ThemeKind {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light: return 'light';
    case vscode.ColorThemeKind.HighContrast: return 'hc-dark';
    case vscode.ColorThemeKind.HighContrastLight: return 'hc-light';
    default: return 'dark';
  }
}

/** Hex overrides for our contributed colours from workbench.colorCustomizations, so the hover art follows them. */
export function colorOverrides(): Partial<Palette> {
  const all = vscode.workspace.getConfiguration('workbench').get<Record<string, unknown>>('colorCustomizations') ?? {};
  const themeName = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
  const scoped = themeName ? (all[`[${themeName}]`] as Record<string, unknown> | undefined) ?? {} : {};
  const pick = (id: string) => {
    const v = scoped[id] ?? all[id];
    return typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : undefined;
  };
  const o: Partial<Palette> = {};
  const accent = pick('tokenomancer.accent'), warn = pick('tokenomancer.warning'), crit = pick('tokenomancer.critical');
  if (accent) o.accent = accent;
  if (warn) o.warn = warn;
  if (crit) o.crit = crit;
  return o;
}

export class StatusBar implements vscode.Disposable {
  private item!: vscode.StatusBarItem;
  private last = { text: '', a11y: '', bg: '', md: '', cmd: '' };

  constructor(private alignment: 'left' | 'right', private priority: number) { this.create(); }

  private create() {
    this.item?.dispose();
    this.item = vscode.window.createStatusBarItem('tokenomancer.usage',
      this.alignment === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right, this.priority);
    this.item.name = 'Tokenomancer — Claude usage';
    this.item.text = '$(tokenomancer-empty) Claude usage';
    this.last = { text: '', a11y: '', bg: '', md: '', cmd: '' };
    this.item.show();
  }

  /** Alignment and priority are fixed at creation, so changing either re-creates the item. */
  place(alignment: 'left' | 'right', priority: number) {
    if (alignment === this.alignment && priority === this.priority) return;
    this.alignment = alignment;
    this.priority = priority;
    this.create();
  }

  update(vm: ViewModel, theme: ThemeKind, overrides: Partial<Palette>, command: string) {
    const s = statusText(vm);
    if (s.text !== this.last.text) { this.item.text = s.text; this.last.text = s.text; }
    if (s.a11y !== this.last.a11y) { this.item.accessibilityInformation = { label: s.a11y, role: 'button' }; this.last.a11y = s.a11y; }
    const bg = s.background ?? '';
    if (bg !== this.last.bg) {
      this.item.backgroundColor = bg ? new vscode.ThemeColor(`statusBarItem.${bg}Background`) : undefined;
      this.last.bg = bg;
    }
    if (command !== this.last.cmd) { this.item.command = command; this.last.cmd = command; }
    const md = hoverMarkdown(vm, theme, overrides);
    if (md !== this.last.md) {
      const m = new vscode.MarkdownString(md, true);
      m.supportHtml = true;
      m.isTrusted = { enabledCommands: HOVER_COMMANDS };
      this.item.tooltip = m;
      this.last.md = md;
    }
  }

  dispose() { this.item.dispose(); }
}
