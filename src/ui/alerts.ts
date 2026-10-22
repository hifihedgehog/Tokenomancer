// Run-out alerts: at most one per limit per window, across every window and
// restart (a marker file per alert id in the shared folder), only in the
// focused window, and never in sample mode.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ViewModel } from './types';
import { AlertPolicy } from './alertPolicy';
import { Config } from '../config';

export class Alerts {
  private policy = new AlertPolicy();
  private readonly activatedAt = Date.now();
  private showing = false;

  constructor(private readonly dir: string | undefined, private readonly openDashboard: (key: string) => void) {
    if (dir) {
      try { fs.mkdirSync(dir, { recursive: true }); this.prune(); } catch { /* alerts still work, just not deduplicated across windows */ }
    }
  }

  check(vm: ViewModel, cfg: Config) {
    if (vm.sample || cfg.alerts.mode === 'off' || this.showing) return;
    const due = this.policy.decide(vm, { mode: cfg.alerts.mode, leadMinutes: cfg.alerts.leadMinutes, focused: vscode.window.state.focused, activatedAt: this.activatedAt });
    for (const a of due) {
      if (!this.claim(a.id)) continue;
      this.showing = true;
      void vscode.window.showWarningMessage(a.message, 'Open Dashboard', "Don't Show Again").then(async pick => {
        this.showing = false;
        if (pick === 'Open Dashboard') this.openDashboard(a.key);
        else if (pick === "Don't Show Again") {
          await vscode.workspace.getConfiguration('tokenomancer').update('alerts.mode', 'off', vscode.ConfigurationTarget.Global);
        }
      });
      return; // one at a time
    }
  }

  /** Creates the marker file; false if another window (or an earlier session) already showed this alert. */
  private claim(id: string): boolean {
    if (!this.dir) return true;
    try {
      fs.writeFileSync(path.join(this.dir, `${id.replace(/[^A-Za-z0-9_@.:-]/g, '_').replace(/:/g, '-')}.fired`), String(Date.now()), { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  }

  private prune() {
    const cutoff = Date.now() - 8 * 24 * 3600_000;
    for (const f of fs.readdirSync(this.dir!)) {
      const p = path.join(this.dir!, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
}
